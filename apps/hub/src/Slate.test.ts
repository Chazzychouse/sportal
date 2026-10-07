import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { Effect, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { LiveGames } from "./LiveGames.ts"
import { Slate } from "./Slate.ts"
import { delivered, liveGames } from "./TestFeed.ts"

describe("Slate", () => {
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
        (yield* slate.latest).map((listed) => listed.id),
        ["9", "3", "1", "2"]
      )
    }).pipe(Effect.provide(slateOverFold))
  )

  it.effect("a live game's snapshot wins over its listing", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* listing("fbs", [liveSnapshot({ id: GameId.make("1"), period: 1 })])
      yield* push(liveSnapshot({ id: GameId.make("1"), period: 2 }))
      yield* TestClock.adjust("250 millis")
      assert.strictEqual((yield* slate.latest)[0]?.period, 2)
    }).pipe(Effect.provide(slateOverFold))
  )

  it.effect("publishes a burst of changes once", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      const published = yield* Ref.make<ReadonlyArray<number>>([])
      yield* slate.changes.pipe(
        Stream.runForEach((latest) => Ref.update(published, (all) => [...all, latest.length])),
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
    }).pipe(Effect.provide(slateOverFold))
  )

  it.effect("lists a game the fold does not hold as listed", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      const final = snapshot({ id: GameId.make("1"), status: "final" })
      yield* listing("fbs", [final])
      yield* TestClock.adjust("250 millis")
      assert.isFalse((yield* (yield* LiveGames).latest).live.has(GameId.make("1")))
      assert.deepStrictEqual(yield* slate.latest, [final])
    }).pipe(Effect.provide(slateOverFold))
  )

  it.effect("leaves off a game no listing has", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* listing("fbs", [liveSnapshot({ id: GameId.make("1") })])
      yield* push(liveSnapshot({ id: GameId.make("9") }))
      yield* TestClock.adjust("250 millis")
      assert.deepStrictEqual(
        (yield* slate.latest).map((listed) => listed.id),
        ["1"]
      )
    }).pipe(Effect.provide(slateOverFold))
  )
})

/** The Slate over a fold the test feeds, which is also provided to the test. */
const slateOverFold = Slate.layer.pipe(Layer.provideMerge(liveGames()))

function listing(league: "nfl" | "fbs", games: ReadonlyArray<GameSnapshot>) {
  return delivered(Delivery.cases.Listing.make({ league, games }))
}

function push(snapshot: GameSnapshot) {
  return delivered(Delivery.cases.Snapshot.make({ snapshot, from: "push" }))
}
