import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { GameActors } from "./GameActors.ts"
import { Ingest } from "./ingest/Ingest.ts"
import { Provider } from "./provider/Provider.ts"
import { Slate } from "./Slate.ts"
import * as ScenarioProvider from "./scenario/ScenarioProvider.ts"
import * as TestCluster from "./TestCluster.ts"
import { game, scripted } from "./TestProvider.ts"

describe("Slate", () => {
  it.effect("keeps the listing's order", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      // Lets the first poll run before the 250 ms window starts settling the burst.
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("250 millis")
      assert.deepStrictEqual(
        (yield* slate.latest).slate.map((listed) => listed.id),
        ["3", "1", "2"]
      )
    }).pipe(Effect.provide(slateOver(scripted([[game("3"), game("1"), game("2")]]))))
  )

  it.effect("takes each game's snapshot from its actor", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* TestClock.adjust("250 millis")
      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* slate.latest).slate[0]?.period, 2)
    }).pipe(Effect.provide(slateOver(scripted([[game("1", 2)], [game("1", 1)]]))))
  )

  it.effect("publishes an actor's new snapshot between polls", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      yield* Effect.gen(function* () {
        const slate = yield* Slate
        const actors = yield* GameActors
        yield* TestClock.adjust("3 seconds")
        yield* actors.receive(game("1", 2), "poll")
        yield* TestClock.adjust("250 millis")
        assert.strictEqual((yield* slate.latest).slate[0]?.period, 2)
        assert.strictEqual(yield* Ref.get(calls), 1)
      }).pipe(
        Effect.provide(
          slateOver(
            Layer.succeed(
              Provider,
              Provider.of({ slate: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as([game("1")])) })
            )
          )
        )
      )
    })
  )

  it.effect("publishes a poll of three games once", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      const published = yield* Ref.make<ReadonlyArray<number>>([])
      yield* slate.changes.pipe(
        Stream.runForEach((latest) => Ref.update(published, (all) => [...all, latest.slate.length])),
        Effect.forkScoped
      )
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("250 millis")
      assert.deepStrictEqual(
        (yield* Ref.get(published)).filter((length) => length > 0),
        [3]
      )
      // The second poll changes each actor before it lists, so each change meets the first listing and would publish.
      yield* TestClock.adjust("10 seconds")
      assert.deepStrictEqual(
        (yield* Ref.get(published)).filter((length) => length > 0),
        [3, 3]
      )
    }).pipe(
      Effect.provide(
        slateOver(
          scripted([
            [game("3"), game("1"), game("2")],
            [game("3", 2), game("1", 2), game("2", 2)]
          ])
        )
      )
    )
  )

  it.effect("refolds on every poll, so an unchanged live game becomes a lull", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      for (let poll = 0; poll < 7; poll++) {
        yield* TestClock.adjust("10 seconds")
        yield* TestClock.adjust("250 millis")
      }
      assert.isTrue((yield* slate.latest).watchability[0]?.lull)
    }).pipe(Effect.provide(slateOver(scripted([[game("1")]]))))
  )

  it.effect("leaves off a game no listing has", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      const actors = yield* GameActors
      yield* TestClock.adjust("250 millis")
      yield* actors.receive(game("9"), "poll")
      yield* TestClock.adjust("250 millis")
      assert.deepStrictEqual(
        (yield* slate.latest).slate.map((listed) => listed.id),
        ["1"]
      )
    }).pipe(Effect.provide(slateOver(scripted([[game("1")]]))))
  )

  it.effect("folds each game's watchability on every slate, and the tied drive leads", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* TestClock.adjust("2 minutes")
      yield* TestClock.adjust("250 millis")
      const { slate: games, watchability } = yield* slate.latest
      assert.strictEqual(watchability.length, games.length)
      const [top] = [...watchability].sort((a, b) => b.score - a.score)
      assert.strictEqual(top?.game, "tie-uga-ala")
      assert.include(top?.reasons.join(" | ") ?? "", "red zone")
    }).pipe(Effect.provide(playing("two-minute-drill-tie")))
  )

  it.effect(
    "tells a lull from play on a recorded game day, and ranks a game's red-zone polls above its others",
    () =>
      Effect.gen(function* () {
        const slate = yield* Slate
        const seen: Array<{
          red: boolean
          outside: boolean
          score: number
          lull: boolean
          live: boolean
          game: string
        }> = []
        for (let poll = 0; poll < 6 * 20; poll++) {
          yield* TestClock.adjust("10 seconds")
          const { slate: games, watchability } = yield* slate.latest
          for (const w of watchability) {
            const game = games.find((g) => g.id === w.game)
            seen.push({
              game: w.game,
              score: w.score,
              lull: w.lull,
              live: game?.status === "live",
              red: game?.situation?.isRedZone === true,
              outside: game?.situation?.inScoringRange() === false
            })
          }
        }
        const live = seen.filter((s) => s.live)
        const lullShare = live.filter((s) => s.lull).length / live.length
        assert.isBelow(lullShare, 0.5)
        for (const game of new Set(seen.map((s) => s.game))) {
          const mean = (rows: typeof seen) => rows.reduce((t, r) => t + r.score, 0) / Math.max(1, rows.length)
          const red = seen.filter((s) => s.game === game && s.red)
          const outside = seen.filter((s) => s.game === game && s.outside)
          if (red.length > 0 && outside.length > 0) assert.isAbove(mean(red), mean(outside), game)
        }
      }).pipe(Effect.provide(playing("recorded-red-zones")))
  )
})

/** The Slate over Ingest of the fbs league over `provider`, with Ingest and the game actors also provided to the test. */
function slateOver(provider: Layer.Layer<Provider>) {
  return Slate.layer.pipe(
    Layer.provideMerge(Ingest.layer(["fbs"])),
    Layer.provideMerge(TestCluster.gameActors),
    Layer.provide(provider)
  )
}

/** The Slate over Ingest of fbs and nfl, playing scenario `name`. */
function playing(name: string) {
  return Slate.layer.pipe(
    Layer.provideMerge(Ingest.layer(["fbs", "nfl"])),
    Layer.provide([ScenarioProvider.layer(name), TestCluster.gameActors]),
    Layer.provide(NodeServices.layer)
  )
}
