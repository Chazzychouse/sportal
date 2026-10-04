import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { GameActors } from "../game/GameActors.ts"
import { Ingest } from "../ingest/Ingest.ts"
import * as ScenarioProvider from "../scenario/ScenarioProvider.ts"
import { Watch } from "./Watch.ts"

const playing = (name: string) =>
  Watch.layer.pipe(
    Layer.provideMerge(Ingest.layer(["fbs", "nfl"])),
    Layer.provide([ScenarioProvider.layer(name), GameActors.layer]),
    Layer.provide(NodeServices.layer)
  )

describe("Watch", () => {
  it.effect("folds each game's watchability on every slate, and the tied drive leads", () =>
    Effect.gen(function* () {
      const watch = yield* Watch
      yield* TestClock.adjust("2 minutes")
      const { slate, watchability } = yield* watch.latest
      assert.strictEqual(watchability.length, slate.length)
      const [top] = [...watchability].sort((a, b) => b.score - a.score)
      assert.strictEqual(top?.game, "tie-uga-ala")
      assert.include(top?.reasons.join(" | ") ?? "", "red zone")
    }).pipe(Effect.provide(playing("two-minute-drill-tie")))
  )

  it.effect(
    "tells a lull from play on a recorded game day, and ranks a game's red-zone polls above its others",
    () =>
      Effect.gen(function* () {
        const watch = yield* Watch
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
          const { slate, watchability } = yield* watch.latest
          for (const w of watchability) {
            const game = slate.find((g) => g.id === w.game)
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
