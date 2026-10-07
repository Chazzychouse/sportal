import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { type LiveGame, LiveGameState } from "@sportal/domain/LiveGame"
import { PlayId } from "@sportal/domain/Play"
import { Slate as DomainSlate } from "@sportal/domain/Slate"
import { liveSnapshot, play, snapshot, team } from "@sportal/domain/TestGame"
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Logger,
  Metric,
  Option,
  Queue,
  Ref,
  Stream,
  type Tracer
} from "effect"
import { TestClock } from "effect/testing"
import { FeedLog } from "./FeedLog.ts"
import { FeedFrame } from "./Frame.ts"
import { Decoder } from "./provider/Decoder.ts"
import { Decoded, LiveFeedDemand } from "./provider/Provider.ts"
import { Following, Slate } from "./Slate.ts"
import { told } from "./SlateTelemetry.ts"
import { delivered, dyingAt, pushed, slateFollowing } from "./TestFeed.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"
import { counted, gauged, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

const one = GameId.make("1")
const two = GameId.make("2")

describe("Slate", () => {
  it.effect("a listing's games become live games, and the slate keeps the listing", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const live = liveSnapshot({ id: one })
      const soon = snapshot({ id: two, kickoff: DateTime.add(now, { minutes: 20 }) })
      const later = snapshot({ id: GameId.make("3"), kickoff: DateTime.add(now, { hours: 3 }) })
      yield* delivered(Delivery.cases.Listing.make({ league: "fbs", games: [live, soon, later] }))
      const current = yield* Slate.use((slate) => slate.latest)
      assert.deepStrictEqual(current.listed.get("fbs"), [live, soon, later])
      assert.deepStrictEqual(current.live.get(one)?.snapshot, live)
      assert.strictEqual(current.live.get(one)?.from, "poll")
      assert.deepStrictEqual(current.live.get(two)?.snapshot, soon)
      assert.isFalse(current.live.has(GameId.make("3")))
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("a game's snapshots reach its live game, and the slate remembers the last frame", () =>
    Effect.gen(function* () {
      yield* delivered(Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "push" }))
      yield* delivered(Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "push" }))
      const current = yield* Slate.use((slate) => slate.latest)
      assert.deepStrictEqual(current.seq, Option.some(2))
      assert.isTrue(LiveGameState.$is("Live")(current.live.get(one)?.state ?? LiveGameState.Over()))
      assert.strictEqual(current.live.get(one)?.from, "push")
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("a behind snapshot is ignored", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }))
      yield* takenSnapshot(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }))
      assert.strictEqual((yield* liveGameOf(one)).snapshot.period, 2)
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("each game has its own live game", () =>
    Effect.gen(function* () {
      const first = liveSnapshot({ id: one, clock: "9:00" })
      const second = snapshot({ id: two, status: "live", period: 3, clock: "1:00" })
      yield* takenSnapshot(first)
      yield* takenSnapshot(second)
      assert.deepStrictEqual((yield* liveGameOf(one)).snapshot, first)
      assert.deepStrictEqual((yield* liveGameOf(two)).snapshot, second)
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("changes publishes the latest, then each new state once", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      const published = yield* Ref.make<ReadonlyArray<Option.Option<GameSnapshot>>>([])
      yield* slate.changes.pipe(
        Stream.runForEach((current) =>
          Ref.update(published, (all) => [...all, Option.fromNullishOr(current.live.get(one)?.snapshot)])
        ),
        Effect.forkScoped({ startImmediately: true })
      )
      const first = liveSnapshot({ id: one })
      const second = liveSnapshot({ id: one, clock: "9:00" })
      yield* takenSnapshot(first)
      yield* takenSnapshot(second)
      yield* takenSnapshot(liveSnapshot({ id: one, clock: "11:00" }))
      yield* Effect.yieldNow
      assert.deepStrictEqual(yield* Ref.get(published), [
        Option.none(),
        Option.some(first),
        Option.some(second)
      ])
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("changes does not publish a frame that moves only seq", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      const published = yield* Ref.make(0)
      yield* slate.changes.pipe(
        Stream.runForEach(() => Ref.update(published, (count) => count + 1)),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* takenSnapshot(liveSnapshot({ id: one }))
      const frame = yield* (yield* FeedLog).append(yield* pushed({ _tag: "Resync" }, "topic"))
      const current = yield* slate.through(frame.seq)
      yield* Effect.yieldNow
      assert.deepStrictEqual(current.seq, Option.some(2))
      assert.strictEqual(yield* Ref.get(published), 2)
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("a game's plays reach it, and each new play is an event", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      const events = yield* slate.events.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true })
      )
      yield* takenSnapshot(liveSnapshot({ id: one }))
      const frameAt = DateTime.add(yield* DateTime.now, { seconds: 5 })
      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play()] }), frameAt)
      assert.strictEqual((yield* liveGameOf(one)).plays.length, 1)
      const [first] = yield* Fiber.join(events)
      assert.strictEqual(first?.game, one)
      assert.deepStrictEqual(first?.at, frameAt)
      assert.strictEqual(first?.what._tag, "Played")
      assert.strictEqual(yield* counted("sportal_plays", { league: "fbs" }), 1)
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect("plays for a game with no live game are dropped and counted", () =>
    Effect.gen(function* () {
      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play()] }))
      assert.strictEqual((yield* Slate.use((slate) => slate.latest)).live.size, 0)
      assert.strictEqual(yield* counted("sportal_deliveries_dropped"), 1)
    }).pipe(Effect.provide(slateFollowing()), withMetrics)
  )

  it.effect("a defect in one game's delivery leaves the others and its last good live game alone", () =>
    Effect.gen(function* () {
      const first = liveSnapshot({ id: one, clock: "9:00" })
      const second = snapshot({ id: two, status: "live", period: 2, clock: "9:00" })
      yield* takenSnapshot(first)
      yield* takenSnapshot(second)
      yield* delivered(
        Delivery.cases.Listing.make({
          league: "fbs",
          games: [broken(one), snapshot({ id: two, status: "live", period: 2, clock: "8:00" })]
        })
      )
      assert.deepStrictEqual((yield* liveGameOf(one)).snapshot, first)
      assert.strictEqual((yield* liveGameOf(two)).snapshot.clock, "8:00")
      const next = liveSnapshot({ id: one, clock: "8:00" })
      yield* takenSnapshot(next)
      assert.deepStrictEqual((yield* liveGameOf(one)).snapshot, next)
    }).pipe(Effect.provide(slateFollowing([], { decoder: breaking })))
  )

  describe("through", () => {
    it.effect("answers for a frame that decodes only to a decode observation, which is told", () =>
      Effect.gen(function* () {
        const frame = yield* (yield* FeedLog).append(
          new FeedFrame({ ...(yield* pushed({ _tag: "Resync" }, "nfl")), kind: "response", body: "not json" })
        )
        const current = yield* (yield* Slate).through(frame.seq)
        assert.deepStrictEqual(current.seq, Option.some(frame.seq))
        assert.strictEqual(yield* counted("sportal_frames_undecoded", { feed: "snapshot" }), 1)
      }).pipe(Effect.provide(slateFollowing()), withMetrics)
    )

    it.effect(
      "answers with the latest once a decode defect halts the following, which is logged once",
      () => {
        const { logs, layer } = recordingLogs("Debug")
        return Effect.gen(function* () {
          const log = yield* FeedLog
          const slate = yield* Slate
          yield* takenSnapshot(liveSnapshot({ id: one }))
          const dies = yield* log.append(
            new FeedFrame({ ...(yield* pushed({ _tag: "Resync" }, "x")), body: "die" })
          )
          assert.deepStrictEqual((yield* slate.through(dies.seq)).seq, Option.some(1))
          const after = yield* log.append(yield* pushed({ _tag: "Resync" }, "x"))
          assert.deepStrictEqual((yield* slate.through(after.seq)).seq, Option.some(1))
          const stopped = logs.filter(({ level }) => level === "Error")
          assert.strictEqual(stopped.length, 1)
          assert.include(
            stopped[0]?.message,
            "frames are no longer taken into the slate until the Hub restarts"
          )
          assert.include(stopped[0]?.cause, "decode died")
        }).pipe(
          Effect.provide(slateFollowing([], { decoder: dyingAt("die") }).pipe(Layer.provideMerge(layer)))
        )
      }
    )
  })

  describe("demand", () => {
    it.effect("starts with the current games", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const live = liveSnapshot({ id: one })
        const soon = snapshot({ id: two, kickoff: DateTime.add(now, { minutes: 20 }) })
        const later = snapshot({ id: GameId.make("3"), kickoff: DateTime.add(now, { hours: 3 }) })
        yield* delivered(Delivery.cases.Listing.make({ league: "fbs", games: [live, soon, later] }))

        const first = yield* (yield* Slate).demand.pipe(Stream.runHead)
        assert.deepStrictEqual(first, Option.some(LiveFeedDemand.Games({ games: [live, soon] })))
      }).pipe(Effect.provide(slateFollowing()))
    )

    it.effect("follows a change of which games are current, not a change of their snapshots", () =>
      Effect.gen(function* () {
        yield* takenSnapshot(liveSnapshot({ id: one }))
        const demanded = yield* demandOf()
        const ids = Queue.take(demanded).pipe(
          Effect.map((demand) =>
            LiveFeedDemand.$is("Games")(demand) ? demand.games.map((game) => game.id) : []
          )
        )
        assert.deepStrictEqual(yield* ids, [one])
        yield* takenSnapshot(liveSnapshot({ id: one, clock: "8:00" }))
        yield* takenSnapshot(liveSnapshot({ id: two }))
        assert.deepStrictEqual(yield* ids, [one, two])
      }).pipe(Effect.provide(slateFollowing()))
    )

    it.effect("carries a live frame's resync, after the current games", () =>
      Effect.gen(function* () {
        const demanded = yield* demandOf()
        assert.deepStrictEqual(yield* Queue.take(demanded), LiveFeedDemand.Games({ games: [] }))
        const frame = yield* (yield* FeedLog).append(yield* pushed({ _tag: "Resync" }, "live-topic"))
        yield* (yield* Slate).through(frame.seq)
        assert.deepStrictEqual(yield* Queue.take(demanded), LiveFeedDemand.Resync({ channel: "live-topic" }))
        assert.isTrue(Option.isNone(yield* Queue.poll(demanded)))
      }).pipe(Effect.provide(slateFollowing()))
    )

    it.effect("a second subscription starts with the current games again", () =>
      Effect.gen(function* () {
        const slate = yield* Slate
        yield* takenSnapshot(liveSnapshot({ id: one }))
        assert.deepStrictEqual(
          yield* Stream.runHead(slate.demand),
          Option.some(LiveFeedDemand.Games({ games: [liveSnapshot({ id: one })] }))
        )
        yield* takenSnapshot(liveSnapshot({ id: two }))
        assert.deepStrictEqual(
          yield* Stream.runHead(slate.demand),
          Option.some(LiveFeedDemand.Games({ games: [liveSnapshot({ id: one }), liveSnapshot({ id: two })] }))
        )
      }).pipe(Effect.provide(slateFollowing()))
    )
  })

  describe("over time", () => {
    it.effect("a live game nobody updates is stale at 90 seconds, with no delivery", () =>
      Effect.gen(function* () {
        const takenAt = yield* DateTime.now
        yield* takenSnapshot(liveSnapshot({ id: one }))
        yield* TestClock.adjust("89 seconds")
        assert.isTrue(LiveGameState.$is("Live")((yield* liveGameOf(one)).state))
        yield* TestClock.adjust("1 second")
        const state = (yield* liveGameOf(one)).state
        assert.isTrue(LiveGameState.$is("Stale")(state) && DateTime.Equivalence(state.updatedAt, takenAt))
      }).pipe(Effect.provide(slateFollowing()))
    )

    it.effect("a refreshed game's timer moves with it", () =>
      Effect.gen(function* () {
        yield* takenSnapshot(liveSnapshot({ id: one }))
        yield* TestClock.adjust("60 seconds")
        yield* takenSnapshot(liveSnapshot({ id: one, clock: "9:00" }))
        yield* TestClock.adjust("60 seconds")
        assert.isTrue(LiveGameState.$is("Live")((yield* liveGameOf(one)).state))
        yield* TestClock.adjust("30 seconds")
        assert.isTrue(LiveGameState.$is("Stale")((yield* liveGameOf(one)).state))
      }).pipe(Effect.provide(slateFollowing()))
    )

    it.effect("a stale game is live again on its next snapshot", () =>
      Effect.gen(function* () {
        yield* takenSnapshot(liveSnapshot({ id: one }))
        yield* TestClock.adjust("100 seconds")
        assert.isTrue(LiveGameState.$is("Stale")((yield* liveGameOf(one)).state))
        const takenAt = yield* DateTime.now
        yield* takenSnapshot(liveSnapshot({ id: one, clock: "9:00" }))
        const state = (yield* liveGameOf(one)).state
        assert.isTrue(LiveGameState.$is("Live")(state) && DateTime.Equivalence(state.updatedAt, takenAt))
      }).pipe(Effect.provide(slateFollowing()))
    )

    it.effect("an upcoming game never goes stale", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* takenSnapshot(snapshot({ id: one, kickoff: DateTime.add(now, { minutes: 20 }) }))
        yield* TestClock.adjust("10 minutes")
        assert.isTrue(LiveGameState.$is("Upcoming")((yield* liveGameOf(one)).state))
      }).pipe(Effect.provide(slateFollowing()))
    )

    it.effect("a stale game is gone 30 minutes after its last update", () =>
      Effect.gen(function* () {
        yield* takenSnapshot(liveSnapshot({ id: one }))
        yield* TestClock.adjust("90 seconds")
        assert.isTrue(LiveGameState.$is("Stale")((yield* liveGameOf(one)).state))
        yield* TestClock.adjust("1709 seconds")
        assert.isTrue((yield* liveNow).has(one))
        yield* TestClock.adjust("1 second")
        assert.isFalse((yield* liveNow).has(one))
      }).pipe(Effect.provide(slateFollowing()))
    )

    it.effect("a final game is gone at once", () =>
      Effect.gen(function* () {
        yield* takenSnapshot(liveSnapshot({ id: one, clock: "1:00" }))
        yield* takenSnapshot(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
        assert.isFalse((yield* liveNow).has(one))
      }).pipe(Effect.provide(slateFollowing()))
    )

    it.effect("a delivery at a later time first ticks every game due before it", () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        const start = yield* DateTime.now
        yield* delivered(
          Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "poll" }),
          start
        )
        yield* delivered(
          Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one, clock: "9:00" }), from: "poll" }),
          DateTime.add(start, { minutes: 2 })
        )
        const transitions = logs
          .map(({ message }) => /(\w+) → (\w+)/.exec(message)?.[0])
          .filter((transition) => transition !== undefined)
        assert.deepStrictEqual(transitions, ["Live → Stale", "Stale → Live"])
        const state = (yield* liveGameOf(one)).state
        assert.isTrue(
          LiveGameState.$is("Live")(state) &&
            DateTime.Equivalence(state.updatedAt, DateTime.add(start, { minutes: 2 }))
        )
      }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))))
    })

    it.effect("a slate whose report dies commits nothing, and the game still goes stale on time", () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const start = yield* DateTime.now
        yield* takenSnapshot(liveSnapshot({ id: one }))
        const halted = yield* delivered(
          Delivery.cases.Plays.make({ game: two, plays: [play()] }),
          DateTime.add(start, { seconds: 100 })
        )
        assert.deepStrictEqual(halted.seq, Option.some(1), "the frame whose report died is not taken")
        assert.isTrue(
          logs.some(
            ({ level, message }) =>
              level === "Error" &&
              message.includes("frames are no longer taken into the slate until the Hub restarts")
          )
        )
        assert.isTrue(LiveGameState.$is("Live")((yield* liveGameOf(one)).state))
        yield* TestClock.adjust("89 seconds")
        assert.isTrue(LiveGameState.$is("Live")((yield* liveGameOf(one)).state))
        yield* TestClock.adjust("1 second")
        assert.isTrue(LiveGameState.$is("Stale")((yield* liveGameOf(one)).state))
      }).pipe(
        Effect.provide(
          slateFollowing().pipe(Layer.provideMerge(dyingOnce("Live → Stale").pipe(Layer.provideMerge(layer))))
        )
      )
    })

    it.effect("once the following has halted, a game going stale is still logged and gauged", () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        yield* takenSnapshot(liveSnapshot({ id: one }))
        const dies = yield* (yield* FeedLog).append(
          new FeedFrame({ ...(yield* pushed({ _tag: "Resync" }, "x")), body: "die" })
        )
        yield* (yield* Slate).through(dies.seq)
        yield* TestClock.adjust("90 seconds")
        assert.isTrue(LiveGameState.$is("Stale")((yield* liveGameOf(one)).state))
        assert.isTrue(logs.some(({ message }) => message.includes("Live → Stale")))
        assert.strictEqual(yield* gauged("sportal_game_state", { game: "1" }), 3)
        assert.strictEqual(yield* gauged("sportal_live_games", { state: "Stale" }), 1)
      }).pipe(
        Effect.provide(slateFollowing([], { decoder: dyingAt("die") }).pipe(Layer.provideMerge(layer))),
        withMetrics
      )
    })
  })

  describe("telemetry", () => {
    const home = (clock: string) =>
      snapshot({ id: one, status: "live", period: 1, clock, home: { team: team("HOME"), score: 0 } })

    it.effect("a transition is logged with the game's annotations", () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* takenSnapshot(snapshot({ id: one, kickoff: DateTime.add(now, { minutes: 5 }) }))
        yield* takenSnapshot(home("15:00"))
        const transitions = logs.filter(({ message }) => message.includes("Upcoming → Live"))
        assert.strictEqual(transitions.length, 1)
        assert.strictEqual(transitions[0]?.level, "Info")
        assert.include(
          transitions[0]?.message,
          "Slate: AWAY at HOME: Upcoming → Live at live, period 1, 15:00"
        )
        assert.include(transitions[0]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
        assert.strictEqual(yield* counted("sportal_transitions", { from: "Upcoming", to: "Live" }), 1)
      }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
    })

    it.effect("going stale is logged", () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        yield* takenSnapshot(home("10:00"))
        yield* TestClock.adjust("90 seconds")
        const stale = logs.filter(({ message }) => message.includes("Live → Stale"))
        assert.strictEqual(stale.length, 1)
        assert.strictEqual(stale[0]?.level, "Info")
        assert.include(stale[0]?.message, "Slate: AWAY at HOME: Live → Stale at ")
        assert.include(stale[0]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
      }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))))
    })

    it.effect("a behind snapshot is logged at Debug and counted", () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        yield* takenSnapshot(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }))
        yield* takenSnapshot(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }))
        const behind = logs.filter(({ message }) => message.includes("behind"))
        assert.strictEqual(behind.length, 1)
        assert.strictEqual(behind[0]?.level, "Debug")
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "behind", game: "1" }), 1)
        assert.strictEqual(
          yield* counted("sportal_snapshots", { outcome: "taken", game: "1", matchup: "AWAY at HOME" }),
          1
        )
      }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
    })

    it.effect("a game's state is gauged by game, and reads 0 once it leaves the slate", () =>
      Effect.gen(function* () {
        yield* takenSnapshot(home("10:00"))
        assert.strictEqual(yield* gauged("sportal_game_state", { game: "1", matchup: "AWAY at HOME" }), 2)
        yield* TestClock.adjust("90 seconds")
        assert.strictEqual(yield* gauged("sportal_game_state", { game: "1" }), 3)
        yield* takenSnapshot(home("9:00"))
        assert.strictEqual(yield* gauged("sportal_game_state", { game: "1" }), 2)
        yield* takenSnapshot(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
        assert.strictEqual(yield* gauged("sportal_game_state", { game: "1" }), 0)
      }).pipe(Effect.provide(slateFollowing()), withMetrics)
    )

    it.effect("a stale stretch is timed when the game is taken again", () =>
      Effect.gen(function* () {
        yield* takenSnapshot(home("10:00"))
        yield* TestClock.adjust("120 seconds")
        yield* takenSnapshot(home("9:00"))
        const stale = (yield* Metric.snapshot).find((metric) => metric.id === "sportal_stale_duration")
        assert.deepStrictEqual(
          stale?.type === "Histogram" ? [stale.state.count, stale.state.sum] : undefined,
          [1, 120_000]
        )
      }).pipe(Effect.provide(slateFollowing()), withMetrics)
    )

    it.effect(
      "an event of a game started and stopped within one take is logged and counted with that step's snapshot",
      () => {
        const { logs, layer } = recordingLogs("Debug")
        return Effect.gen(function* () {
          const at = yield* DateTime.now
          const final = snapshot({ id: one, status: "final", period: 4, clock: "0:00" })
          const taken = yield* DomainSlate.empty.take({
            deliveries: [
              Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "push" }),
              Delivery.cases.Snapshot.make({ snapshot: final, from: "push" })
            ],
            at,
            seq: 1
          })
          assert.isFalse(taken.next.live.has(one))
          assert.deepStrictEqual(
            taken.events.map(({ what }) => what._tag),
            ["PeriodEnded", "WentFinal"]
          )
          yield* told(Following.Live(), Option.none(), taken)
          const went = logs.filter(({ message }) => message.includes("WentFinal"))
          assert.strictEqual(went.length, 1)
          assert.strictEqual(went[0]?.level, "Info")
          assert.include(went[0]?.message, "at final")
          assert.strictEqual(yield* counted("sportal_game_events", { game: "1", event: "WentFinal" }), 1)
        }).pipe(Effect.provide(layer), withMetrics)
      }
    )

    it.effect(
      "an event of a game changed and stopped within one take is annotated with the step's snapshot",
      () => {
        const { logs, layer } = recordingLogs("Debug")
        return Effect.gen(function* () {
          const at = yield* DateTime.now
          const held = (yield* DomainSlate.empty.take({
            deliveries: [Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "push" })],
            at,
            seq: 1
          })).next
          const final = snapshot({ id: one, status: "final", period: 4, clock: "0:00" })
          const taken = yield* held.take({
            deliveries: [Delivery.cases.Snapshot.make({ snapshot: final, from: "push" })],
            at: DateTime.add(at, { seconds: 1 }),
            seq: 2
          })
          assert.isFalse(taken.next.live.has(one))
          yield* told(Following.Live(), Option.none(), taken)
          const went = logs.filter(({ message }) => message.includes("WentFinal"))
          assert.strictEqual(went.length, 1)
          assert.include(went[0]?.message, "at final")
          assert.strictEqual(yield* counted("sportal_game_events", { game: "1", event: "WentFinal" }), 1)
        }).pipe(Effect.provide(layer), withMetrics)
      }
    )

    it.effect("a game event is logged at Info with the game's annotations, counted, and published", () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        const slate = yield* Slate
        const events = yield* slate.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true })
        )
        yield* takenSnapshot(home("10:00"))
        yield* takenSnapshot(
          snapshot({
            id: one,
            status: "live",
            period: 1,
            clock: "9:00",
            home: { team: team("HOME"), score: 7 }
          })
        )
        const scored = logs.filter(({ message }) => message.includes("ScoreChanged"))
        assert.strictEqual(scored.length, 1)
        assert.strictEqual(scored[0]?.level, "Info")
        assert.include(scored[0]?.message, "Slate: AWAY at HOME: ScoreChanged HOME at live, period 1, 9:00")
        assert.include(scored[0]?.annotations, {
          game: "1",
          matchup: "AWAY at HOME",
          event: "ScoreChanged",
          points: 7
        })
        assert.strictEqual(yield* counted("sportal_game_events", { game: "1", event: "ScoreChanged" }), 1)
        const published = yield* Fiber.join(events)
        assert.deepStrictEqual(
          published.map(({ game, what }) => [game, what._tag]),
          [[one, "ScoreChanged"]]
        )
      }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
    })

    it.effect("snapshots are counted by the feed they came from", () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        yield* takenSnapshot(snapshot({ id: one, status: "live", period: 2, clock: "4:12" }), "push")
        yield* takenSnapshot(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }), "poll")
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "taken", source: "push" }), 1)
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "behind", source: "poll" }), 1)
        assert.isTrue(logs.some(({ message }) => message.includes("taken push live, period 2, 4:12")))
        assert.isTrue(logs.some(({ message }) => message.includes("behind poll live, period 2, 5:00")))
      }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
    })

    it.effect(
      "a poll with fewer points at the same game time after a pushed try is behind, and counted",
      () => {
        const { logs, layer } = recordingLogs("Debug")
        return Effect.gen(function* () {
          const at = (score: number) =>
            snapshot({
              id: one,
              status: "live",
              period: 2,
              clock: "4:12",
              home: { team: team("HOME"), score }
            })
          yield* takenSnapshot(at(13), "poll")
          yield* takenSnapshot(at(14), "push")
          yield* takenSnapshot(at(13), "poll")
          assert.strictEqual((yield* liveGameOf(one)).snapshot.home.score, 14)
          assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "behind", source: "poll" }), 1)
          assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "taken", source: "push" }), 1)
          assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "taken", source: "poll" }), 1)
          assert.isTrue(logs.some(({ message }) => message.includes("behind poll live, period 2, 4:12")))
        }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
      }
    )

    it.effect("a defect is logged with its frame and the snapshot that raised it, and counted", () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        yield* takenSnapshot(home("9:00"))
        yield* delivered(Delivery.cases.Snapshot.make({ snapshot: broken(one), from: "poll" }))
        const errors = logs.filter(({ level }) => level === "Error")
        assert.strictEqual(errors.length, 1)
        assert.include(JSON.stringify(errors[0]?.annotations.snapshot), '"clock":"8:00"')
        assert.include(errors[0]?.annotations, { game: "1", seq: 2 })
        assert.strictEqual(yield* counted("sportal_game_defects"), 1)
      }).pipe(
        Effect.provide(slateFollowing([], { decoder: breaking }).pipe(Layer.provideMerge(layer))),
        withMetrics
      )
    })

    it.effect("each frame taken live is a span, and timed", () => {
      const ended: Array<Tracer.Span> = []
      return Effect.gen(function* () {
        yield* takenSnapshot(home("10:00"))
        // `through` answers once the state has the frame, which can be before the span around it ends.
        const take = yield* Effect.yieldNow.pipe(
          Effect.andThen(Effect.sync(() => ended.find((span) => span.name === "Slate.take"))),
          Effect.repeat({ until: (span) => span !== undefined, times: 100 })
        )
        assert.isDefined(take, "the take's span ended")
        assert.strictEqual(take?.attributes.get("sportal.seq"), 1)
        assert.strictEqual(take?.attributes.get("sportal.deliveries"), 1)
        const duration = (yield* Metric.snapshot).find((metric) => metric.id === "sportal_take_duration")
        assert.strictEqual(duration?.type === "Histogram" ? duration.state.count : undefined, 1)
      }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(recordingSpans(ended)))), withMetrics)
    })

    it.effect("live games are counted by state", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* takenSnapshot(home("10:00"))
        yield* takenSnapshot(snapshot({ id: two, status: "live", period: 3, clock: "1:00" }))
        yield* takenSnapshot(snapshot({ id: GameId.make("3"), kickoff: DateTime.add(now, { minutes: 5 }) }))
        assert.strictEqual(yield* gauged("sportal_live_games", { state: "Live" }), 2)
        assert.strictEqual(yield* gauged("sportal_live_games", { state: "Upcoming" }), 1)
        assert.strictEqual(yield* gauged("sportal_live_games", { state: "Stale" }), 0)
      }).pipe(Effect.provide(slateFollowing()), withMetrics)
    )

    it.effect("a live game's start is logged at Info; its stop once final at Debug", () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        yield* takenSnapshot(home("1:00"))
        yield* takenSnapshot(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
        const lifecycle = logs.filter(({ message }) => /started|stopped/.test(message))
        assert.deepStrictEqual(
          lifecycle.map(({ level, message }) => [level, /started/.test(message) ? "started" : "stopped"]),
          [
            ["Info", "started"],
            ["Debug", "stopped"]
          ]
        )
        assert.include(lifecycle[1]?.message, "Slate: AWAY at HOME: stopped, Over at final")
        assert.include(lifecycle[1]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
      }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))))
    })

    it.effect("a game that is never current is neither started nor stopped", () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        yield* takenSnapshot(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
        assert.isFalse(logs.some(({ message }) => /started|stopped/.test(message)))
        assert.isUndefined(yield* gauged("sportal_game_state", { game: "1" }))
      }).pipe(Effect.provide(slateFollowing().pipe(Layer.provideMerge(layer))), withMetrics)
    })

    it.effect(
      "a defect in the timer is logged and counted, and the timer carries on with no new delivery",
      () => {
        const { logs, layer } = recordingLogs("Debug")
        return Effect.gen(function* () {
          yield* takenSnapshot(home("10:00"))
          yield* TestClock.adjust("10 seconds")
          assert.strictEqual(logs.filter(({ level }) => level === "Error").length, 1)
          assert.strictEqual(yield* counted("sportal_game_defects"), 1)
          yield* TestClock.adjust("79 seconds")
          assert.isTrue(LiveGameState.$is("Live")((yield* liveGameOf(one)).state))
          yield* TestClock.adjust("1 second")
          assert.isTrue(LiveGameState.$is("Stale")((yield* liveGameOf(one)).state))
          assert.strictEqual(yield* counted("sportal_game_defects"), 1)
        }).pipe(
          Effect.provide(
            slateFollowing().pipe(
              Layer.provide(
                sleeping((duration, clock, earlier) =>
                  earlier === 0 && Duration.equals(duration, Duration.seconds(90))
                    ? Effect.die(new Error("the timer's sleep died"))
                    : clock.sleep(duration)
                )
              ),
              Layer.provideMerge(layer)
            )
          ),
          withMetrics
        )
      }
    )

    it.effect("a timer that wakes early changes nothing until the game is due", () =>
      Effect.gen(function* () {
        const slate = yield* Slate
        const seen = yield* Ref.make<ReadonlyArray<LiveGameState["_tag"]>>([])
        yield* slate.changes.pipe(
          Stream.runForEach((current) =>
            Option.match(Option.fromNullishOr(current.live.get(one)), {
              onNone: () => Effect.void,
              onSome: (liveGame) => Ref.update(seen, (states) => [...states, liveGame.state._tag])
            })
          ),
          Effect.forkScoped({ startImmediately: true })
        )
        yield* takenSnapshot(home("10:00"))
        yield* TestClock.adjust("90 seconds")
        assert.deepStrictEqual(yield* Ref.get(seen), ["Live", "Stale"])
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
})

describe("the published slate", () => {
  it.effect("keeps the listing's order, leagues in their order", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* listing("fbs", [
        liveSnapshot({ id: GameId.make("3") }),
        liveSnapshot({ id: GameId.make("1") }),
        liveSnapshot({ id: GameId.make("2") })
      ])
      yield* listing("nfl", [snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })])
      yield* TestClock.adjust("250 millis")
      assert.deepStrictEqual(
        (yield* slate.published).games.map((listed) => listed.id),
        ["9", "3", "1", "2"]
      )
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("a live game's snapshot wins over its listing", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* listing("fbs", [liveSnapshot({ id: GameId.make("1"), period: 1 })])
      yield* push(liveSnapshot({ id: GameId.make("1"), period: 2 }))
      yield* TestClock.adjust("250 millis")
      assert.strictEqual((yield* slate.published).games[0]?.period, 2)
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("carries each listed game's plays beside it", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      const one = GameId.make("1")
      const recorded = play({ id: PlayId.make("p1"), sequence: 1 })
      yield* listing("fbs", [liveSnapshot({ id: one })])
      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [recorded] }))
      yield* TestClock.adjust("250 millis")
      const { games, recentPlays } = yield* slate.published
      assert.deepStrictEqual(
        games.map((listed) => listed.id),
        [one]
      )
      assert.deepStrictEqual(recentPlays, { [one]: [recorded] })
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("publishes a burst of changes once", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      const published = yield* Ref.make<ReadonlyArray<number>>([])
      yield* slate.publishedChanges.pipe(
        Stream.runForEach((latest) => Ref.update(published, (all) => [...all, latest.games.length])),
        Effect.forkScoped
      )
      yield* listing("fbs", [
        liveSnapshot({ id: GameId.make("3") }),
        liveSnapshot({ id: GameId.make("1") }),
        liveSnapshot({ id: GameId.make("2") })
      ])
      yield* push(liveSnapshot({ id: GameId.make("3"), period: 2 }))
      yield* push(liveSnapshot({ id: GameId.make("1"), period: 2 }))
      yield* TestClock.adjust("250 millis")
      assert.deepStrictEqual(
        (yield* Ref.get(published)).filter((length) => length > 0),
        [3]
      )
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("lists a game the slate does not hold as listed", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      const final = snapshot({ id: GameId.make("1"), status: "final" })
      yield* listing("fbs", [final])
      yield* TestClock.adjust("250 millis")
      assert.isFalse((yield* slate.latest).live.has(GameId.make("1")))
      assert.deepStrictEqual((yield* slate.published).games, [final])
    }).pipe(Effect.provide(slateFollowing()))
  )

  it.effect("leaves off a game no listing has", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* listing("fbs", [liveSnapshot({ id: GameId.make("1") })])
      yield* push(liveSnapshot({ id: GameId.make("9") }))
      yield* TestClock.adjust("250 millis")
      assert.deepStrictEqual(
        (yield* slate.published).games.map((listed) => listed.id),
        ["1"]
      )
    }).pipe(Effect.provide(slateFollowing()))
  )
})

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
).pipe(Layer.provide(TestSnapshotFeed.decoder))

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

function takenSnapshot(snapshot: GameSnapshot, from: "push" | "poll" = "poll") {
  return delivered(Delivery.cases.Snapshot.make({ snapshot, from }))
}

/** The slate's demand, run in a fiber of its own, each element offered as it comes. */
function demandOf() {
  return Effect.gen(function* () {
    const demanded = yield* Queue.unbounded<LiveFeedDemand>()
    yield* (yield* Slate).demand.pipe(
      Stream.runForEach((demand) => Queue.offer(demanded, demand)),
      Effect.forkScoped
    )
    return demanded
  })
}

const liveNow = Slate.use((slate) => slate.latest).pipe(Effect.map(({ live }) => live))

function liveGameOf(id: GameId): Effect.Effect<LiveGame, never, Slate> {
  return liveNow.pipe(
    Effect.flatMap((live) => Effect.fromNullishOr(live.get(id))),
    Effect.orDie
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

function listing(league: "nfl" | "fbs", games: ReadonlyArray<GameSnapshot>) {
  return delivered(Delivery.cases.Listing.make({ league, games }))
}

function push(snapshot: GameSnapshot) {
  return delivered(Delivery.cases.Snapshot.make({ snapshot, from: "push" }))
}
