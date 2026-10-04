import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { LiveGameState } from "@sportal/domain/LiveGame"
import { snapshot, team } from "@sportal/domain/TestGame"
import { Context, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { ClusterSchema } from "effect/cluster"
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

  it("requests are volatile", () => {
    const receive = Game.protocol.requests.get("Receive")
    assert.isDefined(receive)
    assert.isFalse(receive !== undefined && Context.get(receive.annotations, ClusterSchema.Persisted))
  })
})
