import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { Effect, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { LiveGames } from "./LiveGames.ts"
import { taken } from "./provider/TestProvider.ts"
import { Slate } from "./Slate.ts"
import * as ScenarioIngest from "./scenario/ScenarioIngest.ts"

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
        (yield* slate.latest).map((listed) => listed.game.id),
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
      assert.strictEqual((yield* slate.latest)[0]?.game.period, 2)
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

  it.effect("judges a listed game the fold does not hold fresh", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* listing("fbs", [snapshot({ id: GameId.make("1"), status: "final" })])
      yield* TestClock.adjust("250 millis")
      const listed = yield* slate.latest
      assert.deepStrictEqual(
        listed.map((entry) => entry.game.id),
        ["1"]
      )
      assert.isFalse((yield* (yield* LiveGames).latest).live.has(GameId.make("1")))
      assert.strictEqual(listed[0]?.watchability.game, "1")
      assert.strictEqual(listed[0]?.watchability.score, 0)
    }).pipe(Effect.provide(slateOverFold))
  )

  it.effect("an unchanged live game becomes a lull with no new listing", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* listing("fbs", [liveSnapshot({ id: GameId.make("1") })])
      yield* TestClock.adjust("250 millis")
      assert.isFalse((yield* slate.latest)[0]?.watchability.lull)

      yield* TestClock.adjust("60 seconds")
      yield* TestClock.adjust("250 millis")
      assert.isTrue((yield* slate.latest)[0]?.watchability.lull)
    }).pipe(Effect.provide(slateOverFold))
  )

  it.effect("leaves off a game no listing has", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* listing("fbs", [liveSnapshot({ id: GameId.make("1") })])
      yield* push(liveSnapshot({ id: GameId.make("9") }))
      yield* TestClock.adjust("250 millis")
      assert.deepStrictEqual(
        (yield* slate.latest).map((listed) => listed.game.id),
        ["1"]
      )
    }).pipe(Effect.provide(slateOverFold))
  )

  it.effect("folds each game's watchability, and the tied drive leads", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* TestClock.adjust("2 minutes")
      yield* TestClock.adjust("250 millis")
      const [top] = [...(yield* slate.latest)].sort((a, b) => b.watchability.score - a.watchability.score)
      assert.strictEqual(top?.game.id, "tie-uga-ala")
      assert.include(top?.watchability.reasons.join(" | ") ?? "", "red zone")
    }).pipe(Effect.provide(playing("two-minute-drill-tie")))
  )

  it.effect(
    "tells a lull from play on a recorded game day, and ranks a game's red-zone polls above its others",
    () =>
      Effect.gen(function* () {
        const slate = yield* Slate
        const seen = yield* Effect.forEach(Array.from({ length: 6 * 20 }), () =>
          Effect.gen(function* () {
            yield* TestClock.adjust("10 seconds")
            return (yield* slate.latest).map(({ game: judged, watchability: w }) => ({
              game: w.game,
              score: w.score,
              lull: w.lull,
              live: judged.status === "live",
              red: judged.situation?.isRedZone === true,
              outside: judged.situation?.inScoringRange() === false
            }))
          })
        ).pipe(Effect.map((polls) => polls.flat()))
        const live = seen.filter((s) => s.live)
        const lullShare = live.filter((s) => s.lull).length / live.length
        assert.isBelow(lullShare, 0.5)
        const mean = (rows: typeof seen) => rows.reduce((t, r) => t + r.score, 0) / Math.max(1, rows.length)
        new Set(seen.map((s) => s.game)).forEach((id) => {
          const red = seen.filter((s) => s.game === id && s.red)
          const outside = seen.filter((s) => s.game === id && s.outside)
          if (red.length > 0 && outside.length > 0) assert.isAbove(mean(red), mean(outside), id)
        })
      }).pipe(Effect.provide(playing("recorded-red-zones")))
  )
})

/** The Slate over a fold the test feeds, which is also provided to the test. */
const slateOverFold = Slate.layer.pipe(Layer.provideMerge(LiveGames.layer))

/** The Slate over a fold playing scenario `name`. */
function playing(name: string) {
  return Slate.layer.pipe(
    Layer.provideMerge(ScenarioIngest.layer(name)),
    Layer.provideMerge(LiveGames.layer),
    Layer.provide(NodeServices.layer)
  )
}

function listing(league: "nfl" | "fbs", games: ReadonlyArray<GameSnapshot>) {
  return taken(Delivery.Listing({ league, games }))
}

function push(snapshot: GameSnapshot) {
  return taken(Delivery.Snapshot({ snapshot, from: "push" }))
}
