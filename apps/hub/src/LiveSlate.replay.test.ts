import { join } from "node:path"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId } from "@sportal/domain/Game"
import type { GameEvent } from "@sportal/domain/GameEvent"
import { LiveGame, LiveGameState } from "@sportal/domain/LiveGame"
import { PlayId } from "@sportal/domain/Play"
import type { Slate } from "@sportal/domain/Slate"
import { liveSnapshot, play, snapshot, team } from "@sportal/domain/TestGame"
import {
  Context,
  type Crypto,
  DateTime,
  Effect,
  Equal,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Metric,
  Option,
  Ref,
  Stream,
  type Tracer
} from "effect"
import type { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import { FeedLog } from "./FeedLog.ts"
import { FeedFrame } from "./Frame.ts"
import { LiveSlate } from "./LiveSlate.ts"
import { Decoder } from "./provider/Decoder.ts"
import * as EspnDecode from "./provider/espn/EspnDecode.ts"
import { fixtures, neAtBufFrames, recordedCheckpoint } from "./provider/espn/TestEspn.ts"
import { Decoded } from "./provider/Provider.ts"
import { Scenarios } from "./scenario/Scenarios.ts"
import { delivered, dyingAt, framed, pushed, slateFollowing } from "./TestFeed.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"
import { counted, gauged, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

const one = GameId.make("1")
const neAtBuf = GameId.make("401872971")

// Measured once over the fixture: every play id its topic's patches add, whole or one at a time (none is removed,
// moved, or copied), counted with
//   zcat nfl-2026-10-04-ne-buf.frames.jsonl.gz | jq -r 'select(.kind=="message") | .body | fromjson
//     | select(.op=="P" or .op=="R") | .pl | fromjson | .pl | fromjson | .[]
//     | select(.path|test("^/entities/plays(/[^/]+)?$"))
//     | if .path=="/entities/plays" then (.value|keys[]) else (.path|ltrimstr("/entities/plays/")) end' | sort -u | wc -l
const recordedPlays = 182

describe("following the feed log", () => {
  it.effect(
    "the build returns once every logged frame is taken, quietly, then logs one summary line and sets each game's gauges",
    () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        const current = yield* (yield* LiveSlate).latest
        assert.deepStrictEqual(current.seq, Option.some(3))
        assert.strictEqual(current.live.get(one)?.plays.length, 1)
        assert.strictEqual(current.live.get(one)?.snapshot.clock, "9:00")
        assert.isFalse(logs.some(({ message }) => /→|started|ScoreChanged|Played/.test(message)))
        const info = logs.filter(({ level }) => level === "Info")
        assert.strictEqual(info.length, 1)
        assert.include(
          info[0]?.message,
          "LiveSlate: replayed 3 frames: 3 deliveries, 1 plays; 1 live games, in "
        )
        const metrics = yield* Metric.snapshot
        assert.deepStrictEqual(
          metrics
            .filter(({ attributes, type }) => attributes?.game !== undefined && type !== "Gauge")
            .map(({ id }) => id),
          []
        )
        assert.isUndefined(yield* counted("sportal_transitions"))
        const attributes = { game: "1", league: "fbs", matchup: "AWAY at HOME" }
        assert.strictEqual(yield* gauged("sportal_game_state", attributes), 2)
        assert.strictEqual(yield* gauged("sportal_live_games", { state: "Live" }), 1)
        assert.strictEqual(yield* gauged("sportal_live_games", { state: "Stale" }), 0)
      }).pipe(
        Effect.provide(
          slateFollowing([
            framed(
              Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "poll" }),
              start
            ),
            framed(
              Delivery.cases.Plays.make({ game: one, plays: [play()] }),
              DateTime.add(start, { seconds: 10 })
            ),
            framed(
              Delivery.cases.Snapshot.make({
                snapshot: liveSnapshot({ id: one, clock: "9:00" }),
                from: "poll"
              }),
              DateTime.add(start, { minutes: 3 })
            )
          ]).pipe(Layer.provideMerge(layer))
        ),
        withMetrics
      )
    }
  )

  it.effect("the catch-up is one span, with the frames and deliveries it took", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* LiveSlate
      const replay = ended.find((span) => span.name === "LiveSlate.replay")
      assert.strictEqual(replay?.attributes.get("sportal.frames"), 3)
      assert.strictEqual(replay?.attributes.get("sportal.deliveries"), 2)
      assert.isUndefined(ended.find((span) => span.name === "LiveSlate.take"))
    }).pipe(
      Effect.provide(
        slateFollowing([
          framed(Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "poll" }), start),
          framed(Delivery.cases.Plays.make({ game: one, plays: [play()] }), start),
          new FeedFrame({ ...framed(Delivery.cases.Plays.make({ game: one, plays: [] }), start), body: "{" })
        ]).pipe(Layer.provideMerge(recordingSpans(ended)))
      )
    )
  })

  it.effect("the catch-up applies recorded times, and the timer starts only once it is done", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* TestClock.adjust("1 hour")
      yield* Effect.gen(function* () {
        const summary = logs.find(({ message }) => message.includes("replayed"))
        assert.include(summary?.message, "1 plays", "the plays reached a game no tick had let go")
        yield* TestClock.adjust(0)
        assert.isFalse((yield* (yield* LiveSlate).latest).live.has(one))
      }).pipe(
        Effect.provide(
          slateFollowing([
            framed(
              Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "poll" }),
              start
            ),
            framed(
              Delivery.cases.Plays.make({ game: one, plays: [play()] }),
              DateTime.add(start, { seconds: 10 })
            )
          ]).pipe(Layer.provideMerge(layer))
        )
      )
    })
  })

  it.effect("replayed frames tell and publish no events; the same frames taken live do", () =>
    Effect.gen(function* () {
      yield* latestOf(slateFollowing(day))
      assert.isUndefined(yield* counted("sportal_plays"))
      assert.isUndefined(yield* counted("sportal_game_events"))
      const taken = yield* eventsWhile(takenInTime(day))
      assert.deepStrictEqual(
        taken.map(({ game, what }) => [game, what._tag]),
        [
          [one, "Played"],
          [one, "ScoreChanged"],
          [one, "Played"]
        ]
      )
      assert.strictEqual(yield* counted("sportal_plays"), 2)
    }).pipe(withMetrics)
  )

  it.effect("the same frames taken in time and replayed give the same live games", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      const replayed = yield* latestOf(slateFollowing(day))
      const taken = yield* LiveSlate.use((slate) => takenInTime(day).pipe(Effect.andThen(slate.latest))).pipe(
        Effect.provide(slateFollowing())
      )
      assert.isTrue(Equal.equals(replayed.live, taken.live))
      assert.deepStrictEqual(replayed.seq, taken.seq)
      assert.isTrue(LiveGameState.$is("Live")(taken.live.get(one)?.state ?? LiveGameState.Over()))
      assert.isTrue(logs.some(({ message }) => message.includes("Live → Stale")))
      const summary = logs.find(({ message }) => message.includes("replayed"))
      assert.include(summary?.message, "replayed 5 frames: 5 deliveries, 2 plays; 1 live games")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a frame appended as the catch-up ends is taken after it, and told", () =>
    Effect.gen(function* () {
      yield* loggedBefore([
        pushed(
          Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one, period: 2 }), from: "push" }),
          "fbs"
        )
      ])
      // The log's replay appends a frame as it ends, so it is in the log before decoding reaches the end of the replay.
      const appendingAtEnd = Layer.effect(
        FeedLog,
        Effect.map(FeedLog, (log) =>
          FeedLog.of({
            ...log,
            replay: (from) =>
              log.replay(from).pipe(
                Stream.concat(
                  Stream.fromEffect(
                    Effect.flatMap(
                      pushed(
                        Delivery.cases.Snapshot.make({
                          snapshot: liveSnapshot({ id: one, period: 3 }),
                          from: "push"
                        }),
                        "fbs"
                      ),
                      log.append
                    )
                  ).pipe(Stream.drain)
                )
              )
          })
        )
      ).pipe(Layer.provide(FeedLog.layer))

      yield* Effect.gen(function* () {
        const current = yield* (yield* LiveSlate).through(2)
        assert.strictEqual(current.live.get(one)?.snapshot.period, 3)
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "taken" }), 1)
      }).pipe(Effect.provide(following(appendingAtEnd, TestSnapshotFeed.decoder)))
    }).pipe(Effect.provide([Database.at(":memory:"), NodeCrypto.layer]), withMetrics)
  )

  it.effect(
    "with a decode that reads ahead, replayed frames are still taken quietly, and the build waits for the last one",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        yield* loggedBefore(
          [1, 2, 3].map((period) =>
            pushed(
              Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one, period }), from: "push" }),
              "fbs"
            )
          )
        )
        yield* Effect.gen(function* () {
          const building = yield* Layer.build(
            LiveSlate.layer.pipe(Layer.provide([inPairs, DateTime.layerCurrentZoneLocal]))
          ).pipe(Effect.forkScoped)
          // The pairing decode holds frame 3 until a frame after it is appended, so the build cannot end before then.
          yield* TestClock.withLive(Effect.sleep("50 millis"))
          assert.isUndefined(building.pollUnsafe(), "the build waits for the last replayed frame")
          yield* (yield* FeedLog).append(
            yield* pushed(
              Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one, period: 4 }), from: "push" }),
              "fbs"
            )
          )
          const current = yield* Context.get(yield* Fiber.join(building), LiveSlate).through(4)
          assert.strictEqual(current.live.get(one)?.snapshot.period, 4)
          assert.include(
            logs.find(({ message }) => message.includes("replayed"))?.message,
            "replayed 3 frames"
          )
          assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "taken" }), 1)
        }).pipe(Effect.scoped, Effect.provide(FeedLog.layer))
      }).pipe(Effect.provide([Database.at(":memory:"), NodeCrypto.layer, layer]), withMetrics)
    }
  )

  it.effect(
    "no decode observation is told from a replayed frame; the same observation on a live frame is",
    () =>
      Effect.gen(function* () {
        assert.isUndefined(yield* counted("sportal_frames_undecoded"))
        const frame = yield* (yield* FeedLog).append(yield* undecodable)
        yield* (yield* LiveSlate).through(frame.seq)
        assert.strictEqual(yield* counted("sportal_frames_undecoded", { feed: "snapshot" }), 1)
      }).pipe(
        Effect.provide(Layer.unwrap(Effect.map(undecodable, (frame) => slateFollowing([frame])))),
        withMetrics
      )
  )

  it.effect("ESPN's observations on replayed frames are neither counted nor logged", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* (yield* LiveSlate).latest
      for (const counter of decodeCounters) assert.isUndefined(yield* counted(counter), counter)
      assert.deepStrictEqual(
        logs.filter(({ message }) => message.includes("Decode:")),
        []
      )
    }).pipe(
      Effect.provide(
        Layer.unwrap(
          Effect.map(Effect.all(noticeable), (frames) =>
            slateFollowing(frames, { decoder: EspnDecode.layer })
          )
        ).pipe(Layer.provideMerge(layer))
      ),
      withMetrics
    )
  })

  it.effect("the same observations on frames after the catch-up are counted and logged", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      const log = yield* FeedLog
      const frames = yield* Effect.forEach(noticeable, (frame) => Effect.flatMap(frame, log.append))
      yield* (yield* LiveSlate).through(frames.at(-1)?.seq ?? 0)

      assert.strictEqual(yield* counted("sportal_frames_undecoded", { feed: "poll" }), 1)
      assert.strictEqual(yield* counted("sportal_live_feed_games", { league: "nfl" }), 16)
      assert.strictEqual(yield* counted("sportal_live_feed_unlisted", { league: "nfl" }), 16)
      assert.strictEqual(yield* counted("sportal_live_feed_messages", { league: "nfl", op: "P" }), 1)
      assert.strictEqual(
        yield* counted("sportal_live_feed_document_resets", { league: "nfl", reason: "Gap" }),
        1
      )
      assert.strictEqual(
        logs.filter(
          ({ level, message }) => level === "Warn" && message.includes("waits for its next checkpoint")
        ).length,
        1
      )
      assert.isTrue(logs.some(({ level, message }) => level === "Error" && message.includes("Decode:")))
    }).pipe(
      Effect.provide(slateFollowing([], { decoder: EspnDecode.layer }).pipe(Layer.provideMerge(layer))),
      withMetrics
    )
  })

  it.effect("the decoder's state from the replayed frames is in effect for the first live frame", () =>
    Effect.gen(function* () {
      const frame = yield* (yield* FeedLog).append(yield* pushed({ _tag: "Resync" }, "fbs"))
      const current = yield* (yield* LiveSlate).through(frame.seq)
      assert.deepStrictEqual(
        [...current.live.values()].map((held) => held.snapshot.home.score),
        [3]
      )
    }).pipe(
      Effect.provide(
        Layer.unwrap(
          Effect.map(
            Effect.all([pushed({ _tag: "Resync" }, "fbs"), pushed({ _tag: "Resync" }, "fbs")]),
            (frames) => slateFollowing(frames, { decoder: counting })
          )
        )
      )
    )
  )

  it.effect("a decode that dies during the catch-up fails the build", () =>
    Effect.gen(function* () {
      const built = yield* Layer.build(
        Layer.unwrap(
          Effect.map(pushed({ _tag: "Resync" }, "fbs"), (frame) =>
            slateFollowing([new FeedFrame({ ...frame, body: "die" })], { decoder: dyingAt("die") })
          )
        )
      ).pipe(Effect.scoped, Effect.exit)
      assert.isTrue(Exit.hasDies(built))
    })
  )

  describe("the game day", () => {
    // The log holds a frame at each of these instants; the replay, from the game day's start, reads those from it on.
    const framesAt = ["2026-10-03T08:59:00Z", "2026-10-03T09:00:00Z", "2026-10-04T09:00:00Z"]

    const replayedAt = (chicago: string) =>
      Effect.gen(function* () {
        const ended: Array<Tracer.Span> = []
        yield* TestClock.setTime(
          DateTime.toEpochMillis(
            Option.getOrThrow(
              DateTime.makeZoned(chicago, { timeZone: "America/Chicago", adjustForTimeZone: true })
            )
          )
        )
        const frames = framesAt.map((at) =>
          framed(
            Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one, period: 2 }), from: "poll" }),
            DateTime.makeUnsafe(at)
          )
        )
        yield* latestOf(
          slateFollowing(frames, { zone: DateTime.zoneMakeNamedUnsafe("America/Chicago") }).pipe(
            Layer.provideMerge(recordingSpans(ended))
          )
        )
        return ended.find((span) => span.name === "LiveSlate.replay")?.attributes.get("sportal.frames")
      })

    it.effect("starts at yesterday's 04:00 before 04:00", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* replayedAt("2026-10-04T03:59:00"), 2)
      })
    )

    it.effect("starts at today's 04:00 from 04:00", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* replayedAt("2026-10-04T04:00:00"), 1)
        assert.strictEqual(yield* replayedAt("2026-10-04T23:59:00"), 1)
      })
    )
  })
})

describe("a covered game's fallback", () => {
  it.effect(
    "a live poll ahead of a covered game is held, then falls back at until, logged and counted by league",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        yield* delivered(
          Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one, clock: "5:00" }), from: "push" })
        )
        const ahead = liveSnapshot({ id: one, clock: "4:30", home: { team: team("HOME"), score: 7 } })
        yield* delivered(Delivery.cases.Listing.make({ league: "fbs", games: [ahead] }))
        assert.isTrue(
          LiveGameState.$is("Holding")(
            (yield* (yield* LiveSlate).latest).live.get(one)?.state ?? LiveGameState.Over()
          )
        )
        assert.isUndefined(yield* counted("sportal_poll_fallbacks"))
        yield* TestClock.adjust(LiveGame.fallbackAfter)
        assert.strictEqual((yield* (yield* LiveSlate).latest).live.get(one)?.snapshot.home.score, 7)
        assert.strictEqual(yield* counted("sportal_poll_fallbacks", { league: "fbs" }), 1)
        const told = logs.filter(({ level }) => level === "Info").map(({ message }) => message)
        assert.isTrue(told.some((message) => message.includes("held poll live, period 1, 4:30")))
        assert.isTrue(told.some((message) => message.includes("fellBack poll live, period 1, 4:30")))
        assert.isTrue(told.some((message) => message.includes("ScoreChanged")))
        assert.isFalse(logs.some(({ level }) => level === "Error"))
      }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
    }
  )
})

describe("a recorded game", () => {
  it.effect(
    "replays through decode and the slate to NE at BUF final, with every play the recording has, and nothing failed",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const latest = yield* (yield* LiveSlate).latest

        const listed = latest.listed.get("nfl")?.find((game) => game.id === neAtBuf)
        assert.strictEqual(listed?.status, "final")
        assert.isFalse(latest.live.has(neAtBuf), "a final game is let go")
        const summary = logs.find(({ message }) => message.includes("replayed"))
        assert.include(summary?.message, ` ${recordedPlays} plays`)
        for (const counter of [
          "sportal_frames_undecoded",
          "sportal_events_undecoded",
          "sportal_live_feed_undecoded_plays",
          "sportal_live_feed_document_resets",
          "sportal_game_defects"
        ]) {
          assert.isUndefined(yield* counted(counter), counter)
        }
        assert.deepStrictEqual(
          logs.filter(({ level }) => level === "Error"),
          []
        )
      }).pipe(
        Effect.provide(
          Layer.unwrap(
            Effect.map(recorded, (frames) => slateFollowing(frames, { decoder: EspnDecode.layer }))
          ).pipe(Layer.provideMerge(layer))
        ),
        withMetrics
      )
    },
    { timeout: 60_000 }
  )

  it.effect(
    "takes the same replayed as taken live, and the same twice: the same live games, and the same events",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const frames = yield* recorded

        const first = yield* replayed(frames)
        const second = yield* replayed(frames)
        assert.isTrue(Equal.equals(first, second))

        // A few points through the day, each replayed from the frames before it, while the clock is still at its start.
        const points = [
          1,
          Math.floor(frames.length / 4),
          Math.floor(frames.length / 2),
          Math.floor((frames.length * 3) / 4)
        ]
        const replayedTo = yield* Effect.forEach(points, (point) => replayed(frames.slice(0, point)))

        const once = yield* takenLive(frames, points)
        const again = yield* takenLive(frames)
        points.forEach((point, index) => {
          const live = once.sampled.get(point)
          assert.isTrue(
            Equal.equals(replayedTo[index]?.live, live?.live),
            `the live games after ${point} frames`
          )
          assert.isTrue(
            Equal.equals(replayedTo[index]?.listed, live?.listed),
            `the listings after ${point} frames`
          )
        })
        assert.isTrue(Equal.equals(first.live, once.latest.live), "replay ends with the live games live did")
        assert.isTrue(Equal.equals(first.listed, once.latest.listed), "and the listings")
        assert.isTrue(Equal.equals(once.held, again.held))
        assert.isTrue(Equal.equals(once.events, again.events))
        const played = once.events.filter(({ what }) => what._tag === "Played").length
        assert.strictEqual(played, recordedPlays, "each play is played once")
        const summary = logs.find(({ message }) => message.includes("replayed"))
        assert.include(summary?.message, ` ${played} plays`, "and the replay took each play live did")
      }).pipe(Effect.provide(layer))
    },
    // The recorded day five and a half times over, two of them live: well over a minute beside the rest of the suite.
    { timeout: 120_000 }
  )

  it.effect(
    "replayed from after its topic's checkpoint, still takes every play its patches add",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const frames = yield* recorded
        // The game day starts after the topic's checkpoint (16:44:55Z) and before the first play's patch (17:02:42Z),
        // as it falls for a socket subscribed the night before: 04:00 in a zone 12:56:40 behind UTC is 16:56:40Z.
        yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-04T20:00:00Z")))
        const zone = DateTime.zoneMakeOffset(-((12 * 60 + 56) * 60 + 40) * 1000)
        yield* latestOf(slateFollowing(frames, { decoder: EspnDecode.layer, zone }))
        const summary = logs.find(({ message }) => message.includes("replayed"))
        assert.notInclude(
          summary?.message,
          `replayed ${frames.length} frames`,
          "the replay starts after the first"
        )
        assert.include(summary?.message, ` ${recordedPlays} plays`)
      }).pipe(Effect.provide(layer))
    },
    { timeout: 60_000 }
  )

  it.effect(
    "comes back the same after a restart halfway through the day",
    () =>
      Effect.gen(function* () {
        const all = yield* recorded
        const half = Math.floor(all.length / 2)
        const fs = yield* FileSystem.FileSystem
        const onDisk = Layer.merge(
          Database.at(join(yield* fs.makeTempDirectoryScoped(), "feed.sqlite")),
          NodeCrypto.layer
        )

        // Half the day logged and followed, then every layer closed; reopened on the same file, the rest logged, and
        // the whole log followed, as a Hub starting again would.
        yield* loggedBefore(all.slice(0, half).map((frame) => Effect.succeed(frame))).pipe(
          Effect.provide(onDisk)
        )
        const before = yield* latestOf(following(FeedLog.layer, EspnDecode.layer)).pipe(
          Effect.provide(onDisk)
        )
        yield* loggedBefore(all.slice(half).map((frame) => Effect.succeed(frame))).pipe(
          Effect.provide(onDisk)
        )
        const after = yield* latestOf(following(FeedLog.layer, EspnDecode.layer)).pipe(Effect.provide(onDisk))

        const uninterrupted = yield* replayed(all)
        assert.isTrue(Equal.equals(after, uninterrupted))
        assert.deepStrictEqual(before.seq, Option.some(half))
        assert.isTrue(
          Equal.equals(before, yield* replayed(all.slice(0, half))),
          "before the restart, as the uninterrupted log was at that point"
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 }
  )
})

// The test clock's start, where the frames these tests log are received from.
const start = DateTime.makeUnsafe(0)

/**
 * Five frames of game one from the test clock's start: a snapshot, a play, a stale stretch, a score with a second play,
 * and a last snapshot.
 */
const day = (() => {
  const scored = (clock: string) =>
    snapshot({ id: one, status: "live", period: 1, clock, home: { team: team("HOME"), score: 7 } })
  const second = play({ id: PlayId.make("2"), sequence: 2, clock: "14:30" })
  return [
    framed(Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "poll" }), start),
    framed(Delivery.cases.Plays.make({ game: one, plays: [play()] }), DateTime.add(start, { seconds: 10 })),
    framed(
      Delivery.cases.Snapshot.make({ snapshot: scored("9:00"), from: "push" }),
      DateTime.add(start, { minutes: 3 })
    ),
    framed(
      Delivery.cases.Plays.make({ game: one, plays: [play(), second] }),
      DateTime.add(start, { minutes: 3, seconds: 5 })
    ),
    framed(
      Delivery.cases.Snapshot.make({ snapshot: scored("8:00"), from: "poll" }),
      DateTime.add(start, { minutes: 4, seconds: 30 })
    )
  ]
})()

/**
 * Appends each of `frames` once the test clock reaches it and waits for the slate to take it, so the timer runs
 * between them as it would live.
 */
function takenInTime(frames: ReadonlyArray<FeedFrame>) {
  return Effect.forEach(
    frames,
    (frame) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(DateTime.distance(yield* DateTime.now, frame.receivedAt))
        const appended = yield* (yield* FeedLog).append(frame)
        yield* (yield* LiveSlate).through(appended.seq)
      }),
    { discard: true }
  )
}

/** The events a fresh slate publishes while `run` runs. */
function eventsWhile(run: Effect.Effect<void, never, LiveSlate | FeedLog>) {
  return Effect.gen(function* () {
    const slate = yield* LiveSlate
    const seen = yield* Ref.make<ReadonlyArray<GameEvent>>([])
    const subscriber = yield* slate.events.pipe(
      Stream.runForEach((published) => Ref.update(seen, (all) => [...all, published])),
      Effect.forkChild({ startImmediately: true })
    )
    yield* run
    yield* Effect.yieldNow
    yield* Fiber.interrupt(subscriber)
    return yield* Ref.get(seen)
  }).pipe(Effect.provide(slateFollowing()))
}

/** The slate following `feedLog`, which is provided too, read by `decoder`, in the local zone. */
function following(
  feedLog: Layer.Layer<FeedLog, never, SqlClient.SqlClient | Crypto.Crypto>,
  decoder: Layer.Layer<Decoder>
) {
  return LiveSlate.layer.pipe(
    Layer.provideMerge(feedLog),
    Layer.provide([decoder, DateTime.layerCurrentZoneLocal])
  )
}

/** The slate's latest once `layer` is built. */
function latestOf<E, R>(layer: Layer.Layer<LiveSlate, E, R>) {
  return LiveSlate.use((slate) => slate.latest).pipe(Effect.provide(layer))
}

/** `frames` logged now, before the slate starts, in a scope of their own. */
function loggedBefore(frames: ReadonlyArray<Effect.Effect<FeedFrame>>) {
  return Effect.gen(function* () {
    const log = yield* FeedLog
    yield* Effect.forEach(frames, (frame) => Effect.flatMap(frame, log.append), { discard: true })
  }).pipe(Effect.provide(FeedLog.layer), Effect.scoped)
}

/** The recorded NE at BUF day's frames. */
const recorded = Scenarios.use((scenarios) => scenarios.load(neAtBufFrames)).pipe(
  Effect.map(({ frames }) => frames),
  Effect.provide(Scenarios.in(fixtures, []).pipe(Layer.provideMerge(NodeServices.layer)))
)

/** A fresh slate's latest once it has replayed `frames`, decoded as ESPN. */
function replayed(frames: ReadonlyArray<FeedFrame>) {
  return latestOf(slateFollowing(frames, { decoder: EspnDecode.layer }))
}

/**
 * A fresh slate taking `frames` decoded as ESPN, each appended once the test clock reaches it, as live: their state
 * at the end and once each count of frames in `sampling` is taken, each live game NE at BUF was held as, in order, and
 * every event published. The clock is set to the first frame before the feed log opens, so its writer never wakes
 * through the years before it.
 */
function takenLive(frames: ReadonlyArray<FeedFrame>, sampling: ReadonlyArray<number> = []) {
  const taking = Effect.gen(function* () {
    const slate = yield* LiveSlate
    const held = yield* Ref.make<ReadonlyArray<LiveGame>>([])
    const sampled = yield* Ref.make<ReadonlyMap<number, Slate>>(new Map())
    const events = yield* Ref.make<ReadonlyArray<GameEvent>>([])
    const subscriber = yield* slate.events.pipe(
      Stream.runForEach((published) => Ref.update(events, (seen) => [...seen, published])),
      Effect.forkChild({ startImmediately: true })
    )
    yield* Effect.forEach(
      frames,
      (frame, index) =>
        takenInTime([frame]).pipe(
          Effect.andThen(slate.latest),
          Effect.tap((latest) =>
            sampling.includes(index + 1)
              ? Ref.update(sampled, (all) => new Map(all).set(index + 1, latest))
              : Effect.void
          ),
          Effect.flatMap((latest) =>
            Option.match(Option.fromUndefinedOr(latest.live.get(neAtBuf)), {
              onNone: () => Effect.void,
              onSome: (liveGame) =>
                Ref.update(held, (all) => (all.at(-1) === liveGame ? all : [...all, liveGame]))
            })
          )
        ),
      { discard: true }
    )
    yield* Effect.yieldNow
    yield* Fiber.interrupt(subscriber)
    return {
      latest: yield* slate.latest,
      sampled: yield* Ref.get(sampled),
      held: yield* Ref.get(held),
      events: yield* Ref.get(events)
    }
  }).pipe(Effect.provide(slateFollowing([], { decoder: EspnDecode.layer })))
  return Option.match(Option.fromUndefinedOr(frames[0]), {
    onNone: () => taking,
    onSome: (first) =>
      TestClock.setTime(DateTime.toEpochMillis(first.receivedAt)).pipe(Effect.andThen(taking))
  })
}

/** A snapshot feed frame, received now, whose body does not decode. */
const undecodable = Effect.map(
  pushed({ _tag: "Resync" }, "fbs"),
  (frame) => new FeedFrame({ ...frame, kind: "response", body: "not json" })
)

/**
 * Frames, received now, that ESPN's decode observations: a poll that does not decode, the recorded NFL scoreboard
 * checkpoint before any listing (sixteen games pushed and unlisted), and a game topic's checkpoint and then a message
 * after a gap.
 */
const noticeable: ReadonlyArray<Effect.Effect<FeedFrame>> = (
  [
    { feed: "poll", channel: "nfl", kind: "response", body: "not json" },
    {
      feed: "fastcast",
      channel: "event-football-nfl",
      kind: "checkpoint",
      sourceId: 4286637,
      body: recordedCheckpoint()
    },
    {
      feed: "fastcast",
      channel: "gp-football-nfl-1",
      kind: "checkpoint",
      sourceId: 99,
      body: JSON.stringify({ entities: {} })
    },
    {
      feed: "fastcast",
      channel: "gp-football-nfl-1",
      kind: "message",
      sourceId: 101,
      body: JSON.stringify({
        op: "P",
        tc: "gp-football-nfl-1",
        mid: 101,
        pl: JSON.stringify({ ts: 1, pl: [] })
      })
    }
  ] satisfies ReadonlyArray<Omit<FeedFrame, "receivedAt">>
).map((frame) => Effect.map(DateTime.now, (receivedAt) => new FeedFrame({ ...frame, receivedAt })))

const decodeCounters = [
  "sportal_live_feed_messages",
  "sportal_live_feed_games",
  "sportal_events_undecoded",
  "sportal_live_feed_unlisted",
  "sportal_live_feed_document_resets",
  "sportal_frames_undecoded"
]

/** The snapshot feed's decode, handing on what frames said two at a time, so it reads a frame ahead of the last it gave. */
const inPairs = Layer.effect(
  Decoder,
  Effect.map(Decoder, (decoder) =>
    Decoder.of({ decode: (frames) => decoder.decode(frames).pipe(Stream.grouped(2), Stream.flattenIterable) })
  )
).pipe(Layer.provide(TestSnapshotFeed.decoder))

/**
 * A decode that keeps a count of the frames it has read and reads each as a pushed live game with that count for the
 * home score.
 */
const counting = Layer.succeed(
  Decoder,
  Decoder.of({
    decode: (frames) =>
      frames.pipe(
        Stream.mapAccum(
          () => 0,
          (count, frame) =>
            [
              count + 1,
              [
                new Decoded({
                  seq: frame.seq,
                  at: frame.receivedAt,
                  deliveries: [
                    Delivery.cases.Snapshot.make({
                      snapshot: liveSnapshot({ home: { team: team("HOME"), score: count + 1 } }),
                      from: "push"
                    })
                  ],
                  resyncs: [],
                  observations: []
                })
              ]
            ] as const
        )
      )
  })
)
