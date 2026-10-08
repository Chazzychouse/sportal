import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { type GameEvent, GameEventKind } from "@sportal/domain/GameEvent"
import { PlayId } from "@sportal/domain/Play"
import { liveSnapshot, play, snapshot, team } from "@sportal/domain/TestGame"
import {
  Clock,
  Context,
  type Crypto,
  DateTime,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Metric,
  Option,
  Ref,
  Stream,
  type Tracer
} from "effect"
import type { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import { Frame } from "./Frame.ts"
import { FeedLog } from "./feed-log/FeedLog.ts"
import { HubConfig } from "./HubConfig.ts"
import { LiveSlate } from "./LiveSlate.ts"
import { Decoded, Decoder } from "./provider/Decoder.ts"
import * as EspnDecoder from "./provider/espn/EspnDecoder.ts"
import { fixtures, recordedNeAtBuf, recordedPlays } from "./provider/espn/TestEspn.ts"
import { Acknowledgement } from "./slate/Acknowledgement.ts"
import { Delivery } from "./slate/Delivery.ts"
import type { Slate } from "./slate/Slate.ts"
import { appended, delivered, latestOf, slateFollowing } from "./TestLiveSlate.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"
import { framed, pushed } from "./TestSnapshotFeed.ts"
import { counted, gauged, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

const one = GameId.make("1")
const two = GameId.make("2")
const three = GameId.make("3")
const neAtBuf = GameId.make("401872971")

describe("LiveSlate, a frame taken live", () => {
  it.effect("should start a live game for each current game a listing names, keeping the listing", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const live = liveSnapshot({ id: one })
      const soon = snapshot({ id: two, kickoff: DateTime.add(now, { minutes: 20 }) })
      const later = snapshot({ id: three, kickoff: DateTime.add(now, { hours: 3 }) })

      yield* listing("fbs", [live, soon, later])
      const current = yield* latest

      assert.deepStrictEqual(current.listed.get("fbs"), [live, soon, later])
      assert.deepStrictEqual(current.games.get(one), live)
      assert.strictEqual(current.acknowledged.get(one)?.from, "poll")
      assert.deepStrictEqual(current.games.get(two), soon)
      assert.isFalse(current.games.has(three))
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should take a game's pushed snapshots into its live game, at the last frame's seq", () =>
    Effect.gen(function* () {
      yield* push(liveSnapshot({ id: one }))
      yield* push(liveSnapshot({ id: one }))
      const current = yield* latest

      assert.deepStrictEqual(current.seq, Option.some(2))
      assert.deepStrictEqual(current.state(one), Option.some("Live"))
      assert.strictEqual(current.acknowledged.get(one)?.from, "push")
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should ignore a snapshot behind its game's", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }))

      yield* takenSnapshot(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }))
      const liveGame = yield* gameOf(one)

      assert.strictEqual(liveGame.snapshot.period, 2)
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should keep a live game of its own for each game", () =>
    Effect.gen(function* () {
      const first = liveSnapshot({ id: one, clock: "9:00" })
      const second = snapshot({ id: two, status: "live", period: 3, clock: "1:00" })

      yield* takenSnapshot(first)
      yield* takenSnapshot(second)
      const firstGame = yield* gameOf(one)
      const secondGame = yield* gameOf(two)

      assert.deepStrictEqual(firstGame.snapshot, first)
      assert.deepStrictEqual(secondGame.snapshot, second)
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should take a game's plays into its live game, publishing each new play as an event", () =>
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      const events = yield* slate.events.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true })
      )
      yield* takenSnapshot(liveSnapshot({ id: one }))
      const now = yield* DateTime.now
      const frameAt = DateTime.add(now, { seconds: 5 })

      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play()] }), frameAt)
      const liveGame = yield* gameOf(one)
      const [first] = yield* Fiber.join(events)
      const plays = yield* counted("sportal_plays", { league: "fbs" })

      assert.strictEqual(liveGame.plays.length, 1)
      assert.strictEqual(first?.game, one)
      assert.deepStrictEqual(first?.at, frameAt)
      assert.strictEqual(first?.what._tag, "Played")
      assert.strictEqual(plays, 1)
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect("should drop and count plays for a game with no live game", () =>
    Effect.gen(function* () {
      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play()] }))
      const current = yield* latest
      const dropped = yield* counted("sportal_deliveries_dropped")

      assert.strictEqual(current.games.size, 0)
      assert.strictEqual(dropped, 1)
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect(
    "should leave the other games and a game's last good live game alone on a defect in its delivery",
    () =>
      Effect.gen(function* () {
        const first = yield* twoLiveGames

        yield* brokenListing
        const firstGame = yield* gameOf(one)
        const secondGame = yield* gameOf(two)

        assert.deepStrictEqual(firstGame.snapshot, first)
        assert.strictEqual(secondGame.snapshot.clock, "8:00")
      }).pipe(Effect.provide(slateFollowing([], { decoder: breaking })))
  )

  it.effect("should take a game's next snapshot after a defect in its delivery", () =>
    Effect.gen(function* () {
      yield* twoLiveGames
      yield* brokenListing
      const next = liveSnapshot({ id: one, clock: "8:00" })

      yield* takenSnapshot(next)
      const liveGame = yield* gameOf(one)

      assert.deepStrictEqual(liveGame.snapshot, next)
    }).pipe(Effect.provide(slateFollowing([], { decoder: breaking })))
  )
})

describe("LiveSlate#changes", () => {
  it.effect("should publish the latest, then each new state once", () =>
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      const published = yield* Ref.make<ReadonlyArray<Option.Option<GameSnapshot>>>([])
      yield* slate.changes.pipe(
        Stream.runForEach((current) =>
          Ref.update(published, (all) => [...all, Option.fromNullishOr(current.games.get(one))])
        ),
        Effect.forkScoped({ startImmediately: true })
      )
      const first = liveSnapshot({ id: one })
      const second = liveSnapshot({ id: one, clock: "9:00" })

      yield* takenSnapshot(first)
      yield* takenSnapshot(second)
      yield* takenSnapshot(liveSnapshot({ id: one, clock: "11:00" }))
      yield* Effect.yieldNow
      const all = yield* Ref.get(published)

      assert.deepStrictEqual(all, [Option.none(), Option.some(first), Option.some(second)])
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should not publish a frame that moves only the seq", () =>
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      const published = yield* Ref.make(0)
      yield* slate.changes.pipe(
        Stream.runForEach(() => Ref.update(published, (count) => count + 1)),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* takenSnapshot(liveSnapshot({ id: one }))
      const resync = yield* pushed({ _tag: "Resync" }, "topic")

      const current = yield* appended(resync)
      yield* Effect.yieldNow
      const count = yield* Ref.get(published)

      assert.deepStrictEqual(current.seq, Option.some(2))
      assert.strictEqual(count, 2)
    }).pipe(Effect.provide(slateFollowing()))
  )
})

describe("LiveSlate#through", () => {
  it.effect("should answer for a frame that decodes only to a decode observation, which is told", () =>
    Effect.gen(function* () {
      const frame = yield* undecodable

      const current = yield* appended(frame)
      const undecoded = yield* counted("sportal_frames_undecoded", { source: "push" })

      assert.deepStrictEqual(current.seq, Option.some(1))
      assert.strictEqual(undecoded, 1)
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect("should answer with the latest when a frame's decode dies", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(liveSnapshot({ id: one }))
      const frame = yield* dyingFrame

      const current = yield* appended(frame)

      assert.deepStrictEqual(current.seq, Option.some(1))
    }).pipe(Effect.provide(slateFollowing([], { decoder: dyingDecoder })))
  )

  it.effect(
    "should answer with the latest for a later frame once a decode defect halts the following, logged once",
    () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        yield* takenSnapshot(liveSnapshot({ id: one }))
        const frame = yield* dyingFrame
        yield* appended(frame)
        const after = yield* pushed({ _tag: "Resync" }, "x")

        const current = yield* appended(after)
        const stopped = logs.filter(({ level }) => level === "Error")

        assert.deepStrictEqual(current.seq, Option.some(1))
        assert.strictEqual(stopped.length, 1)
        assert.include(
          stopped[0]?.message,
          "frames are no longer taken into the slate until the Hub restarts"
        )
        assert.include(stopped[0]?.cause, "decode died")
      }).pipe(Effect.provide(slateFollowing([], { decoder: dyingDecoder }).pipe(Layer.provideMerge(layer))))
    }
  )
})

describe("LiveSlate#resyncs", () => {
  it.effect(
    "should emit each resync a live frame asks for from when it subscribed, however late it is run",
    () =>
      Effect.gen(function* () {
        const slate = yield* LiveSlate
        const resyncs = yield* slate.resyncs
        const first = yield* pushed({ _tag: "Resync" }, "first-topic")
        const second = yield* pushed({ _tag: "Resync" }, "second-topic")

        yield* appended(first)
        yield* appended(second)
        const channels = yield* resyncs.pipe(Stream.take(2), Stream.runCollect)

        assert.deepStrictEqual(channels, ["first-topic", "second-topic"])
      }).pipe(Effect.provide(slateFollowing()))
  )
})

describe("LiveSlate over time", () => {
  it.effect("should keep a live game nobody updates live at 89 seconds", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(liveSnapshot({ id: one }))

      yield* TestClock.adjust("89 seconds")
      const liveGame = yield* gameOf(one)

      assert.strictEqual(liveGame.state, "Live")
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should make a live game nobody updates stale at 90 seconds, with no delivery", () =>
    Effect.gen(function* () {
      const takenAt = yield* DateTime.now
      yield* takenSnapshot(liveSnapshot({ id: one }))

      yield* TestClock.adjust("90 seconds")
      const { state, acknowledgement } = yield* gameOf(one)

      assert.strictEqual(state, "Stale")
      assert.deepStrictEqual(acknowledgement.heardAt, takenAt)
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should keep a refreshed game live 60 seconds after its refresh", () =>
    Effect.gen(function* () {
      yield* refreshedAfterAMinute

      yield* TestClock.adjust("60 seconds")
      const liveGame = yield* gameOf(one)

      assert.strictEqual(liveGame.state, "Live")
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should make a refreshed game stale 90 seconds after its refresh", () =>
    Effect.gen(function* () {
      yield* refreshedAfterAMinute

      yield* TestClock.adjust("90 seconds")
      const liveGame = yield* gameOf(one)

      assert.strictEqual(liveGame.state, "Stale")
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should make a stale game live again on its next snapshot", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(liveSnapshot({ id: one }))
      yield* TestClock.adjust("100 seconds")
      const stale = yield* gameOf(one)
      const takenAt = yield* DateTime.now

      yield* takenSnapshot(liveSnapshot({ id: one, clock: "9:00" }))
      const { state, acknowledgement } = yield* gameOf(one)

      assert.strictEqual(stale.state, "Stale")
      assert.strictEqual(state, "Live")
      assert.deepStrictEqual(acknowledgement.heardAt, takenAt)
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should never make an upcoming game stale", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      yield* takenSnapshot(snapshot({ id: one, kickoff: DateTime.add(now, { minutes: 20 }) }))

      yield* TestClock.adjust("10 minutes")
      const liveGame = yield* gameOf(one)

      assert.strictEqual(liveGame.state, "Upcoming")
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should keep a stale game until 30 minutes after its last update", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(liveSnapshot({ id: one }))
      yield* TestClock.adjust("90 seconds")
      const stale = yield* gameOf(one)

      yield* TestClock.adjust("1709 seconds")
      const live = yield* liveNow

      assert.strictEqual(stale.state, "Stale")
      assert.isTrue(live.has(one))
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should let a stale game go 30 minutes after its last update", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(liveSnapshot({ id: one }))
      yield* TestClock.adjust("1799 seconds")

      yield* TestClock.adjust("1 second")
      const live = yield* liveNow

      assert.isFalse(live.has(one))
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should let a final game go at once", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(liveSnapshot({ id: one, clock: "1:00" }))

      yield* takenSnapshot(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
      const live = yield* liveNow

      assert.isFalse(live.has(one))
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should first tick every game due before a delivery at a later time", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      const start = yield* DateTime.now
      const later = DateTime.add(start, { minutes: 2 })
      yield* delivered(
        Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "poll" }),
        start
      )

      yield* delivered(
        Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one, clock: "9:00" }), from: "poll" }),
        later
      )
      const { state, acknowledgement } = yield* gameOf(one)
      const transitions = logs
        .map(({ message }) => /(\w+) → (\w+)/.exec(message)?.[0])
        .filter((transition) => transition !== undefined)

      assert.deepStrictEqual(transitions, ["Live → Stale", "Stale → Live"])
      assert.strictEqual(state, "Live")
      assert.deepStrictEqual(acknowledgement.heardAt, later)
    }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))))
  })

  it.effect("should commit nothing of a frame whose telling dies, logging that the following halts", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* takenSnapshot(liveSnapshot({ id: one }))

      const halted = yield* tellingDies
      const liveGame = yield* gameOf(one)
      const haltLogged = logs.some(
        ({ level, message }) =>
          level === "Error" &&
          message.includes("frames are no longer taken into the slate until the Hub restarts")
      )

      assert.deepStrictEqual(halted.seq, Option.some(1), "the frame whose report died is not taken")
      assert.isTrue(haltLogged)
      assert.strictEqual(liveGame.state, "Live")
    }).pipe(Effect.provide(slateDyingOnStale(layer)))
  })

  it.effect("should keep a game live at 89 seconds once a frame's telling has died", () => {
    const { layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* takenSnapshot(liveSnapshot({ id: one }))
      yield* tellingDies

      yield* TestClock.adjust("89 seconds")
      const liveGame = yield* gameOf(one)

      assert.strictEqual(liveGame.state, "Live")
    }).pipe(Effect.provide(slateDyingOnStale(layer)))
  })

  it.effect("should still make a game stale on time once a frame's telling has died", () => {
    const { layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* takenSnapshot(liveSnapshot({ id: one }))
      yield* tellingDies
      yield* TestClock.adjust("89 seconds")

      yield* TestClock.adjust("1 second")
      const liveGame = yield* gameOf(one)

      assert.strictEqual(liveGame.state, "Stale")
    }).pipe(Effect.provide(slateDyingOnStale(layer)))
  })

  it.effect("should still log and gauge a game going stale once the following has halted", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* takenSnapshot(liveSnapshot({ id: one }))
      const frame = yield* dyingFrame
      yield* appended(frame)

      yield* TestClock.adjust("90 seconds")
      const liveGame = yield* gameOf(one)
      const gameState = yield* gauged("sportal_game_state", { game: "1" })
      const staleGames = yield* gauged("sportal_live_games", { state: "Stale" })

      assert.strictEqual(liveGame.state, "Stale")
      assert.isTrue(logs.some(({ message }) => message.includes("Live → Stale")))
      assert.strictEqual(gameState, 3)
      assert.strictEqual(staleGames, 1)
    }).pipe(
      Effect.provide(slateFollowing([], { decoder: dyingDecoder }).pipe(Layer.provideMerge(layer))),
      withMetrics
    )
  })
})

describe("LiveSlate's telemetry", () => {
  it.effect("should log a transition with the game's annotations, and count it", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      const now = yield* DateTime.now
      yield* takenSnapshot(snapshot({ id: one, kickoff: DateTime.add(now, { minutes: 5 }) }))

      yield* takenSnapshot(home("15:00"))
      const transitions = logs.filter(({ message }) => message.includes("Upcoming → Live"))
      const count = yield* counted("sportal_transitions", { from: "Upcoming", to: "Live" })

      assert.strictEqual(transitions.length, 1)
      assert.strictEqual(transitions[0]?.level, "Info")
      assert.include(
        transitions[0]?.message,
        "LiveSlate: AWAY at HOME: Upcoming → Live at live, period 1, 15:00"
      )
      assert.include(transitions[0]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
      assert.strictEqual(count, 1)
    }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
  })

  it.effect("should log a game going stale", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      yield* takenSnapshot(home("10:00"))

      yield* TestClock.adjust("90 seconds")
      const stale = logs.filter(({ message }) => message.includes("Live → Stale"))

      assert.strictEqual(stale.length, 1)
      assert.strictEqual(stale[0]?.level, "Info")
      assert.include(stale[0]?.message, "LiveSlate: AWAY at HOME: Live → Stale at ")
      assert.include(stale[0]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
    }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))))
  })

  it.effect("should log a behind snapshot at Debug and count it", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      yield* takenSnapshot(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }))

      yield* takenSnapshot(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }))
      const behind = logs.filter(({ message }) => message.includes("behind"))
      const behindCount = yield* counted("sportal_snapshots", { outcome: "behind", game: "1" })
      const takenCount = yield* counted("sportal_snapshots", {
        outcome: "taken",
        game: "1",
        matchup: "AWAY at HOME"
      })

      assert.strictEqual(behind.length, 1)
      assert.strictEqual(behind[0]?.level, "Debug")
      assert.strictEqual(behindCount, 1)
      assert.strictEqual(takenCount, 1)
    }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
  })

  it.effect("should gauge a live game's state by game", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(home("10:00"))
      const gameState = yield* gauged("sportal_game_state", { game: "1", matchup: "AWAY at HOME" })

      assert.strictEqual(gameState, 2)
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect("should gauge a game's state again when it goes stale", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(home("10:00"))

      yield* TestClock.adjust("90 seconds")
      const gameState = yield* gauged("sportal_game_state", { game: "1" })

      assert.strictEqual(gameState, 3)
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect("should gauge a stale game's state again when it is taken again", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(home("10:00"))
      yield* TestClock.adjust("90 seconds")

      yield* takenSnapshot(home("9:00"))
      const gameState = yield* gauged("sportal_game_state", { game: "1" })

      assert.strictEqual(gameState, 2)
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect("should gauge a game's state as 0 once it leaves the slate", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(home("10:00"))
      yield* TestClock.adjust("90 seconds")
      yield* takenSnapshot(home("9:00"))

      yield* takenSnapshot(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
      const gameState = yield* gauged("sportal_game_state", { game: "1" })

      assert.strictEqual(gameState, 0)
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect("should time a stale stretch when the game is taken again", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(home("10:00"))
      yield* TestClock.adjust("120 seconds")

      yield* takenSnapshot(home("9:00"))
      const metrics = yield* Metric.snapshot
      const stale = metrics.find((metric) => metric.id === "sportal_stale_duration")

      assert.deepStrictEqual(
        stale?.type === "Histogram" ? [stale.state.count, stale.state.sum] : undefined,
        [1, 120_000]
      )
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect("should log a game event at Info with the game's annotations, count it, and publish it", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      const slate = yield* LiveSlate
      const events = yield* slate.events.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true })
      )
      yield* takenSnapshot(home("10:00"))
      const scoredSnapshot = snapshot({
        id: one,
        status: "live",
        period: 1,
        clock: "9:00",
        home: { team: team("HOME"), score: 7 }
      })

      yield* takenSnapshot(scoredSnapshot)
      const scored = logs.filter(({ message }) => message.includes("ScoreChanged"))
      const scoreChanged = yield* counted("sportal_game_events", { game: "1", event: "ScoreChanged" })
      const published = yield* Fiber.join(events)
      const said = published.map(({ game, what }) => [game, what._tag])

      assert.strictEqual(scored.length, 1)
      assert.strictEqual(scored[0]?.level, "Info")
      assert.include(scored[0]?.message, "LiveSlate: AWAY at HOME: ScoreChanged HOME at live, period 1, 9:00")
      assert.include(scored[0]?.annotations, {
        game: "1",
        matchup: "AWAY at HOME",
        event: "ScoreChanged",
        points: 7
      })
      assert.strictEqual(scoreChanged, 1)
      assert.deepStrictEqual(said, [[one, "ScoreChanged"]])
    }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
  })

  it.effect("should count snapshots by the feed they came from", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      yield* takenSnapshot(snapshot({ id: one, status: "live", period: 2, clock: "4:12" }), "push")
      yield* takenSnapshot(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }), "poll")
      const taken = yield* counted("sportal_snapshots", { outcome: "taken", source: "push" })
      const behind = yield* counted("sportal_snapshots", { outcome: "behind", source: "poll" })

      assert.strictEqual(taken, 1)
      assert.strictEqual(behind, 1)
      assert.isTrue(logs.some(({ message }) => message.includes("taken push live, period 2, 4:12")))
      assert.isTrue(logs.some(({ message }) => message.includes("behind poll live, period 2, 5:00")))
    }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
  })

  it.effect(
    "should count a poll with fewer points at the same game time after a pushed try as behind",
    () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        yield* takenSnapshot(withHomeScore(13), "poll")
        yield* takenSnapshot(withHomeScore(14), "push")

        yield* takenSnapshot(withHomeScore(13), "poll")
        const liveGame = yield* gameOf(one)
        const behindPolls = yield* counted("sportal_snapshots", { outcome: "behind", source: "poll" })
        const takenPushes = yield* counted("sportal_snapshots", { outcome: "taken", source: "push" })
        const takenPolls = yield* counted("sportal_snapshots", { outcome: "taken", source: "poll" })

        assert.strictEqual(liveGame.snapshot.home.score, 14)
        assert.strictEqual(behindPolls, 1)
        assert.strictEqual(takenPushes, 1)
        assert.strictEqual(takenPolls, 1)
        assert.isTrue(logs.some(({ message }) => message.includes("behind poll live, period 2, 4:12")))
      }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
    }
  )

  it.effect("should log a defect with its frame and the snapshot that raised it, and count it", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      yield* takenSnapshot(home("9:00"))

      yield* takenSnapshot(broken(one))
      const errors = logs.filter(({ level }) => level === "Error")
      const defects = yield* counted("sportal_game_defects")

      assert.strictEqual(errors.length, 1)
      assert.include(JSON.stringify(errors[0]?.annotations.snapshot), '"clock":"8:00"')
      assert.include(errors[0]?.annotations, { game: "1", seq: 2 })
      assert.strictEqual(defects, 1)
    }).pipe(
      Effect.provide(slateFollowing([], { decoder: breaking }).pipe(Layer.provideMerge(layer))),
      withMetrics
    )
  })

  it.effect("should span and time each frame taken live", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* takenSnapshot(home("10:00"))
      // `through` answers once the state has the frame, which can be before the span around it ends.
      const take = yield* Effect.yieldNow.pipe(
        Effect.andThen(Effect.sync(() => ended.find((span) => span.name === "LiveSlate.take"))),
        Effect.repeat({ until: (span) => span !== undefined, times: 100 })
      )
      const metrics = yield* Metric.snapshot
      const duration = metrics.find((metric) => metric.id === "sportal_take_duration")

      assert.isDefined(take, "the take's span ended")
      assert.strictEqual(take?.attributes.get("sportal.seq"), 1)
      assert.strictEqual(take?.attributes.get("sportal.deliveries"), 1)
      assert.strictEqual(duration?.type === "Histogram" ? duration.state.count : undefined, 1)
    }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(recordingSpans(ended)))), withMetrics)
  })

  it.effect("should count live games by state", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now

      yield* takenSnapshot(home("10:00"))
      yield* takenSnapshot(snapshot({ id: two, status: "live", period: 3, clock: "1:00" }))
      yield* takenSnapshot(snapshot({ id: three, kickoff: DateTime.add(now, { minutes: 5 }) }))
      const live = yield* gauged("sportal_live_games", { state: "Live" })
      const upcoming = yield* gauged("sportal_live_games", { state: "Upcoming" })
      const stale = yield* gauged("sportal_live_games", { state: "Stale" })

      assert.strictEqual(live, 2)
      assert.strictEqual(upcoming, 1)
      assert.strictEqual(stale, 0)
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect("should log a live game's start at Info and its stop once final at Debug", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      yield* takenSnapshot(home("1:00"))
      yield* takenSnapshot(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
      const lifecycle = logs.filter(({ message }) => /started|stopped/.test(message))
      const levels = lifecycle.map(({ level, message }) => [
        level,
        /started/.test(message) ? "started" : "stopped"
      ])

      assert.deepStrictEqual(levels, [
        ["Info", "started"],
        ["Debug", "stopped"]
      ])
      assert.include(lifecycle[1]?.message, "LiveSlate: AWAY at HOME: stopped, Over at final")
      assert.include(lifecycle[1]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
    }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))))
  })

  it.effect("should neither start nor stop a game that is never current", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      yield* takenSnapshot(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
      const gameState = yield* gauged("sportal_game_state", { game: "1" })

      assert.isFalse(logs.some(({ message }) => /started|stopped/.test(message)))
      assert.isUndefined(gameState)
    }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
  })

  it.effect("should log and count a defect in the timer", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      yield* takenSnapshot(home("10:00"))

      yield* TestClock.adjust("10 seconds")
      const errors = logs.filter(({ level }) => level === "Error")
      const defects = yield* counted("sportal_game_defects")

      assert.strictEqual(errors.length, 1)
      assert.strictEqual(defects, 1)
    }).pipe(Effect.provide(slateWithDyingTimer(layer)), withMetrics)
  })

  it.effect("should keep a game live at 89 seconds after a defect in the timer, with no new delivery", () => {
    const { layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      yield* takenSnapshot(home("10:00"))
      yield* TestClock.adjust("10 seconds")

      yield* TestClock.adjust("79 seconds")
      const liveGame = yield* gameOf(one)

      assert.strictEqual(liveGame.state, "Live")
    }).pipe(Effect.provide(slateWithDyingTimer(layer)), withMetrics)
  })

  it.effect(
    "should make a game stale at 90 seconds after a defect in the timer, with no new delivery and no new defect",
    () => {
      const { layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        yield* takenSnapshot(home("10:00"))
        yield* TestClock.adjust("10 seconds")
        yield* TestClock.adjust("79 seconds")

        yield* TestClock.adjust("1 second")
        const liveGame = yield* gameOf(one)
        const defects = yield* counted("sportal_game_defects")

        assert.strictEqual(liveGame.state, "Stale")
        assert.strictEqual(defects, 1)
      }).pipe(Effect.provide(slateWithDyingTimer(layer)), withMetrics)
    }
  )

  it.effect("should change nothing on a timer that wakes early until the game is due", () =>
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      yield* slate.changes.pipe(
        Stream.runForEach((current) =>
          Option.match(current.state(one), {
            onNone: () => Effect.void,
            onSome: (state) => Ref.update(seen, (states) => [...states, state])
          })
        ),
        Effect.forkScoped({ startImmediately: true })
      )

      yield* takenSnapshot(home("10:00"))
      yield* TestClock.adjust("90 seconds")
      const states = yield* Ref.get(seen)

      assert.deepStrictEqual(states, ["Live", "Stale"])
    }).pipe(
      Effect.provide(
        slateFollowing().pipe(
          Layer.provide(
            sleeping((duration, clock) =>
              clock.sleep(
                Duration.isGreaterThan(duration, Duration.millis(1))
                  ? Duration.subtract(duration, Duration.millis(1))
                  : duration
              )
            )
          )
        )
      )
    )
  )
})

describe("LiveSlate#published", () => {
  it.effect("should keep the listing's order, leagues in their order", () =>
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      yield* listing("fbs", [
        liveSnapshot({ id: three }),
        liveSnapshot({ id: one }),
        liveSnapshot({ id: two })
      ])
      yield* listing("nfl", [snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })])

      yield* TestClock.adjust("250 millis")
      const published = yield* slate.published
      const ids = published.games.map((listed) => listed.id)

      assert.deepStrictEqual(ids, ["9", "3", "1", "2"])
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should publish a live game's snapshot over its listing's", () =>
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      yield* listing("fbs", [liveSnapshot({ id: one, period: 1 })])
      yield* push(liveSnapshot({ id: one, period: 2 }))

      yield* TestClock.adjust("250 millis")
      const published = yield* slate.published

      assert.strictEqual(published.games[0]?.period, 2)
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should carry each listed game's plays beside it", () =>
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      const recordedPlay = play({ id: PlayId.make("p1"), sequence: 1 })
      yield* listing("fbs", [liveSnapshot({ id: one })])
      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [recordedPlay] }))

      yield* TestClock.adjust("250 millis")
      const { games, recentPlays } = yield* slate.published
      const ids = games.map((listed) => listed.id)

      assert.deepStrictEqual(ids, [one])
      assert.deepStrictEqual(recentPlays, { [one]: [recordedPlay] })
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should publish a burst of changes once", () =>
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      const published = yield* Ref.make<ReadonlyArray<number>>([])
      yield* slate.publishedChanges.pipe(
        Stream.runForEach((latest) => Ref.update(published, (all) => [...all, latest.games.length])),
        Effect.forkScoped
      )

      yield* listing("fbs", [
        liveSnapshot({ id: three }),
        liveSnapshot({ id: one }),
        liveSnapshot({ id: two })
      ])
      yield* push(liveSnapshot({ id: three, period: 2 }))
      yield* push(liveSnapshot({ id: one, period: 2 }))
      yield* TestClock.adjust("250 millis")
      const lengths = yield* Ref.get(published)
      const nonEmpty = lengths.filter((length) => length > 0)

      assert.deepStrictEqual(nonEmpty, [3])
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should list a game the slate does not hold as listed", () =>
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      const final = snapshot({ id: one, status: "final" })
      yield* listing("fbs", [final])

      yield* TestClock.adjust("250 millis")
      const current = yield* slate.latest
      const published = yield* slate.published

      assert.isFalse(current.games.has(one))
      assert.deepStrictEqual(published.games, [final])
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("should leave off a game no listing has", () =>
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      yield* listing("fbs", [liveSnapshot({ id: one })])
      yield* push(liveSnapshot({ id: GameId.make("9") }))

      yield* TestClock.adjust("250 millis")
      const published = yield* slate.published
      const ids = published.games.map((listed) => listed.id)

      assert.deepStrictEqual(ids, ["1"])
    }).pipe(Effect.provide(slateFollowing()))
  )
})

describe("LiveSlate following the feed log", () => {
  it.effect(
    "should take every logged frame before the build returns, quietly, then log one summary line and set each game's gauges",
    () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        const current = yield* latest
        const metrics = yield* Metric.snapshot
        const transitions = yield* counted("sportal_transitions")
        const gameState = yield* gauged("sportal_game_state", {
          game: "1",
          league: "fbs",
          matchup: "AWAY at HOME"
        })
        const liveGames = yield* gauged("sportal_live_games", { state: "Live" })
        const staleGames = yield* gauged("sportal_live_games", { state: "Stale" })
        const info = logs.filter(({ level }) => level === "Info")
        const perGameNotGauges = metrics
          .filter(({ attributes, type }) => attributes?.game !== undefined && type !== "Gauge")
          .map(({ id }) => id)

        assert.deepStrictEqual(current.seq, Option.some(3))
        assert.strictEqual(current.plays.get(one)?.length, 1)
        assert.strictEqual(current.games.get(one)?.clock, "9:00")
        assert.isFalse(logs.some(({ message }) => /→|started|ScoreChanged|Played/.test(message)))
        assert.strictEqual(info.length, 1)
        assert.include(
          info[0]?.message,
          "LiveSlate: replayed 3 frames: 3 deliveries, 1 plays; 1 live games, in "
        )
        assert.deepStrictEqual(perGameNotGauges, [])
        assert.isUndefined(transitions)
        assert.strictEqual(gameState, 2)
        assert.strictEqual(liveGames, 1)
        assert.strictEqual(staleGames, 0)
      }).pipe(
        Effect.provide(
          slateFollowing([
            ...liveThenPlayed,
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

  it.effect("should span the replay once, with the frames and deliveries it took", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* LiveSlate
      const replay = ended.find((span) => span.name === "LiveSlate.replay")
      const take = ended.find((span) => span.name === "LiveSlate.take")

      assert.strictEqual(replay?.attributes.get("sportal.frames"), 3)
      assert.strictEqual(replay?.attributes.get("sportal.deliveries"), 2)
      assert.isUndefined(take)
    }).pipe(
      Effect.provide(
        slateFollowing([
          framed(Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "poll" }), start),
          framed(Delivery.cases.Plays.make({ game: one, plays: [play()] }), start),
          new Frame({ ...framed(Delivery.cases.Plays.make({ game: one, plays: [] }), start), body: "{" })
        ]).pipe(Layer.provideMerge(recordingSpans(ended)))
      )
    )
  })

  it.effect("should replay at the recorded times, so plays reach a game no tick has let go", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* TestClock.adjust("1 hour")

      yield* latestOf(slateFollowing(liveThenPlayed).pipe(Layer.provideMerge(layer)))
      const summary = logs.find(({ message }) => message.includes("replayed"))

      assert.include(summary?.message, "1 plays", "the plays reached a game no tick had let go")
    })
  })

  it.effect("should start the timer only once the replay is done", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 hour")

      const current = yield* TestClock.adjust(0).pipe(
        Effect.andThen(latest),
        Effect.provide(slateFollowing(liveThenPlayed))
      )

      assert.isFalse(current.games.has(one))
    })
  )

  it.effect("should tell no events of replayed frames", () =>
    Effect.gen(function* () {
      yield* latestOf(slateFollowing(day))
      const plays = yield* counted("sportal_plays")
      const events = yield* counted("sportal_game_events")

      assert.isUndefined(plays)
      assert.isUndefined(events)
    }).pipe(withMetrics)
  )

  it.effect("should tell and publish the events of the same frames taken live", () =>
    Effect.gen(function* () {
      const taken = yield* eventsWhile(takenInTime(day))
      const plays = yield* counted("sportal_plays")
      const said = taken.map(({ game, what }) => [game, what._tag])

      assert.deepStrictEqual(said, [
        [one, "Played"],
        [one, "ScoreChanged"],
        [one, "Played"]
      ])
      assert.strictEqual(plays, 2)
    }).pipe(withMetrics)
  )

  it.effect("should give the same live games replaying frames as taking them in time", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      const replayed = yield* latestOf(slateFollowing(day))
      const taken = yield* takenInTime(day).pipe(Effect.andThen(latest), Effect.provide(slateFollowing()))
      const summary = logs.find(({ message }) => message.includes("replayed"))

      assert.isTrue(Equal.equals(replayed.games, taken.games))
      assert.isTrue(Equal.equals(replayed.plays, taken.plays))
      assert.isTrue(Equal.equals(replayed.acknowledged, taken.acknowledged))
      assert.deepStrictEqual(replayed.seq, taken.seq)
      assert.deepStrictEqual(taken.state(one), Option.some("Live"))
      assert.isTrue(logs.some(({ message }) => message.includes("Live → Stale")))
      assert.include(summary?.message, "replayed 5 frames: 5 deliveries, 2 plays; 1 live games")
    }).pipe(Effect.provide(layer))
  })

  it.effect("should take a frame appended as the replay ends after it, and tell it", () =>
    Effect.gen(function* () {
      const first = yield* pushed(
        Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one, period: 2 }), from: "push" }),
        "fbs"
      )

      const current = yield* LiveSlate.use((slate) => slate.through(2)).pipe(
        Effect.provide(slateOn(appendingAtEnd([first]), TestSnapshotFeed.layerDecoder))
      )
      const taken = yield* counted("sportal_snapshots", { outcome: "taken" })

      assert.strictEqual(current.games.get(one)?.period, 3)
      assert.strictEqual(taken, 1)
    }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer]), withMetrics)
  )

  it.effect(
    "should wait for the last replayed frame before the build returns, with a decode that reads ahead",
    () =>
      Effect.gen(function* () {
        const frames = yield* periodsPushed

        const built = yield* buildingInPairs.pipe(
          Effect.map((building) => building.pollUnsafe()),
          Effect.scoped,
          Effect.provide(FeedLog.layerTest(frames))
        )

        assert.isUndefined(built, "the build waits for the last replayed frame")
      }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer]))
  )

  it.effect(
    "should take replayed frames quietly with a decode that reads ahead, and the next frame live",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const frames = yield* periodsPushed
        const fourth = yield* pushed(
          Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one, period: 4 }), from: "push" }),
          "fbs"
        )

        const current = yield* inPairsThen(frames, fourth)
        const summary = logs.find(({ message }) => message.includes("replayed"))
        const taken = yield* counted("sportal_snapshots", { outcome: "taken" })

        assert.strictEqual(current.games.get(one)?.period, 4)
        assert.include(summary?.message, "replayed 3 frames")
        assert.strictEqual(taken, 1)
      }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer, layer]), withMetrics)
    }
  )

  it.effect("should tell no decode observation from a replayed frame", () =>
    Effect.gen(function* () {
      const undecoded = yield* counted("sportal_frames_undecoded")

      assert.isUndefined(undecoded)
    }).pipe(
      Effect.provide(slateFollowingFramesFrom(Effect.map(undecodable, (frame) => [frame]))),
      withMetrics
    )
  )

  it.effect("should tell the same decode observation from a frame after the replay", () =>
    Effect.gen(function* () {
      const frame = yield* undecodable

      yield* appended(frame)
      const undecoded = yield* counted("sportal_frames_undecoded", { source: "push" })

      assert.strictEqual(undecoded, 1)
    }).pipe(
      Effect.provide(slateFollowingFramesFrom(Effect.map(undecodable, (frame) => [frame]))),
      withMetrics
    )
  )

  it.effect("should neither count nor log ESPN's observations on replayed frames", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      const counts = yield* countsOf(decodeCounters)
      const decodeLogs = logs.filter(({ message }) => message.includes("Decode:"))

      for (const [counter, count] of counts) assert.isUndefined(count, counter)
      assert.deepStrictEqual(decodeLogs, [])
    }).pipe(
      Effect.provide(
        slateFollowingFramesFrom(Effect.all(noticeable), { decoder: EspnDecoder.layer }).pipe(
          Layer.provideMerge(layer)
        )
      ),
      withMetrics
    )
  })

  it.effect("should count and log the same observations on frames after the replay", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      const feedLog = yield* FeedLog
      const slate = yield* LiveSlate
      const frames = yield* Effect.all(noticeable)

      const appendedFrames = yield* Effect.forEach(frames, feedLog.append)
      yield* slate.through(appendedFrames.at(-1)?.seq ?? 0)
      const undecoded = yield* counted("sportal_frames_undecoded", { source: "poll" })
      const games = yield* counted("sportal_live_feed_games", { league: "nfl" })
      const unlisted = yield* counted("sportal_live_feed_unlisted", { league: "nfl" })
      const messages = yield* counted("sportal_live_feed_messages", { league: "nfl", op: "P" })
      const resets = yield* counted("sportal_live_feed_document_resets", { league: "nfl", reason: "Gap" })
      const waits = logs.filter(
        ({ level, message }) => level === "Warn" && message.includes("waits for its next checkpoint")
      )

      assert.strictEqual(undecoded, 1)
      assert.strictEqual(games, 16)
      assert.strictEqual(unlisted, 16)
      assert.strictEqual(messages, 1)
      assert.strictEqual(resets, 1)
      assert.strictEqual(waits.length, 1)
      assert.isTrue(logs.some(({ level, message }) => level === "Error" && message.includes("Decode:")))
    }).pipe(
      Effect.provide(slateFollowing([], { decoder: EspnDecoder.layer }).pipe(Layer.provideMerge(layer))),
      withMetrics
    )
  })

  it.effect("should keep the decoder's state from the replayed frames for the first live frame", () =>
    Effect.gen(function* () {
      const resync = yield* pushed({ _tag: "Resync" }, "fbs")

      const current = yield* appended(resync)
      const scores = [...current.games.values()].map((held) => held.home.score)

      assert.deepStrictEqual(scores, [3])
    }).pipe(
      Effect.provide(
        slateFollowingFramesFrom(
          Effect.all([pushed({ _tag: "Resync" }, "fbs"), pushed({ _tag: "Resync" }, "fbs")]),
          {
            decoder: counting
          }
        )
      )
    )
  )

  it.effect("should fail the build on a decode that dies during the replay", () =>
    Effect.gen(function* () {
      const built = yield* Layer.build(
        slateFollowingFramesFrom(
          Effect.map(dyingFrame, (frame) => [frame]),
          { decoder: dyingDecoder }
        )
      ).pipe(Effect.scoped, Effect.exit)

      assert.isTrue(Exit.hasDies(built))
    })
  )

  it.effect("should log nothing at Error from the slate when a decode dies during replay", () => {
    const { logs, layer } = recordingLogs("Debug")
    return Effect.gen(function* () {
      yield* Layer.build(
        slateFollowingFramesFrom(
          Effect.map(dyingFrame, (frame) => [frame]),
          { decoder: dyingDecoder }
        ).pipe(Layer.provideMerge(layer))
      ).pipe(Effect.scoped, Effect.exit)

      const errors = logs.filter(({ level, message }) => level === "Error" && message.includes("LiveSlate:"))

      assert.deepStrictEqual(errors, [])
    })
  })

  describe("the game day", () => {
    it.effect("should start the replay at yesterday's 04:00 before 04:00", () =>
      Effect.gen(function* () {
        const frames = yield* replayedAt("2026-10-04T03:59:00")

        assert.strictEqual(frames, 2)
      })
    )

    it.effect.each(["2026-10-04T04:00:00", "2026-10-04T23:59:00"])(
      "should start the replay at today's 04:00 from 04:00, at %s",
      (chicago) =>
        Effect.gen(function* () {
          const frames = yield* replayedAt(chicago)

          assert.strictEqual(frames, 1)
        })
    )
  })
})

describe("LiveSlate, a covered game's fallback", () => {
  it.effect("should hold a live poll ahead of a covered game", () =>
    Effect.gen(function* () {
      yield* push(liveSnapshot({ id: one, clock: "5:00" }))

      yield* listing("fbs", [aheadOfCovered])
      const { state } = yield* gameOf(one)
      const fallbacks = yield* counted("sportal_poll_fallbacks")

      assert.strictEqual(state, "Holding")
      assert.isUndefined(fallbacks)
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect("should fall back to the held poll at fallbackAfter, logged and counted by league", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* push(liveSnapshot({ id: one, clock: "5:00" }))
      yield* listing("fbs", [aheadOfCovered])

      yield* TestClock.adjust(Acknowledgement.fallbackAfter)
      const liveGame = yield* gameOf(one)
      const fallbacks = yield* counted("sportal_poll_fallbacks", { league: "fbs" })
      const info = logs.filter(({ level }) => level === "Info").map(({ message }) => message)

      assert.strictEqual(liveGame.snapshot.home.score, 7)
      assert.strictEqual(fallbacks, 1)
      assert.isTrue(info.some((message) => message.includes("held poll live, period 1, 4:30")))
      assert.isTrue(info.some((message) => message.includes("fellBack poll live, period 1, 4:30")))
      assert.isTrue(info.some((message) => message.includes("ScoreChanged")))
      assert.isFalse(logs.some(({ level }) => level === "Error"))
    }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
  })
})

describe("LiveSlate, a recorded game", () => {
  it.effect(
    "should replay through decode and the slate to NE at BUF final, with every play the recording has, and nothing failed",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const current = yield* latest
        const counts = yield* countsOf([
          "sportal_frames_undecoded",
          "sportal_events_undecoded",
          "sportal_live_feed_undecoded_plays",
          "sportal_live_feed_document_resets",
          "sportal_game_defects"
        ])
        const listed = current.listed.get("nfl")?.find((game) => game.id === neAtBuf)
        const summary = logs.find(({ message }) => message.includes("replayed"))
        const errors = logs.filter(({ level }) => level === "Error")

        assert.strictEqual(listed?.status, "final")
        assert.isFalse(current.games.has(neAtBuf), "a final game is let go")
        assert.include(summary?.message, ` ${recordedPlays} plays`)
        for (const [counter, count] of counts) assert.isUndefined(count, counter)
        assert.deepStrictEqual(errors, [])
      }).pipe(
        Effect.provide(
          slateFollowingFramesFrom(recordedNeAtBuf, { decoder: EspnDecoder.layer }).pipe(
            Layer.provideMerge(layer)
          )
        ),
        withMetrics
      )
    },
    { timeout: 60_000 }
  )

  it.effect(
    "should take the same replayed as taken live, and the same twice: the same live games, and the same events",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const frames = yield* recordedNeAtBuf
        // A few points through the day, each replayed from the frames before it, while the clock is still at its start.
        const points = [
          1,
          Math.floor(frames.length / 4),
          Math.floor(frames.length / 2),
          Math.floor((frames.length * 3) / 4)
        ]

        const first = yield* replayed(frames)
        const second = yield* replayed(frames)
        const replayedTo = yield* Effect.forEach(points, (point) => replayed(frames.slice(0, point)))
        const once = yield* takenLive(frames, points)
        const again = yield* takenLive(frames)
        const played = once.events.filter(({ what }) => GameEventKind.$is("Played")(what)).length
        const summary = logs.find(({ message }) => message.includes("replayed"))

        assert.isTrue(Equal.equals(first, second))
        points.forEach((point, index) => {
          const live = once.sampled.get(point)
          assert.isTrue(
            Equal.equals(replayedTo[index]?.games, live?.games),
            `the live games after ${point} frames`
          )
          assert.isTrue(
            Equal.equals(replayedTo[index]?.plays, live?.plays),
            `their plays after ${point} frames`
          )
          assert.isTrue(
            Equal.equals(replayedTo[index]?.acknowledged, live?.acknowledged),
            `their acknowledgements after ${point} frames`
          )
          assert.isTrue(
            Equal.equals(replayedTo[index]?.listed, live?.listed),
            `the listings after ${point} frames`
          )
        })
        assert.isTrue(
          Equal.equals(first.games, once.latest.games),
          "replay ends with the live games live did"
        )
        assert.isTrue(Equal.equals(first.plays, once.latest.plays), "and their plays")
        assert.isTrue(
          Equal.equals(first.acknowledged, once.latest.acknowledged),
          "and their acknowledgements"
        )
        assert.isTrue(Equal.equals(first.listed, once.latest.listed), "and the listings")
        assert.isTrue(Equal.equals(once.held, again.held))
        assert.isTrue(Equal.equals(once.events, again.events))
        assert.strictEqual(played, recordedPlays, "each play is played once")
        assert.include(summary?.message, ` ${played} plays`, "and the replay took each play live did")
      }).pipe(Effect.provide(layer))
    },
    // The recorded day five and a half times over, two of them live: well over a minute beside the rest of the suite.
    { timeout: 120_000 }
  )

  it.effect(
    "should take every play its topic's patches add, replayed from after the topic's checkpoint",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const frames = yield* recordedNeAtBuf
        // The game day starts after the topic's checkpoint (16:44:55Z) and before the first play's patch (17:02:42Z),
        // as it falls for a socket subscribed the night before: 04:00 in a zone 12:56:40 behind UTC is 16:56:40Z.
        const zone = DateTime.zoneMakeOffset(-((12 * 60 + 56) * 60 + 40) * 1000)
        yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-04T20:00:00Z")))

        yield* latestOf(slateFollowing(frames, { decoder: EspnDecoder.layer, zone }))
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
    "should come back the same after a restart halfway through the day",
    () =>
      Effect.gen(function* () {
        const all = yield* recordedNeAtBuf
        const half = Math.floor(all.length / 2)
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const feedFile = Database.layerFile("feed.sqlite").pipe(
          Layer.provide(HubConfig.layerTest({ SPORTAL_DATA_DIR: dir }))
        )
        const onDisk = Layer.merge(feedFile, NodeCrypto.layer)

        // Half the day logged and followed, then every layer closed; reopened on the same file, the rest logged, and
        // the whole log followed, as a Hub starting again would.
        const before = yield* latestOf(
          slateOn(FeedLog.layerTest(all.slice(0, half)), EspnDecoder.layer)
        ).pipe(Effect.provide(onDisk))
        const after = yield* latestOf(slateOn(FeedLog.layerTest(all.slice(half)), EspnDecoder.layer)).pipe(
          Effect.provide(onDisk)
        )
        const uninterrupted = yield* replayed(all)
        const halfway = yield* replayed(all.slice(0, half))

        assert.isTrue(Equal.equals(after, uninterrupted))
        assert.deepStrictEqual(before.seq, Option.some(half))
        assert.isTrue(
          Equal.equals(before, halfway),
          "before the restart, as the uninterrupted log was at that point"
        )
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 }
  )
})

/** The slate's latest. */
const latest = LiveSlate.use((slate) => slate.latest)

function listing(league: "nfl" | "fbs", games: ReadonlyArray<GameSnapshot>) {
  return delivered(Delivery.cases.Listing.make({ league, games }))
}

function push(snapshot: GameSnapshot) {
  return delivered(Delivery.cases.Snapshot.make({ snapshot, from: "push" }))
}

function takenSnapshot(snapshot: GameSnapshot, from: "push" | "poll" = "poll") {
  return delivered(Delivery.cases.Snapshot.make({ snapshot, from }))
}

const liveNow = Effect.map(latest, ({ games }) => games)

/** Game `id` as the latest slate holds it, with its state at the instant the slate has ticked to. */
function gameOf(id: GameId) {
  return latest.pipe(
    Effect.flatMap((slate) => Effect.fromOption(heldIn(slate, id))),
    Effect.orDie
  )
}

/** Game `id` as `slate` holds it: its snapshot, acknowledgement and plays, and its state at `reached`. */
function heldIn(slate: Slate, id: GameId) {
  return Option.all({
    snapshot: Option.fromNullishOr(slate.games.get(id)),
    acknowledgement: Option.fromNullishOr(slate.acknowledged.get(id)),
    plays: Option.fromNullishOr(slate.plays.get(id)),
    state: slate.state(id)
  })
}

/** Game one live at 9:00 and game two live at 9:00 in the second period, taken; gives game one's snapshot. */
const twoLiveGames = Effect.gen(function* () {
  const first = liveSnapshot({ id: one, clock: "9:00" })
  yield* takenSnapshot(first)
  yield* takenSnapshot(snapshot({ id: two, status: "live", period: 2, clock: "9:00" }))
  return first
})

/** A listing of game one broken and game two at 8:00, which `breaking` reads with a defect in game one. */
const brokenListing = listing("fbs", [
  broken(one),
  snapshot({ id: two, status: "live", period: 2, clock: "8:00" })
])

/** A live snapshot of game `id` at 8:00 in the first period, at home to BRK, which `breaking` reads as broken. */
function broken(id: GameId): GameSnapshot {
  return liveSnapshot({ id, clock: "8:00", home: { team: team("BRK"), score: 0 } })
}

/**
 * The snapshot feed's decode, reading each snapshot at home to BRK as one whose events raise a defect, since a snapshot
 * that does so cannot cross the feed log.
 */
const breaking = Layer.effect(
  Decoder,
  Effect.map(Decoder, (decoder) =>
    Decoder.of({
      decode: (frames) =>
        decoder
          .decode(frames)
          .pipe(
            Stream.map((decoded) => new Decoded({ ...decoded, deliveries: decoded.deliveries.map(brokenIn) }))
          )
    })
  )
).pipe(Layer.provide(TestSnapshotFeed.layerDecoder))

function brokenIn(delivery: Delivery): Delivery {
  return Delivery.match(delivery, {
    Listing: ({ league, games }): Delivery =>
      Delivery.cases.Listing.make({ league, games: games.map(brokenIfMarked) }),
    Snapshot: ({ snapshot, from }): Delivery =>
      Delivery.cases.Snapshot.make({ snapshot: brokenIfMarked(snapshot), from }),
    Plays: (plays): Delivery => plays
  })
}

function brokenIfMarked(snapshot: GameSnapshot): GameSnapshot {
  class Broken extends GameSnapshot {
    override eventsSince(): never {
      throw new Error("a broken snapshot")
    }
  }
  return snapshot.home.team.abbreviation === "BRK" ? new Broken({ ...snapshot }) : snapshot
}

/** A snapshot feed frame, received now, whose body does not decode. */
const undecodable = Effect.map(
  pushed({ _tag: "Resync" }, "fbs"),
  (frame) => new Frame({ ...frame, kind: "whole", body: "not json" })
)

/** The snapshot feed's decode, which dies at a frame whose body is `"die"`. */
const dyingDecoder = Decoder.layerTestDying("die").pipe(Layer.provide(TestSnapshotFeed.layerDecoder))

/** A snapshot feed frame, received now, whose decode `dyingDecoder` dies on. */
const dyingFrame = Effect.map(
  pushed({ _tag: "Resync" }, "x"),
  (frame) => new Frame({ ...frame, body: "die" })
)

/** Game one taken live, then taken again at 9:00 a minute later. */
const refreshedAfterAMinute = Effect.gen(function* () {
  yield* takenSnapshot(liveSnapshot({ id: one }))
  yield* TestClock.adjust("60 seconds")
  yield* takenSnapshot(liveSnapshot({ id: one, clock: "9:00" }))
})

/** Plays of game two in a frame received 100 seconds on, whose telling dies under `slateDyingOnStale`. */
const tellingDies = Effect.gen(function* () {
  const now = yield* DateTime.now
  return yield* delivered(
    Delivery.cases.Plays.make({ game: two, plays: [play()] }),
    DateTime.add(now, { seconds: 100 })
  )
})

/** The slate, with `logs` and a logger that dies the first time it is told a game went stale. */
function slateDyingOnStale(logs: Layer.Layer<never>) {
  return slateFollowing().pipe(Layer.provideMerge(dyingOnce("Live → Stale").pipe(Layer.provideMerge(logs))))
}

/** Beside the default logger, one that throws the first time it is given a message containing `text`. */
function dyingOnce(text: string) {
  const thrown: Array<string> = []
  return Logger.layer(
    [
      Logger.make(({ message }) => {
        if (thrown.length === 0 && JSON.stringify(message).includes(text)) {
          thrown.push(text)
          throw new Error(`the logger died on ${text}`)
        }
      })
    ],
    { mergeWithExisting: true }
  )
}

/** Game one live in the first period at `clock`, at home to HOME. */
function home(clock: string) {
  return snapshot({ id: one, status: "live", period: 1, clock, home: { team: team("HOME"), score: 0 } })
}

/** Game one live in the second period at 4:12, with `score` for HOME. */
function withHomeScore(score: number) {
  return snapshot({ id: one, status: "live", period: 2, clock: "4:12", home: { team: team("HOME"), score } })
}

/** The slate, with `logs`, on the test clock, whose first 90-second sleep dies. */
function slateWithDyingTimer(logs: Layer.Layer<never>) {
  return slateFollowing().pipe(
    Layer.provide(
      sleeping((duration, clock, earlier) =>
        earlier === 0 && Duration.equals(duration, Duration.seconds(90))
          ? Effect.die(new Error("the timer's sleep died"))
          : clock.sleep(duration)
      )
    ),
    Layer.provideMerge(logs)
  )
}

/** The test clock, with each sleep made by `sleep`, which is told how many sleeps as long came before. */
function sleeping(
  sleep: (duration: Duration.Duration, clock: Clock.Clock, earlier: number) => Effect.Effect<void>
) {
  return Layer.effect(
    Clock.Clock,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const sleeps = yield* Ref.make<ReadonlyArray<Duration.Duration>>([])
      return {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe()),
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe()),
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: Effect.sync(() => clock.monotonicTimeNanosUnsafe()),
        sleep: (input) => {
          const duration = Duration.fromInputUnsafe(input)
          return Ref.getAndUpdate(sleeps, (all) => [...all, duration]).pipe(
            Effect.flatMap((earlier) =>
              sleep(duration, clock, earlier.filter((other) => Duration.equals(other, duration)).length)
            )
          )
        }
      } satisfies Clock.Clock
    })
  )
}

// The test clock's start, where the frames these tests log are received from.
const start = DateTime.makeUnsafe(0)

/** Game one's snapshot at the test clock's start, then its play ten seconds later. */
const liveThenPlayed = [
  framed(Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "poll" }), start),
  framed(Delivery.cases.Plays.make({ game: one, plays: [play()] }), DateTime.add(start, { seconds: 10 }))
]

/**
 * Five frames of game one from the test clock's start: a snapshot, a play, a stale stretch, a score with a second play,
 * and a last snapshot.
 */
const day = (() => {
  const scored = (clock: string) =>
    snapshot({ id: one, status: "live", period: 1, clock, home: { team: team("HOME"), score: 7 } })
  const second = play({ id: PlayId.make("2"), sequence: 2, clock: "14:30" })
  return [
    ...liveThenPlayed,
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

/** The feed log with `frames` logged, whose replay appends a frame of game one in the third period as it ends. */
function appendingAtEnd(frames: ReadonlyArray<Frame>) {
  return Layer.effect(
    FeedLog,
    Effect.map(FeedLog, (log) =>
      FeedLog.of({
        ...log,
        // Appended as the replay ends, so it is in the log before decoding reaches the end of the replay.
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
  ).pipe(Layer.provide(FeedLog.layerTest(frames)))
}

/** Game one pushed in the first, second, and third periods, received now. */
const periodsPushed = Effect.forEach([1, 2, 3], (period) =>
  pushed(Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one, period }), from: "push" }), "fbs")
)

/** The slate built over the feed log, read by `inPairs`, in a fiber of its own, once 50 ms of real time have passed. */
const buildingInPairs = Effect.gen(function* () {
  const building = yield* Layer.build(
    LiveSlate.layer.pipe(Layer.provide([inPairs, DateTime.layerCurrentZoneLocal]))
  ).pipe(Effect.forkScoped)
  // The pairing decode holds frame 3 until a frame after it is appended, so the build cannot end before then.
  yield* TestClock.withLive(Effect.sleep("50 millis"))
  return building
})

/**
 * The slate built as `buildingInPairs` builds it over `logged`, with `frame` appended while it waits, once it has taken
 * the frame.
 */
function inPairsThen(logged: ReadonlyArray<Frame>, frame: Frame) {
  return Effect.gen(function* () {
    const feedLog = yield* FeedLog
    const building = yield* buildingInPairs
    const appended = yield* feedLog.append(frame)
    const built = yield* Fiber.join(building)
    const slate = Context.get(built, LiveSlate)
    return yield* slate.through(appended.seq)
  }).pipe(Effect.scoped, Effect.provide(FeedLog.layerTest(logged)))
}

/** The snapshot feed's decode, handing on what frames said two at a time, so it reads a frame ahead of the last it gave. */
const inPairs = Layer.effect(
  Decoder,
  Effect.map(Decoder, (decoder) =>
    Decoder.of({ decode: (frames) => decoder.decode(frames).pipe(Stream.grouped(2), Stream.flattenIterable) })
  )
).pipe(Layer.provide(TestSnapshotFeed.layerDecoder))

/** Each of `counters` with its count, if it has counted. */
function countsOf(counters: ReadonlyArray<string>) {
  return Effect.forEach(counters, (counter) =>
    Effect.map(counted(counter), (count) => [counter, count] as const)
  )
}

const decodeCounters = [
  "sportal_live_feed_messages",
  "sportal_live_feed_games",
  "sportal_events_undecoded",
  "sportal_live_feed_unlisted",
  "sportal_live_feed_document_resets",
  "sportal_frames_undecoded"
]

/**
 * Frames, received now, that ESPN's decode observations: a poll that does not decode, the recorded NFL scoreboard
 * checkpoint before any listing (sixteen games pushed and unlisted), and a game topic's checkpoint and then a message
 * after a gap.
 */
const noticeable: ReadonlyArray<Effect.Effect<Frame>> = (
  [
    { source: "poll", channel: "nfl", kind: "whole", body: "not json" },
    {
      source: "push",
      channel: "event-football-nfl",
      kind: "whole",
      number: 4286637,
      body: recordedCheckpoint()
    },
    {
      source: "push",
      channel: "gp-football-nfl-1",
      kind: "whole",
      number: 99,
      body: JSON.stringify({ entities: {} })
    },
    {
      source: "push",
      channel: "gp-football-nfl-1",
      kind: "change",
      number: 101,
      body: JSON.stringify({
        op: "P",
        tc: "gp-football-nfl-1",
        mid: 101,
        pl: JSON.stringify({ ts: 1, pl: [] })
      })
    }
  ] satisfies ReadonlyArray<Omit<Frame, "receivedAt">>
).map((frame) => Effect.map(DateTime.now, (receivedAt) => new Frame({ ...frame, receivedAt })))

/** ESPN's NFL FastCast scoreboard checkpoint of 2026-10-04 at 17:52Z (mid 4286637), as its checkpoint frame's body. */
function recordedCheckpoint() {
  return readFileSync(join(fixtures, "nfl-fastcast-checkpoint-2026-10-04T1752Z.json"), "utf8")
}

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

/**
 * How many frames the slate replays when the clock is at `chicago`, a wall-clock time in Chicago, over a log holding a
 * frame at each of 08:59Z and 09:00Z on 3 October and 09:00Z on 4 October; the replay reads from the game day's start
 * on.
 */
function replayedAt(chicago: string) {
  return Effect.gen(function* () {
    const ended: Array<Tracer.Span> = []
    const now = Option.getOrThrow(
      DateTime.makeZoned(chicago, { timeZone: "America/Chicago", adjustForTimeZone: true })
    )
    const frames = ["2026-10-03T08:59:00Z", "2026-10-03T09:00:00Z", "2026-10-04T09:00:00Z"].map((at) =>
      framed(
        Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one, period: 2 }), from: "poll" }),
        DateTime.makeUnsafe(at)
      )
    )
    yield* TestClock.setTime(DateTime.toEpochMillis(now))
    yield* latestOf(
      slateFollowing(frames, { zone: DateTime.zoneMakeNamedUnsafe("America/Chicago") }).pipe(
        Layer.provideMerge(recordingSpans(ended))
      )
    )
    return ended.find((span) => span.name === "LiveSlate.replay")?.attributes.get("sportal.frames")
  })
}

/** Game one at 4:30 with HOME on 7, as a poll ahead of a push at 5:00 has it. */
const aheadOfCovered = liveSnapshot({ id: one, clock: "4:30", home: { team: team("HOME"), score: 7 } })

/** A fresh slate's latest once it has replayed `frames`, decoded as ESPN. */
function replayed(frames: ReadonlyArray<Frame>) {
  return latestOf(slateFollowing(frames, { decoder: EspnDecoder.layer }))
}

/** Whether `game` is the very game `last` was: the same snapshot, acknowledgement and plays. */
function sameHeld(
  last: Option.Option.Value<ReturnType<typeof heldIn>> | undefined,
  game: Option.Option.Value<ReturnType<typeof heldIn>>
): boolean {
  return (
    last?.snapshot === game.snapshot &&
    last.acknowledgement === game.acknowledgement &&
    last.plays === game.plays
  )
}

/**
 * A fresh slate taking `frames` decoded as ESPN, each appended once the test clock reaches it, as live: their state
 * at the end and once each count of frames in `sampling` is taken, each live game NE at BUF was held as, in order, and
 * every event published. The clock is set to the first frame before the feed log opens, so its writer never wakes
 * through the years before it.
 */
function takenLive(frames: ReadonlyArray<Frame>, sampling: ReadonlyArray<number> = []) {
  const taking = Effect.gen(function* () {
    const slate = yield* LiveSlate
    const held = yield* Ref.make<ReadonlyArray<Option.Option.Value<ReturnType<typeof heldIn>>>>([])
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
          Effect.tap((current) =>
            sampling.includes(index + 1)
              ? Ref.update(sampled, (all) => new Map(all).set(index + 1, current))
              : Effect.void
          ),
          Effect.flatMap((current) =>
            Option.match(heldIn(current, neAtBuf), {
              onNone: () => Effect.void,
              onSome: (game) => Ref.update(held, (all) => (sameHeld(all.at(-1), game) ? all : [...all, game]))
            })
          )
        ),
      { discard: true }
    )
    yield* Effect.yieldNow
    yield* Fiber.interrupt(subscriber)
    const end = yield* slate.latest
    const samples = yield* Ref.get(sampled)
    const heldAs = yield* Ref.get(held)
    const published = yield* Ref.get(events)
    return { latest: end, sampled: samples, held: heldAs, events: published }
  }).pipe(Effect.provide(slateFollowing([], { decoder: EspnDecoder.layer })))
  return Option.match(Option.fromUndefinedOr(frames[0]), {
    onNone: () => taking,
    onSome: (first) =>
      TestClock.setTime(DateTime.toEpochMillis(first.receivedAt)).pipe(Effect.andThen(taking))
  })
}

/** `slateFollowing` the frames `frames` gives when the layer is built. For frames made on the test clock, such as a frame received now. */
function slateFollowingFramesFrom<E>(
  frames: Effect.Effect<ReadonlyArray<Frame>, E>,
  options?: Parameters<typeof slateFollowing>[1]
) {
  return Layer.unwrap(Effect.map(frames, (made) => slateFollowing(made, options)))
}

/** The slate following `feedLog`, which is provided too, read by `decoder`, in the local zone. */
function slateOn(
  feedLog: Layer.Layer<FeedLog, never, SqlClient.SqlClient | Crypto.Crypto>,
  decoder: Layer.Layer<Decoder>
) {
  return LiveSlate.layer.pipe(
    Layer.provideMerge(feedLog),
    Layer.provide([decoder, DateTime.layerCurrentZoneLocal])
  )
}

/**
 * Appends each of `frames` once the test clock reaches it and waits for the slate to take it, so the timer runs
 * between them as it would live.
 */
const takenInTime = Effect.fnUntraced(function* (frames: ReadonlyArray<Frame>) {
  for (const frame of frames) {
    const now = yield* DateTime.now
    yield* TestClock.adjust(DateTime.distance(now, frame.receivedAt))
    yield* appended(frame)
  }
})
