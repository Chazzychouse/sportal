import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { GameEvent } from "@sportal/domain/GameEvent"
import { type LiveGame, LiveGameState } from "@sportal/domain/LiveGame"
import { PlayId } from "@sportal/domain/Play"
import { liveSnapshot, play, snapshot, team } from "@sportal/domain/TestGame"
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  Layer,
  Logger,
  Metric,
  Option,
  Ref,
  References,
  Stream,
  type Tracer
} from "effect"
import { TestClock } from "effect/testing"
import { LiveGames } from "./LiveGames.ts"
import { taken } from "./provider/TestProvider.ts"
import { counted, gauged, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

const one = GameId.make("1")
const two = GameId.make("2")

describe("LiveGames", () => {
  it.effect("a listing's games become live games, and the fold keeps the listing", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const live = liveSnapshot({ id: one })
      const soon = snapshot({ id: two, kickoff: DateTime.add(now, { minutes: 20 }) })
      const later = snapshot({ id: GameId.make("3"), kickoff: DateTime.add(now, { hours: 3 }) })
      yield* taken(Delivery.Listing({ league: "fbs", games: [live, soon, later] }))
      const folded = yield* LiveGames.use((liveGames) => liveGames.latest)
      assert.deepStrictEqual(folded.listed.get("fbs"), [live, soon, later])
      assert.strictEqual(folded.live.get(one)?.snapshot, live)
      assert.strictEqual(folded.live.get(one)?.from, "poll")
      assert.strictEqual(folded.live.get(two)?.snapshot, soon)
      assert.isFalse(folded.live.has(GameId.make("3")))
    }).pipe(Effect.provide(LiveGames.layer))
  )

  it.effect("a game's snapshots reach its live game, and the fold remembers the last frame", () =>
    Effect.gen(function* () {
      const at = yield* DateTime.now
      yield* LiveGames.use((liveGames) =>
        liveGames.take(
          Delivery.Snapshot({ snapshot: liveSnapshot({ id: one }), from: "push" }),
          at,
          Option.some(7)
        )
      )
      const folded = yield* LiveGames.use((liveGames) => liveGames.latest)
      assert.deepStrictEqual(folded.seq, Option.some(7))
      assert.isTrue(LiveGameState.$is("Live")(folded.live.get(one)?.state ?? LiveGameState.Over()))
      assert.strictEqual(folded.live.get(one)?.from, "push")
    }).pipe(Effect.provide(LiveGames.layer))
  )

  it.effect("a behind snapshot is ignored", () =>
    Effect.gen(function* () {
      yield* takenSnapshot(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }))
      yield* takenSnapshot(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }))
      assert.strictEqual((yield* liveGameOf(one)).snapshot.period, 2)
    }).pipe(Effect.provide(LiveGames.layer))
  )

  it.effect("each game has its own live game", () =>
    Effect.gen(function* () {
      const first = liveSnapshot({ id: one, clock: "9:00" })
      const second = snapshot({ id: two, status: "live", period: 3, clock: "1:00" })
      yield* takenSnapshot(first)
      yield* takenSnapshot(second)
      assert.strictEqual((yield* liveGameOf(one)).snapshot, first)
      assert.strictEqual((yield* liveGameOf(two)).snapshot, second)
    }).pipe(Effect.provide(LiveGames.layer))
  )

  it.effect("changes publishes the latest, then each new state once", () =>
    Effect.gen(function* () {
      const liveGames = yield* LiveGames
      const published = yield* Ref.make<ReadonlyArray<Option.Option<GameSnapshot>>>([])
      yield* liveGames.changes.pipe(
        Stream.runForEach((folded) =>
          Ref.update(published, (all) => [...all, Option.fromNullishOr(folded.live.get(one)?.snapshot)])
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
    }).pipe(Effect.provide(LiveGames.layer))
  )

  it.effect("a game's plays reach it, and each new play is an event", () =>
    Effect.gen(function* () {
      const liveGames = yield* LiveGames
      const events = yield* liveGames.events.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true })
      )
      yield* takenSnapshot(liveSnapshot({ id: one }))
      yield* taken(Delivery.Plays({ game: one, plays: [play()] }))
      assert.strictEqual((yield* liveGameOf(one)).plays.length, 1)
      const [first] = yield* Fiber.join(events)
      assert.strictEqual(first?.snapshot.id, one)
      assert.strictEqual(first?.event._tag, "Played")
      assert.strictEqual(yield* counted("sportal_plays", { league: "fbs" }), 1)
    }).pipe(Effect.provide(LiveGames.layer), withMetrics)
  )

  it.effect("plays for a game with no live game are dropped and counted", () =>
    Effect.gen(function* () {
      yield* taken(Delivery.Plays({ game: one, plays: [play()] }))
      assert.strictEqual((yield* LiveGames.use((liveGames) => liveGames.latest)).live.size, 0)
      assert.strictEqual(yield* counted("sportal_deliveries_dropped"), 1)
    }).pipe(Effect.provide(LiveGames.layer), withMetrics)
  )

  it.effect("a defect in one game's delivery leaves the others and its last good live game alone", () =>
    Effect.gen(function* () {
      const first = liveSnapshot({ id: one, clock: "9:00" })
      const second = snapshot({ id: two, status: "live", period: 2, clock: "9:00" })
      yield* takenSnapshot(first)
      yield* takenSnapshot(second)
      yield* taken(
        Delivery.Listing({
          league: "fbs",
          games: [broken(one), snapshot({ id: two, status: "live", period: 2, clock: "8:00" })]
        })
      )
      assert.strictEqual((yield* liveGameOf(one)).snapshot, first)
      assert.strictEqual((yield* liveGameOf(two)).snapshot.clock, "8:00")
      const next = liveSnapshot({ id: one, clock: "8:00" })
      yield* takenSnapshot(next)
      assert.strictEqual((yield* liveGameOf(one)).snapshot, next)
    }).pipe(Effect.provide(LiveGames.layer))
  )

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
      }).pipe(Effect.provide(LiveGames.layer))
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
      }).pipe(Effect.provide(LiveGames.layer))
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
      }).pipe(Effect.provide(LiveGames.layer))
    )

    it.effect("an upcoming game never goes stale", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* takenSnapshot(snapshot({ id: one, kickoff: DateTime.add(now, { minutes: 20 }) }))
        yield* TestClock.adjust("10 minutes")
        assert.isTrue(LiveGameState.$is("Upcoming")((yield* liveGameOf(one)).state))
      }).pipe(Effect.provide(LiveGames.layer))
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
      }).pipe(Effect.provide(LiveGames.layer))
    )

    it.effect("a final game is gone at once", () =>
      Effect.gen(function* () {
        yield* takenSnapshot(liveSnapshot({ id: one, clock: "1:00" }))
        yield* takenSnapshot(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
        assert.isFalse((yield* liveNow).has(one))
      }).pipe(Effect.provide(LiveGames.layer))
    )

    it.effect("a lull begins 60 seconds after the last play, with no delivery, and is logged", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        yield* takenSnapshot(liveSnapshot({ id: one }))
        const attributes = { game: "1", league: "fbs", matchup: "AWAY at HOME" }
        assert.strictEqual(yield* gauged("sportal_lull", attributes), 0)
        yield* TestClock.adjust("59 seconds")
        assert.isFalse((yield* liveGameOf(one)).watchability.lull)
        yield* TestClock.adjust("1 second")
        assert.isTrue((yield* liveGameOf(one)).watchability.lull)
        assert.strictEqual(yield* gauged("sportal_lull", attributes), 1)
        assert.isDefined(yield* gauged("sportal_watchability", attributes))
        const lulls = logs.filter(({ message }) => message.includes("lull"))
        assert.strictEqual(lulls.length, 1)
        assert.strictEqual(lulls[0]?.level, "Info")
        assert.include(lulls[0]?.message, "LiveGames: AWAY at HOME: a lull began, watchability ")
        assert.include(lulls[0]?.annotations, attributes)
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer), withMetrics)
    })

    it.effect("a delivery at a later time first ticks every game due before it", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const liveGames = yield* LiveGames
        const start = yield* DateTime.now
        yield* liveGames.take(
          Delivery.Snapshot({ snapshot: liveSnapshot({ id: one }), from: "poll" }),
          start,
          Option.none()
        )
        yield* liveGames.take(
          Delivery.Snapshot({ snapshot: liveSnapshot({ id: one, clock: "9:00" }), from: "poll" }),
          DateTime.add(start, { minutes: 2 }),
          Option.none()
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
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer))
    })

    it.effect("a fold whose report dies commits nothing, and the game still goes stale on time", () =>
      Effect.gen(function* () {
        const liveGames = yield* LiveGames
        const start = yield* DateTime.now
        yield* takenSnapshot(liveSnapshot({ id: one }))
        const died = yield* liveGames
          .take(
            Delivery.Plays({ game: two, plays: [play()] }),
            DateTime.add(start, { seconds: 100 }),
            Option.none()
          )
          .pipe(Effect.exit)
        assert.isTrue(Exit.hasDies(died))
        assert.isTrue(LiveGameState.$is("Live")((yield* liveGameOf(one)).state))
        yield* TestClock.adjust("89 seconds")
        assert.isTrue(LiveGameState.$is("Live")((yield* liveGameOf(one)).state))
        yield* TestClock.adjust("1 second")
        assert.isTrue(LiveGameState.$is("Stale")((yield* liveGameOf(one)).state))
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(dyingOnce("Live → Stale")))
    )
  })

  describe("telemetry", () => {
    const home = (clock: string) =>
      snapshot({ id: one, status: "live", period: 1, clock, home: { team: team("HOME"), score: 0 } })

    it.effect("a transition is logged with the game's annotations", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* takenSnapshot(snapshot({ id: one, kickoff: DateTime.add(now, { minutes: 5 }) }))
        yield* takenSnapshot(home("15:00"))
        const transitions = logs.filter(({ message }) => message.includes("Upcoming → Live"))
        assert.strictEqual(transitions.length, 1)
        assert.strictEqual(transitions[0]?.level, "Info")
        assert.include(
          transitions[0]?.message,
          "LiveGames: AWAY at HOME: Upcoming → Live at live, period 1, 15:00"
        )
        assert.include(transitions[0]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
        assert.strictEqual(yield* counted("sportal_transitions", { from: "Upcoming", to: "Live" }), 1)
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer), withMetrics)
    })

    it.effect("going stale is logged", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        yield* takenSnapshot(home("10:00"))
        yield* TestClock.adjust("90 seconds")
        const stale = logs.filter(({ message }) => message.includes("Live → Stale"))
        assert.strictEqual(stale.length, 1)
        assert.strictEqual(stale[0]?.level, "Info")
        assert.include(stale[0]?.message, "LiveGames: AWAY at HOME: Live → Stale at ")
        assert.include(stale[0]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer))
    })

    it.effect("a behind snapshot is logged at Debug and counted", () => {
      const { logs, layer } = recording()
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
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer), withMetrics)
    })

    it.effect("a game's state is gauged by game, and reads 0 once it leaves the fold", () =>
      Effect.gen(function* () {
        yield* takenSnapshot(home("10:00"))
        assert.strictEqual(yield* gauged("sportal_game_state", { game: "1", matchup: "AWAY at HOME" }), 2)
        yield* TestClock.adjust("90 seconds")
        assert.strictEqual(yield* gauged("sportal_game_state", { game: "1" }), 3)
        yield* takenSnapshot(home("9:00"))
        assert.strictEqual(yield* gauged("sportal_game_state", { game: "1" }), 2)
        yield* takenSnapshot(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
        assert.strictEqual(yield* gauged("sportal_game_state", { game: "1" }), 0)
      }).pipe(Effect.provide(LiveGames.layer), withMetrics)
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
      }).pipe(Effect.provide(LiveGames.layer), withMetrics)
    )

    it.effect("a game event is logged at Info with the game's annotations, counted, and published", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const liveGames = yield* LiveGames
        const events = yield* liveGames.events.pipe(
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
        assert.include(
          scored[0]?.message,
          "LiveGames: AWAY at HOME: ScoreChanged HOME at live, period 1, 9:00"
        )
        assert.include(scored[0]?.annotations, {
          game: "1",
          matchup: "AWAY at HOME",
          event: "ScoreChanged",
          points: 7
        })
        assert.strictEqual(yield* counted("sportal_game_events", { game: "1", event: "ScoreChanged" }), 1)
        const published: ReadonlyArray<{ readonly snapshot: GameSnapshot; readonly event: GameEvent }> =
          yield* Fiber.join(events)
        assert.deepStrictEqual(
          published.map((published) => [published.snapshot.id, published.event._tag]),
          [[one, "ScoreChanged"]]
        )
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer), withMetrics)
    })

    it.effect("snapshots are counted by the feed they came from", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        yield* takenSnapshot(snapshot({ id: one, status: "live", period: 2, clock: "4:12" }), "push")
        yield* takenSnapshot(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }), "poll")
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "taken", source: "push" }), 1)
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "behind", source: "poll" }), 1)
        assert.isTrue(logs.some(({ message }) => message.includes("taken push live, period 2, 4:12")))
        assert.isTrue(logs.some(({ message }) => message.includes("behind poll live, period 2, 5:00")))
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer), withMetrics)
    })

    it.effect("a tied poll after a pushed try is kept, and counted", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const at = (score: number) =>
          snapshot({ id: one, status: "live", period: 2, clock: "4:12", home: { team: team("HOME"), score } })
        yield* takenSnapshot(at(13), "poll")
        yield* takenSnapshot(at(14), "push")
        yield* takenSnapshot(at(13), "poll")
        assert.strictEqual((yield* liveGameOf(one)).snapshot.home.score, 14)
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "kept", source: "poll" }), 1)
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "taken", source: "push" }), 1)
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "taken", source: "poll" }), 1)
        assert.isTrue(logs.some(({ message }) => message.includes("kept poll live, period 2, 4:12")))
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer), withMetrics)
    })

    it.effect("a defect is logged with its frame and the snapshot that raised it, and counted", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const liveGames = yield* LiveGames
        const at = yield* DateTime.now
        yield* takenSnapshot(home("9:00"))
        yield* liveGames.take(Delivery.Snapshot({ snapshot: broken(one), from: "poll" }), at, Option.some(42))
        const errors = logs.filter(({ level }) => level === "Error")
        assert.strictEqual(errors.length, 1)
        assert.include(JSON.stringify(errors[0]?.annotations.snapshot), '"clock":"8:00"')
        assert.include(errors[0]?.annotations, { game: "1", seq: 42 })
        assert.strictEqual(yield* counted("sportal_game_defects"), 1)
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer), withMetrics)
    })

    it.effect("take is a span under the caller's, and timed", () => {
      const ended: Array<Tracer.Span> = []
      return Effect.gen(function* () {
        yield* takenSnapshot(home("10:00")).pipe(Effect.withSpan("caller"))
        const caller = ended.find((span) => span.name === "caller")
        const take = ended.find((span) => span.name === "LiveGames.take")
        assert.isDefined(caller)
        assert.strictEqual(
          take?.parent.pipe(
            Option.map((parent) => parent.spanId),
            Option.getOrUndefined
          ),
          caller?.spanId
        )
        assert.strictEqual(take?.attributes.get("sportal.delivery"), "Snapshot")
        const duration = (yield* Metric.snapshot).find((metric) => metric.id === "sportal_take_duration")
        assert.strictEqual(duration?.type === "Histogram" ? duration.state.count : undefined, 1)
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(recordingSpans(ended)), withMetrics)
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
      }).pipe(Effect.provide(LiveGames.layer), withMetrics)
    )

    it.effect("a live game's start is logged at Info; its stop once final at Debug", () => {
      const { logs, layer } = recording()
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
        assert.include(lifecycle[1]?.message, "LiveGames: AWAY at HOME: stopped, Over at final")
        assert.include(lifecycle[1]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer))
    })

    it.effect("a game that is never current is neither started nor stopped", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        yield* takenSnapshot(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
        assert.isFalse(logs.some(({ message }) => /started|stopped/.test(message)))
        assert.isUndefined(yield* gauged("sportal_game_state", { game: "1" }))
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer), withMetrics)
    })

    it.effect(
      "a defect in the timer is logged and counted, and the timer carries on with no new delivery",
      () => {
        const { logs, layer } = recording()
        return Effect.gen(function* () {
          yield* takenSnapshot(home("10:00"))
          yield* TestClock.adjust("10 seconds")
          assert.strictEqual(logs.filter(({ level }) => level === "Error").length, 1)
          assert.strictEqual(yield* counted("sportal_game_defects"), 1)
          yield* TestClock.adjust("50 seconds")
          assert.isTrue((yield* liveGameOf(one)).watchability.lull)
          yield* TestClock.adjust("29 seconds")
          assert.isTrue(LiveGameState.$is("Live")((yield* liveGameOf(one)).state))
          yield* TestClock.adjust("1 second")
          assert.isTrue(LiveGameState.$is("Stale")((yield* liveGameOf(one)).state))
          assert.strictEqual(yield* counted("sportal_game_defects"), 1)
        }).pipe(
          Effect.provide(
            LiveGames.layer.pipe(
              Layer.provide(
                sleeping((duration, clock, earlier) =>
                  earlier === 0 && Duration.equals(duration, Duration.seconds(60))
                    ? Effect.die(new Error("the timer's sleep died"))
                    : clock.sleep(duration)
                )
              )
            )
          ),
          Effect.provide(layer),
          withMetrics
        )
      }
    )

    it.effect("a timer that wakes early changes nothing until the game is due", () =>
      Effect.gen(function* () {
        const liveGames = yield* LiveGames
        const seen = yield* Ref.make<ReadonlyArray<LiveGameState["_tag"]>>([])
        yield* liveGames.changes.pipe(
          Stream.runForEach((folded) =>
            Option.match(Option.fromNullishOr(folded.live.get(one)), {
              onNone: () => Effect.void,
              onSome: (liveGame) => Ref.update(seen, (states) => [...states, liveGame.state._tag])
            })
          ),
          Effect.forkScoped({ startImmediately: true })
        )
        yield* takenSnapshot(home("10:00"))
        yield* TestClock.adjust("90 seconds")
        // The lull at 60 s changes the live game once while it is still Live.
        assert.deepStrictEqual(yield* Ref.get(seen), ["Live", "Live", "Stale"])
      }).pipe(
        Effect.provide(
          LiveGames.layer.pipe(
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

  describe("replay", () => {
    it.effect(
      "replaying three deliveries folds them, logs one summary line, and only then sets each game's gauges",
      () => {
        const { logs, layer } = recording()
        return Effect.gen(function* () {
          const liveGames = yield* LiveGames
          const published = yield* Ref.make(0)
          yield* liveGames.changes.pipe(
            Stream.runForEach(() => Ref.update(published, (count) => count + 1)),
            Effect.forkScoped({ startImmediately: true })
          )
          const start = yield* DateTime.now
          yield* liveGames.replay(
            Stream.make(
              {
                delivery: Delivery.Snapshot({ snapshot: liveSnapshot({ id: one }), from: "poll" }),
                at: start,
                seq: 1
              },
              {
                delivery: Delivery.Plays({ game: one, plays: [play()] }),
                at: DateTime.add(start, { seconds: 10 }),
                seq: 2
              },
              {
                delivery: Delivery.Snapshot({
                  snapshot: liveSnapshot({ id: one, clock: "9:00" }),
                  from: "poll"
                }),
                at: DateTime.add(start, { minutes: 3 }),
                seq: 3
              }
            )
          )
          yield* Effect.yieldNow
          const folded = yield* liveGames.latest
          assert.deepStrictEqual(folded.seq, Option.some(3))
          assert.strictEqual(folded.live.get(one)?.plays.length, 1)
          assert.strictEqual(folded.live.get(one)?.snapshot.clock, "9:00")
          assert.isAbove(yield* Ref.get(published), 1)
          assert.isFalse(logs.some(({ message }) => /→|started|ScoreChanged|Played|lull/.test(message)))
          const info = logs.filter(({ level }) => level === "Info")
          assert.strictEqual(info.length, 1)
          assert.include(info[0]?.message, "LiveGames: replayed 3 deliveries, 1 plays; 1 live games, in ")
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
          assert.isDefined(yield* gauged("sportal_watchability", attributes))
          assert.isDefined(yield* gauged("sportal_lull", attributes))
          assert.strictEqual(yield* gauged("sportal_live_games", { state: "Live" }), 1)
          assert.strictEqual(yield* gauged("sportal_live_games", { state: "Stale" }), 0)
        }).pipe(Effect.provide(LiveGames.layer), Effect.provide(layer), withMetrics)
      }
    )

    it.effect("replay applies recorded times, and the timer waits until it ends", () =>
      Effect.gen(function* () {
        const liveGames = yield* LiveGames
        const playsSeen = yield* Ref.make<ReadonlyArray<number>>([])
        yield* liveGames.changes.pipe(
          Stream.runForEach((folded) =>
            Ref.update(playsSeen, (all) => [...all, folded.live.get(one)?.plays.length ?? -1])
          ),
          Effect.forkScoped({ startImmediately: true })
        )
        const start = yield* DateTime.now
        yield* TestClock.adjust("1 hour")
        yield* liveGames.replay(
          Stream.make(
            {
              delivery: Delivery.Snapshot({ snapshot: liveSnapshot({ id: one }), from: "poll" }),
              at: start,
              seq: 1
            },
            {
              delivery: Delivery.Plays({ game: one, plays: [play()] }),
              at: DateTime.add(start, { seconds: 10 }),
              seq: 2
            }
          ).pipe(
            // As a stream read from the log does, between deliveries.
            Stream.tap(() => Effect.yieldNow)
          )
        )
        yield* TestClock.adjust(0)
        assert.include(yield* Ref.get(playsSeen), 1)
        assert.isFalse((yield* liveNow).has(one))
      }).pipe(Effect.provide(LiveGames.layer))
    )

    it.effect("replayed deliveries publish no events; the same deliveries taken do", () =>
      Effect.gen(function* () {
        const deliveries = yield* day
        const replayed = yield* eventsWhile(
          LiveGames.use((liveGames) => liveGames.replay(Stream.fromIterable(deliveries)))
        )
        assert.deepStrictEqual(replayed, [])
        const taken = yield* eventsWhile(takenInTime(deliveries))
        assert.deepStrictEqual(
          taken.map((published) => [published.snapshot.id, published.event._tag]),
          [
            [one, "Played"],
            [one, "Played"]
          ]
        )
      })
    )

    it.effect("the same deliveries taken in time and replayed fold to the same live games", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const deliveries = yield* day
        const replayed = yield* LiveGames.use((liveGames) =>
          liveGames.replay(Stream.fromIterable(deliveries)).pipe(Effect.andThen(liveGames.latest))
        ).pipe(Effect.provide(LiveGames.layer))
        const taken = yield* LiveGames.use((liveGames) =>
          takenInTime(deliveries).pipe(Effect.andThen(liveGames.latest))
        ).pipe(Effect.provide(LiveGames.layer))
        assert.isTrue(Equal.equals(replayed.live, taken.live))
        assert.deepStrictEqual(replayed.seq, taken.seq)
        assert.isTrue(LiveGameState.$is("Live")(taken.live.get(one)?.state ?? LiveGameState.Over()))
        assert.isTrue(logs.some(({ message }) => message.includes("Live → Stale")))
        assert.isTrue(logs.some(({ message }) => message.includes("a lull began")))
        const summary = logs.find(({ message }) => message.includes("replayed"))
        assert.include(summary?.message, "replayed 5 deliveries, 2 plays; 1 live games")
      }).pipe(Effect.provide(layer))
    })

    it.effect("replay is a span", () => {
      const ended: Array<Tracer.Span> = []
      return Effect.gen(function* () {
        const liveGames = yield* LiveGames
        const at = yield* DateTime.now
        yield* liveGames.replay(
          Stream.make({
            delivery: Delivery.Snapshot({ snapshot: liveSnapshot({ id: one }), from: "poll" }),
            at,
            seq: 1
          })
        )
        assert.isDefined(ended.find((span) => span.name === "LiveGames.replay"))
      }).pipe(Effect.provide(LiveGames.layer), Effect.provide(recordingSpans(ended)))
    })
  })
})

/**
 * Five deliveries of game one from the clock's now: a snapshot, a play, a lull and a stale stretch, a score with a
 * second play, and a last snapshot.
 */
const day = DateTime.now.pipe(
  Effect.map((start) => {
    const scored = (clock: string) =>
      snapshot({ id: one, status: "live", period: 1, clock, home: { team: team("HOME"), score: 7 } })
    const second = play({ id: PlayId.make("2"), sequence: 2, clock: "14:30" })
    return [
      {
        delivery: Delivery.Snapshot({ snapshot: liveSnapshot({ id: one }), from: "poll" }),
        at: start,
        seq: 1
      },
      {
        delivery: Delivery.Plays({ game: one, plays: [play()] }),
        at: DateTime.add(start, { seconds: 10 }),
        seq: 2
      },
      {
        delivery: Delivery.Snapshot({ snapshot: scored("9:00"), from: "push" }),
        at: DateTime.add(start, { minutes: 3 }),
        seq: 3
      },
      {
        delivery: Delivery.Plays({ game: one, plays: [play(), second] }),
        at: DateTime.add(start, { minutes: 3, seconds: 5 }),
        seq: 4
      },
      {
        delivery: Delivery.Snapshot({ snapshot: scored("8:00"), from: "poll" }),
        at: DateTime.add(start, { minutes: 4, seconds: 30 }),
        seq: 5
      }
    ]
  })
)

/** Takes each of `deliveries` once the test clock reaches its `at`, so the timer runs between them as it would live. */
function takenInTime(deliveries: ReadonlyArray<{ delivery: Delivery; at: DateTime.Utc; seq: number }>) {
  return Effect.forEach(
    deliveries,
    ({ delivery, at, seq }) =>
      DateTime.now.pipe(
        Effect.flatMap((now) => TestClock.adjust(DateTime.distance(now, at))),
        Effect.andThen(LiveGames.use((liveGames) => liveGames.take(delivery, at, Option.some(seq))))
      ),
    { discard: true }
  )
}

/** The events a fresh fold publishes while it runs `run`. */
function eventsWhile(run: Effect.Effect<void, never, LiveGames>) {
  return Effect.gen(function* () {
    const liveGames = yield* LiveGames
    const seen = yield* Ref.make<
      ReadonlyArray<{ readonly snapshot: GameSnapshot; readonly event: GameEvent }>
    >([])
    const subscriber = yield* liveGames.events.pipe(
      Stream.runForEach((published) => Ref.update(seen, (all) => [...all, published])),
      Effect.forkChild({ startImmediately: true })
    )
    yield* run
    yield* Effect.yieldNow
    yield* Fiber.interrupt(subscriber)
    return yield* Ref.get(seen)
  }).pipe(Effect.provide(LiveGames.layer))
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

/** A live snapshot of game `id` at 8:00 in the first period whose events raise a defect. */
function broken(id: GameId): GameSnapshot {
  class Broken extends GameSnapshot {
    override eventsSince(): never {
      throw new Error("a broken snapshot")
    }
  }
  return new Broken({ ...liveSnapshot({ id, clock: "8:00" }) })
}

function takenSnapshot(snapshot: GameSnapshot, from: "push" | "poll" = "poll") {
  return taken(Delivery.Snapshot({ snapshot, from }))
}

const liveNow = LiveGames.use((liveGames) => liveGames.latest).pipe(Effect.map(({ live }) => live))

function liveGameOf(id: GameId): Effect.Effect<LiveGame, never, LiveGames> {
  return liveNow.pipe(
    Effect.flatMap((live) => Effect.fromNullishOr(live.get(id))),
    Effect.orDie
  )
}

/** The test's logs at Debug and above, recorded. */
function recording() {
  const { logs, layer } = recordingLogs()
  return { logs, layer: Layer.merge(layer, Layer.succeed(References.MinimumLogLevel, "Debug")) }
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
