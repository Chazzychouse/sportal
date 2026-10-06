import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { LiveGame, LiveGameState } from "@sportal/domain/LiveGame"
import { snapshot, team } from "@sportal/domain/TestGame"
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Metric,
  Option,
  Ref,
  References,
  Stream,
  type Tracer
} from "effect"
import { ClusterSchema, MessageStorage } from "effect/cluster"
import { TestClock } from "effect/testing"
import * as Cluster from "./Cluster.ts"
import { Game, GameActors } from "./GameActors.ts"
import * as TestCluster from "./TestCluster.ts"
import { counted, gauged, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

const one = GameId.make("1")
const two = GameId.make("2")

describe("GameActors", () => {
  it.effect("a game's snapshots reach its live game", () =>
    Effect.gen(function* () {
      const actors = yield* GameActors
      const live = snapshot({
        id: one,
        status: "live",
        period: 1,
        clock: "10:00",
        home: { team: team("HOME"), score: 7 }
      })
      yield* actors.receive(snapshot({ id: one }), "poll")
      yield* actors.receive(live, "poll")
      const game = (yield* actors.liveGames).get(one)
      assert.isTrue(game !== undefined && LiveGameState.$is("Live")(game.state))
      assert.strictEqual(game?.snapshot.home.score, 7)
    }).pipe(Effect.provide(TestCluster.gameActors))
  )

  it.effect("a behind snapshot is ignored", () =>
    Effect.gen(function* () {
      const actors = yield* GameActors
      yield* actors.receive(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }), "poll")
      yield* actors.receive(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }), "poll")
      assert.strictEqual((yield* actors.liveGames).get(one)?.snapshot.period, 2)
    }).pipe(Effect.provide(TestCluster.gameActors))
  )

  it.effect("each game has its own live game", () =>
    Effect.gen(function* () {
      const actors = yield* GameActors
      const first = snapshot({ id: one })
      const second = snapshot({ id: two, status: "live", period: 3, clock: "1:00" })
      yield* actors.receive(first, "poll")
      yield* actors.receive(second, "poll")
      const liveGames = yield* actors.liveGames
      assert.strictEqual(liveGames.get(one)?.snapshot, first)
      assert.strictEqual(liveGames.get(two)?.snapshot, second)
    }).pipe(Effect.provide(TestCluster.gameActors))
  )

  it.effect("changes publishes each new live game", () =>
    Effect.gen(function* () {
      const actors = yield* GameActors
      const first = snapshot({ id: one, status: "live", period: 1, clock: "10:00" })
      const second = snapshot({ id: one, status: "live", period: 1, clock: "9:00" })
      const collecting = yield* actors.changes.pipe(
        Stream.takeUntil((liveGames) => liveGames.get(one)?.snapshot === second),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* actors.receive(first, "poll")
      yield* actors.receive(second, "poll")
      const values = yield* Fiber.join(collecting)
      assert.isTrue(values.some((liveGames) => liveGames.get(one)?.snapshot === first))
      assert.strictEqual(values.at(-1)?.get(one)?.snapshot, second)
    }).pipe(Effect.provide(TestCluster.gameActors))
  )

  it.effect("the registry has a game's live game as soon as its actor replies", () =>
    Effect.gen(function* () {
      const actors = yield* GameActors
      const snapshots = [
        snapshot({ id: one }),
        snapshot({ id: one, status: "live", period: 1, clock: "15:00" }),
        snapshot({ id: one, status: "live", period: 1, clock: "14:00" }),
        snapshot({ id: one, status: "final", period: 4, clock: "0:00" })
      ]
      yield* Effect.forEach(snapshots, (sent) =>
        Effect.gen(function* () {
          yield* actors.receive(sent, "poll")
          assert.strictEqual((yield* actors.liveGames).get(one)?.snapshot, sent)
        })
      )
    }).pipe(Effect.provide(TestCluster.gameActors))
  )

  it.effect("a defect in one game leaves the others, the sender, and its last good live game alone", () =>
    Effect.gen(function* () {
      const actors = yield* GameActors
      const first = snapshot({ id: one, status: "live", period: 1, clock: "9:00" })
      const second = snapshot({ id: two, status: "live", period: 2, clock: "9:00" })
      yield* actors.receive(first, "poll")
      yield* actors.receive(second, "poll")
      const clientFor = yield* Game.client
      const sent = yield* Effect.exit(clientFor(one).Receive({ snapshot: second, source: "poll" }))
      assert.isTrue(Exit.isSuccess(sent))
      const afterDefect = yield* actors.liveGames
      assert.strictEqual(afterDefect.get(one)?.snapshot, first)
      assert.strictEqual(afterDefect.get(two)?.snapshot, second)
      const next = snapshot({ id: one, status: "live", period: 1, clock: "8:00" })
      yield* actors.receive(next, "poll")
      assert.strictEqual((yield* actors.liveGames).get(one)?.snapshot, next)
    }).pipe(Effect.provide(GameActors.layer.pipe(Layer.provideMerge(Cluster.inMemory))))
  )

  it.effect("after the layer is rebuilt a game is current on its next snapshot", () =>
    Effect.gen(function* () {
      const live = snapshot({ id: one, status: "live", period: 2, clock: "5:00" })
      yield* GameActors.use((actors) => actors.receive(live, "poll")).pipe(
        Effect.provide(TestCluster.gameActors)
      )
      yield* Effect.gen(function* () {
        const actors = yield* GameActors
        assert.strictEqual((yield* actors.liveGames).size, 0)
        yield* actors.receive(live, "poll")
        assert.strictEqual((yield* actors.liveGames).get(one)?.snapshot, live)
      }).pipe(Effect.provide(TestCluster.gameActors))
    })
  )

  describe("over time", () => {
    const live = (clock: string) => snapshot({ id: one, status: "live", period: 1, clock })

    it.effect("a live game nobody updates is stale at 90 seconds", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        const receivedAt = yield* DateTime.now
        yield* actors.receive(live("10:00"), "poll")
        yield* TestClock.adjust("89 seconds")
        assert.isTrue(LiveGameState.$is("Live")(yield* stateOf(one)))
        yield* TestClock.adjust("1 second")
        const state = yield* stateOf(one)
        assert.isTrue(LiveGameState.$is("Stale")(state))
        assert.isTrue(
          LiveGameState.$is("Stale")(state) && DateTime.Equivalence(state.lastUpdatedAt, receivedAt)
        )
      }).pipe(Effect.provide(TestCluster.gameActors))
    )

    it.effect("a refreshed game's timer moves with it", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"), "poll")
        yield* TestClock.adjust("60 seconds")
        yield* actors.receive(live("9:00"), "poll")
        yield* TestClock.adjust("60 seconds")
        assert.isTrue(LiveGameState.$is("Live")(yield* stateOf(one)))
        yield* TestClock.adjust("30 seconds")
        assert.isTrue(LiveGameState.$is("Stale")(yield* stateOf(one)))
      }).pipe(Effect.provide(TestCluster.gameActors))
    )

    it.effect("a stale game is live again on its next snapshot", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"), "poll")
        yield* TestClock.adjust("90 seconds")
        assert.isTrue(LiveGameState.$is("Stale")(yield* stateOf(one)))
        yield* TestClock.adjust("10 seconds")
        const receivedAt = yield* DateTime.now
        yield* actors.receive(live("9:00"), "poll")
        const state = yield* stateOf(one)
        assert.isTrue(LiveGameState.$is("Live")(state) && DateTime.Equivalence(state.updatedAt, receivedAt))
      }).pipe(Effect.provide(TestCluster.gameActors))
    )

    it.effect("an upcoming or over game never goes stale", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        const seen = yield* Ref.make<ReadonlyArray<LiveGameState>>([])
        yield* actors.changes.pipe(
          Stream.runForEach((liveGames) =>
            Ref.update(seen, (states) => [
              ...states,
              ...[...liveGames.values()].map((liveGame) => liveGame.state)
            ])
          ),
          Effect.forkChild({ startImmediately: true })
        )
        yield* actors.receive(snapshot({ id: one }), "poll")
        yield* actors.receive(snapshot({ id: two, status: "final", period: 4, clock: "0:00" }), "poll")
        yield* TestClock.adjust("10 minutes")
        const states = yield* Ref.get(seen)
        assert.isTrue(states.some(LiveGameState.$is("Upcoming")))
        assert.isTrue(states.some(LiveGameState.$is("Over")))
        assert.isTrue(
          states.every((state) => LiveGameState.$is("Upcoming")(state) || LiveGameState.$is("Over")(state))
        )
      }).pipe(Effect.provide(TestCluster.gameActors))
    )

    it.effect("a live game outlasts 5 idle minutes", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"), "poll")
        yield* TestClock.adjust("10 minutes")
        assert.isTrue(LiveGameState.$is("Stale")(yield* stateOf(one)))
      }).pipe(Effect.provide(TestCluster.gameActors))
    )

    it.effect("a stale game is kept alive for 30 minutes after its last snapshot, then idles out", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"), "poll")
        yield* TestClock.adjust("90 seconds")
        assert.isTrue(LiveGameState.$is("Stale")(yield* stateOf(one)))
        yield* TestClock.adjust("20 minutes")
        assert.isTrue((yield* actors.liveGames).has(one))
        yield* TestClock.adjust("500 seconds")
        assert.isTrue((yield* actors.liveGames).has(one))
        // Idle time counts from the last message, so once keep-alive is released at 30:00 the actor idles out at the
        // next reaper check, within 30 seconds.
        yield* TestClock.adjust("40 seconds")
        assert.isFalse((yield* actors.liveGames).has(one))
      }).pipe(Effect.provide(TestCluster.gameActors))
    )

    it.effect("a final game is gone 5 minutes after its last snapshot", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }), "poll")
        yield* TestClock.adjust("299 seconds")
        assert.isTrue((yield* actors.liveGames).has(one))
        yield* TestClock.adjust("31 seconds")
        assert.isFalse((yield* actors.liveGames).has(one))
      }).pipe(Effect.provide(TestCluster.gameActors))
    )

    it.effect("an upcoming game kicking off within 30 minutes is kept alive; one hours away is not", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        const now = yield* DateTime.now
        yield* actors.receive(snapshot({ id: one, kickoff: DateTime.add(now, { minutes: 20 }) }), "poll")
        yield* actors.receive(snapshot({ id: two, kickoff: DateTime.add(now, { hours: 3 }) }), "poll")
        yield* TestClock.adjust("10 minutes")
        const liveGames = yield* actors.liveGames
        assert.isTrue(liveGames.has(one))
        assert.isFalse(liveGames.has(two))
      }).pipe(Effect.provide(TestCluster.gameActors))
    )
  })

  describe("telemetry", () => {
    const live = (clock: string) =>
      snapshot({ id: one, status: "live", period: 1, clock, home: { team: team("HOME"), score: 0 } })

    it.effect("a transition is logged with the game's annotations", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(snapshot({ id: one }), "poll")
        yield* actors.receive(live("15:00"), "poll")
        const transitions = logs.filter(({ message }) => message.includes("Upcoming → Live"))
        assert.strictEqual(transitions.length, 1)
        assert.strictEqual(transitions[0]?.level, "Info")
        assert.include(
          transitions[0]?.message,
          "GameActors: AWAY at HOME: Upcoming → Live at live, period 1, 15:00"
        )
        assert.include(transitions[0]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
        assert.strictEqual(yield* counted("sportal_transitions", { from: "Upcoming", to: "Live" }), 1)
      }).pipe(Effect.provide(TestCluster.gameActors), Effect.provide(layer), withMetrics)
    })

    it.effect("going stale is logged", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"), "poll")
        yield* TestClock.adjust("90 seconds")
        const stale = logs.filter(({ message }) => message.includes("Live → Stale"))
        assert.strictEqual(stale.length, 1)
        assert.strictEqual(stale[0]?.level, "Info")
        assert.include(stale[0]?.message, "GameActors: AWAY at HOME: Live → Stale at ")
        assert.include(stale[0]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
      }).pipe(Effect.provide(TestCluster.gameActors), Effect.provide(layer))
    })

    it.effect("a behind snapshot is logged at Debug and counted", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }), "poll")
        yield* actors.receive(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }), "poll")
        const behind = logs.filter(({ message }) => message.includes("behind"))
        assert.strictEqual(behind.length, 1)
        assert.strictEqual(behind[0]?.level, "Debug")
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "behind" }), 1)
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "taken" }), 1)
      }).pipe(Effect.provide(TestCluster.gameActors), Effect.provide(layer), withMetrics)
    })

    it.effect("snapshots are counted by the feed they came from", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(snapshot({ id: one, status: "live", period: 2, clock: "4:12" }), "push")
        yield* actors.receive(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }), "poll")
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "taken", source: "push" }), 1)
        assert.strictEqual(yield* counted("sportal_snapshots", { outcome: "behind", source: "poll" }), 1)
        assert.isTrue(logs.some(({ message }) => message.includes("taken push live, period 2, 4:12")))
        assert.isTrue(logs.some(({ message }) => message.includes("behind poll live, period 2, 5:00")))
      }).pipe(Effect.provide(TestCluster.gameActors), Effect.provide(layer), withMetrics)
    })

    it.effect("a defect is logged with the snapshot that raised it", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("9:00"), "poll")
        const clientFor = yield* Game.client
        yield* clientFor(one).Receive({
          snapshot: snapshot({ id: two, status: "live", period: 2, clock: "9:00" }),
          source: "poll"
        })
        const errors = logs.filter(({ level }) => level === "Error")
        assert.strictEqual(errors.length, 1)
        assert.include(JSON.stringify(errors[0]?.annotations.snapshot), '"id":"2"')
        assert.strictEqual(errors[0]?.annotations.game, "1")
        assert.strictEqual(yield* counted("sportal_game_defects"), 1)
      }).pipe(
        Effect.provide(GameActors.layer.pipe(Layer.provideMerge(Cluster.inMemory))),
        Effect.provide(layer),
        withMetrics
      )
    })

    it.effect("receive is a span under the caller's, and timed", () => {
      const ended: Array<Tracer.Span> = []
      return Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"), "poll").pipe(Effect.withSpan("caller"))
        const caller = ended.find((span) => span.name === "caller")
        const receive = ended.find((span) => span.name === "GameActors.receive")
        assert.isDefined(caller)
        assert.strictEqual(
          receive?.parent.pipe(
            Option.map((parent) => parent.spanId),
            Option.getOrUndefined
          ),
          caller?.spanId
        )
        assert.strictEqual(receive?.attributes.get("sportal.game"), "1")
        assert.strictEqual(receive?.attributes.get("sportal.source"), "poll")
        const duration = (yield* Metric.snapshot).find((metric) => metric.id === "sportal_receive_duration")
        assert.strictEqual(duration?.type === "Histogram" ? duration.state.count : undefined, 1)
      }).pipe(Effect.provide(TestCluster.gameActors), Effect.provide(recordingSpans(ended)), withMetrics)
    })

    it.effect("live games are counted by state", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"), "poll")
        yield* actors.receive(snapshot({ id: two, status: "live", period: 3, clock: "1:00" }), "poll")
        yield* actors.receive(snapshot({ id: GameId.make("3") }), "poll")
        assert.strictEqual(yield* gauged("sportal_live_games", { state: "Live" }), 2)
        assert.strictEqual(yield* gauged("sportal_live_games", { state: "Upcoming" }), 1)
        assert.strictEqual(yield* gauged("sportal_live_games", { state: "Stale" }), 0)
      }).pipe(Effect.provide(TestCluster.gameActors), withMetrics)
    )

    it.effect(
      "an actor's start and stop are logged at Debug for a game that is not current, and counted",
      () => {
        const { logs, layer } = recording()
        return Effect.gen(function* () {
          const actors = yield* GameActors
          yield* actors.receive(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }), "poll")
          assert.strictEqual(yield* gauged("sportal_game_actors"), 1)
          yield* TestClock.adjust("330 seconds")
          assert.strictEqual(yield* gauged("sportal_game_actors"), 0)
          const lifecycle = logs.filter(({ message }) => /started|stopped/.test(message))
          assert.deepStrictEqual(
            lifecycle.map(({ level, message }) => [level, /started/.test(message) ? "started" : "stopped"]),
            [
              ["Debug", "started"],
              ["Debug", "stopped"]
            ]
          )
          assert.include(lifecycle[1]?.message, "GameActors: AWAY at HOME: stopped, ")
          assert.include(lifecycle[1]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
        }).pipe(Effect.provide(TestCluster.gameActors), Effect.provide(layer), withMetrics)
      }
    )

    it.effect("a live game's actor starts at Info", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"), "poll")
        const started = logs.filter(({ message }) => message.includes("started"))
        assert.deepStrictEqual(
          started.map(({ level }) => level),
          ["Info"]
        )
      }).pipe(Effect.provide(TestCluster.gameActors), Effect.provide(layer))
    })

    it.effect("a current game's actor logs its stop at Info when the layer closes", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        yield* GameActors.use((actors) => actors.receive(live("10:00"), "poll")).pipe(
          Effect.provide(TestCluster.gameActors)
        )
        const stopped = logs.filter(({ message }) => message.includes("stopped"))
        assert.deepStrictEqual(
          stopped.map(({ level }) => level),
          ["Info"]
        )
        assert.include(stopped[0]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
      }).pipe(Effect.provide(layer))
    })

    it.effect("a defect in the stale timer is logged and counted, and the timer carries on", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"), "poll")
        // The actor replies before the stale timer's `changes` subscriber fiber has run; one yield lets the scheduler
        // run it, so the timer begins its sleep before time moves.
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("10 seconds")
        const errors = logs.filter(({ level }) => level === "Error")
        assert.strictEqual(errors.length, 1)
        assert.include(errors[0]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
        assert.strictEqual(yield* counted("sportal_game_defects"), 1)
        yield* actors.receive(live("9:00"), "poll")
        yield* TestClock.adjust("89 seconds")
        assert.isTrue(LiveGameState.$is("Live")(yield* stateOf(one)))
        yield* TestClock.adjust("1 second")
        assert.isTrue(LiveGameState.$is("Stale")(yield* stateOf(one)))
      }).pipe(
        Effect.provide(
          TestCluster.gameActors.pipe(
            Layer.provide(
              sleeping((duration, clock, earlier) =>
                earlier === 0 && Duration.equals(duration, LiveGame.staleAfter)
                  ? Effect.die(new Error("the stale timer's sleep died"))
                  : clock.sleep(duration)
              )
            )
          )
        ),
        Effect.provide(layer),
        withMetrics
      )
    })

    it.effect("a defect in keep-alive is logged and counted, and keep-alive carries on", () => {
      const { logs, layer } = recording()
      return Effect.gen(function* () {
        const actors = yield* GameActors
        const now = yield* DateTime.now
        const kickingOff = (minutes: number) => snapshot({ id: one, kickoff: DateTime.add(now, { minutes }) })
        // Ten seconds apart, as polls are: keep-alive follows each change's latest value, so one replaced at once
        // would never be sent.
        yield* actors.receive(kickingOff(20), "poll")
        yield* TestClock.adjust("10 seconds")
        yield* actors.receive(kickingOff(180), "poll")
        yield* TestClock.adjust("10 seconds")
        yield* actors.receive(kickingOff(20), "poll")
        yield* TestClock.adjust("10 seconds")
        const errors = logs.filter(({ level }) => level === "Error")
        assert.strictEqual(errors.length, 2)
        assert.include(errors[1]?.annotations, { game: "1", league: "fbs", matchup: "AWAY at HOME" })
        assert.strictEqual(yield* counted("sportal_game_defects"), 2)
      }).pipe(
        // Keep-alive sends a persisted message, which dies on a cluster that stores none.
        Effect.provide(
          GameActors.layer.pipe(Layer.provide(Cluster.layer), Layer.provide(MessageStorage.layerNoop))
        ),
        Effect.provide(layer),
        withMetrics
      )
    })

    it.effect("a timer that wakes early changes nothing until the game's stale time", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        const seen = yield* Ref.make<ReadonlyArray<LiveGameState>>([])
        yield* actors.changes.pipe(
          Stream.runForEach((liveGames) =>
            Option.match(Option.fromNullishOr(liveGames.get(one)), {
              onNone: () => Effect.void,
              onSome: (liveGame) => Ref.update(seen, (states) => [...states, liveGame.state])
            })
          ),
          Effect.forkChild({ startImmediately: true })
        )
        yield* actors.receive(live("10:00"), "poll")
        yield* TestClock.adjust("90 seconds")
        assert.deepStrictEqual(
          (yield* Ref.get(seen)).map(({ _tag }) => _tag),
          ["Live", "Stale"]
        )
      }).pipe(
        Effect.provide(
          TestCluster.gameActors.pipe(
            Layer.provide(
              sleeping((duration, clock) =>
                clock.sleep(
                  Duration.equals(duration, LiveGame.staleAfter)
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

  it("requests are volatile", () => {
    const receive = Game.protocol.requests.get("Receive")
    assert.isDefined(receive)
    assert.isFalse(receive !== undefined && Context.get(receive.annotations, ClusterSchema.Persisted))
  })
})

function stateOf(id: GameId) {
  return GameActors.use((actors) => actors.liveGames).pipe(
    Effect.flatMap((liveGames) => Effect.fromNullishOr(liveGames.get(id))),
    Effect.orDie,
    Effect.map((liveGame) => liveGame.state)
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
