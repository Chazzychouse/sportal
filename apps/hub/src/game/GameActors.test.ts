import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { LiveGameState } from "@sportal/domain/LiveGame"
import { snapshot, team } from "@sportal/domain/TestGame"
import { Context, DateTime, Effect, Exit, Fiber, Layer, Ref, Stream } from "effect"
import { ClusterSchema } from "effect/cluster"
import { TestClock } from "effect/testing"
import { Game, GameActors } from "./GameActors.ts"

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
      yield* actors.receive(snapshot({ id: one }))
      yield* actors.receive(live)
      const game = (yield* actors.liveGames).get(one)
      assert.isTrue(game !== undefined && LiveGameState.$is("Live")(game.state))
      assert.strictEqual(game?.snapshot.home.score, 7)
    }).pipe(Effect.provide(GameActors.layer))
  )

  it.effect("a behind snapshot is ignored", () =>
    Effect.gen(function* () {
      const actors = yield* GameActors
      yield* actors.receive(snapshot({ id: one, status: "live", period: 2, clock: "5:00" }))
      yield* actors.receive(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }))
      assert.strictEqual((yield* actors.liveGames).get(one)?.snapshot.period, 2)
    }).pipe(Effect.provide(GameActors.layer))
  )

  it.effect("each game has its own live game", () =>
    Effect.gen(function* () {
      const actors = yield* GameActors
      const first = snapshot({ id: one })
      const second = snapshot({ id: two, status: "live", period: 3, clock: "1:00" })
      yield* actors.receive(first)
      yield* actors.receive(second)
      const liveGames = yield* actors.liveGames
      assert.strictEqual(liveGames.get(one)?.snapshot, first)
      assert.strictEqual(liveGames.get(two)?.snapshot, second)
    }).pipe(Effect.provide(GameActors.layer))
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
      yield* actors.receive(first)
      yield* actors.receive(second)
      const values = yield* Fiber.join(collecting)
      assert.isTrue(values.some((liveGames) => liveGames.get(one)?.snapshot === first))
      assert.strictEqual(values.at(-1)?.get(one)?.snapshot, second)
    }).pipe(Effect.provide(GameActors.layer))
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
          yield* actors.receive(sent)
          assert.strictEqual((yield* actors.liveGames).get(one)?.snapshot, sent)
        })
      )
    }).pipe(Effect.provide(GameActors.layer))
  )

  it.effect("a defect in one game leaves the others, the sender, and its last good live game alone", () =>
    Effect.gen(function* () {
      const actors = yield* GameActors
      const first = snapshot({ id: one, status: "live", period: 1, clock: "9:00" })
      const second = snapshot({ id: two, status: "live", period: 2, clock: "9:00" })
      yield* actors.receive(first)
      yield* actors.receive(second)
      const clientFor = yield* Game.client
      const sent = yield* Effect.exit(clientFor(one).Receive({ snapshot: second }))
      assert.isTrue(Exit.isSuccess(sent))
      const afterDefect = yield* actors.liveGames
      assert.strictEqual(afterDefect.get(one)?.snapshot, first)
      assert.strictEqual(afterDefect.get(two)?.snapshot, second)
      const next = snapshot({ id: one, status: "live", period: 1, clock: "8:00" })
      yield* actors.receive(next)
      assert.strictEqual((yield* actors.liveGames).get(one)?.snapshot, next)
    }).pipe(Effect.provide(GameActors.onCluster.pipe(Layer.provideMerge(GameActors.cluster))))
  )

  it.effect("after the layer is rebuilt a game is current on its next snapshot", () =>
    Effect.gen(function* () {
      const live = snapshot({ id: one, status: "live", period: 2, clock: "5:00" })
      yield* GameActors.use((actors) => actors.receive(live)).pipe(Effect.provide(GameActors.layer))
      yield* Effect.gen(function* () {
        const actors = yield* GameActors
        assert.strictEqual((yield* actors.liveGames).size, 0)
        yield* actors.receive(live)
        assert.strictEqual((yield* actors.liveGames).get(one)?.snapshot, live)
      }).pipe(Effect.provide(GameActors.layer))
    })
  )

  describe("over time", () => {
    const live = (clock: string) => snapshot({ id: one, status: "live", period: 1, clock })

    it.effect("a live game nobody updates is stale at 90 seconds", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        const receivedAt = yield* DateTime.now
        yield* actors.receive(live("10:00"))
        yield* TestClock.adjust("89 seconds")
        assert.isTrue(LiveGameState.$is("Live")(yield* stateOf(one)))
        yield* TestClock.adjust("1 second")
        const state = yield* stateOf(one)
        assert.isTrue(LiveGameState.$is("Stale")(state))
        assert.isTrue(
          LiveGameState.$is("Stale")(state) && DateTime.Equivalence(state.lastUpdatedAt, receivedAt)
        )
      }).pipe(Effect.provide(GameActors.layer))
    )

    it.effect("a refreshed game's timer moves with it", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"))
        yield* TestClock.adjust("60 seconds")
        yield* actors.receive(live("9:00"))
        yield* TestClock.adjust("60 seconds")
        assert.isTrue(LiveGameState.$is("Live")(yield* stateOf(one)))
        yield* TestClock.adjust("30 seconds")
        assert.isTrue(LiveGameState.$is("Stale")(yield* stateOf(one)))
      }).pipe(Effect.provide(GameActors.layer))
    )

    it.effect("a stale game is live again on its next snapshot", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"))
        yield* TestClock.adjust("90 seconds")
        assert.isTrue(LiveGameState.$is("Stale")(yield* stateOf(one)))
        yield* TestClock.adjust("10 seconds")
        const receivedAt = yield* DateTime.now
        yield* actors.receive(live("9:00"))
        const state = yield* stateOf(one)
        assert.isTrue(LiveGameState.$is("Live")(state) && DateTime.Equivalence(state.updatedAt, receivedAt))
      }).pipe(Effect.provide(GameActors.layer))
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
        yield* actors.receive(snapshot({ id: one }))
        yield* actors.receive(snapshot({ id: two, status: "final", period: 4, clock: "0:00" }))
        yield* TestClock.adjust("10 minutes")
        const states = yield* Ref.get(seen)
        assert.isTrue(states.some(LiveGameState.$is("Upcoming")))
        assert.isTrue(states.some(LiveGameState.$is("Over")))
        assert.isTrue(
          states.every((state) => LiveGameState.$is("Upcoming")(state) || LiveGameState.$is("Over")(state))
        )
      }).pipe(Effect.provide(GameActors.layer))
    )

    it.effect("a live game outlasts 5 idle minutes", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(live("10:00"))
        yield* TestClock.adjust("10 minutes")
        assert.isTrue(LiveGameState.$is("Stale")(yield* stateOf(one)))
      }).pipe(Effect.provide(GameActors.layer))
    )

    it.effect("a final game is gone 5 minutes after its last snapshot", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        yield* actors.receive(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))
        yield* TestClock.adjust("299 seconds")
        assert.isTrue((yield* actors.liveGames).has(one))
        yield* TestClock.adjust("31 seconds")
        assert.isFalse((yield* actors.liveGames).has(one))
      }).pipe(Effect.provide(GameActors.layer))
    )

    it.effect("an upcoming game kicking off within 30 minutes is kept alive; one hours away is not", () =>
      Effect.gen(function* () {
        const actors = yield* GameActors
        const now = yield* DateTime.now
        yield* actors.receive(snapshot({ id: one, kickoff: DateTime.add(now, { minutes: 20 }) }))
        yield* actors.receive(snapshot({ id: two, kickoff: DateTime.add(now, { hours: 3 }) }))
        yield* TestClock.adjust("10 minutes")
        const liveGames = yield* actors.liveGames
        assert.isTrue(liveGames.has(one))
        assert.isFalse(liveGames.has(two))
      }).pipe(Effect.provide(GameActors.layer))
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
