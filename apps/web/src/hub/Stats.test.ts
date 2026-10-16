import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { GameStats } from "@sportal/domain/GameStats"
import { PlayId } from "@sportal/domain/Play"
import { Effect, Option } from "effect"
import { Atom } from "effect/reactivity"
import * as TestWeb from "../TestWeb.ts"
import * as Stats from "./Stats.ts"

describe("Stats.statsLive", () => {
  it.effect("should ask the Hub for that game's live stats", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const open = yield* Effect.gen(function* () {
        yield* Atom.mount(Stats.statsLive(id))

        return yield* TestWeb.asked(hub, `stats ${id}`)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.include(open, `stats ${id}`)
    })
  )

  it.effect("should hold the latest stats the Hub sends", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()
      const sent = new GameStats({ ...GameStats.empty(id), scoringPlays: [PlayId.make("p1")] })

      const { value } = yield* Effect.gen(function* () {
        yield* Atom.mount(Stats.statsLive(id))

        yield* TestWeb.answer(hub, `stats ${id}`, hub.stats, sent)
        return yield* TestWeb.until(Stats.statsLive(id), ({ value }) => Option.isSome(value))
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(value, Option.some(sent))
    })
  )
})

const id = GameId.make("401")
