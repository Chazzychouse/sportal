import { assert, describe, it } from "@effect/vitest"
import { GameId, type PlaysChange } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { play } from "@sportal/domain/TestGame"
import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import * as TestWeb from "../TestWeb.ts"
import * as Games from "./Games.ts"

describe("Games.plays", () => {
  it.effect("should start from a reset's plays", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const { value } = yield* Effect.gen(function* () {
        yield* Atom.mount(Games.plays(id))

        yield* TestWeb.answer(
          hub,
          `plays ${id}`,
          hub.plays,
          changed({ _tag: "Reset", plays: playsOf([2, 1]) })
        )
        return yield* TestWeb.until(Games.plays(id), ({ value }) => value.length > 0)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(
        value.map(({ sequence }) => sequence),
        [2, 1]
      )
    })
  )

  it.effect("should put appended plays before the ones it had", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const { value } = yield* Effect.gen(function* () {
        yield* Atom.mount(Games.plays(id))
        yield* TestWeb.answer(hub, `plays ${id}`, hub.plays, changed({ _tag: "Reset", plays: playsOf([1]) }))

        yield* TestWeb.answer(
          hub,
          `plays ${id}`,
          hub.plays,
          changed({ _tag: "Appended", plays: playsOf([3, 2]) })
        )
        return yield* TestWeb.until(Games.plays(id), ({ value }) => value.length === 3)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(
        value.map(({ sequence }) => sequence),
        [3, 2, 1]
      )
    })
  )

  it.effect("should replace its plays on a reset", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const { value } = yield* Effect.gen(function* () {
        yield* Atom.mount(Games.plays(id))
        yield* TestWeb.answer(hub, `plays ${id}`, hub.plays, changed({ _tag: "Reset", plays: playsOf([1]) }))

        yield* TestWeb.answer(
          hub,
          `plays ${id}`,
          hub.plays,
          changed({ _tag: "Reset", plays: playsOf([5, 4]) })
        )
        return yield* TestWeb.until(Games.plays(id), ({ value }) => value[0]?.sequence === 5)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(
        value.map(({ sequence }) => sequence),
        [5, 4]
      )
    })
  )

  it.effect("should end its query on the Hub once nothing reads it", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const open = yield* Effect.gen(function* () {
        yield* Effect.scoped(Effect.andThen(Atom.mount(Games.plays(id)), TestWeb.asked(hub, `plays ${id}`)))

        yield* TestWeb.afterTasks
        return yield* TestWeb.dropped(hub, `plays ${id}`)
      }).pipe(Effect.provide(registry))

      assert.notInclude(open, `plays ${id}`)
    })
  )
})

describe("Games.game", () => {
  it.effect("should ask the Hub for that game", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const open = yield* Effect.gen(function* () {
        yield* Atom.mount(Games.game(id))

        return yield* TestWeb.asked(hub, "game 401")
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.include(open, "game 401")
    })
  )
})

const id = GameId.make("401")

/** Plays with these sequences, in the order given. */
function playsOf(sequences: ReadonlyArray<number>) {
  return sequences.map((sequence) => play({ id: PlayId.make(`p${sequence}`), sequence }))
}

/** `change` to game `id`'s plays, as the fake Hub publishes it. */
function changed(change: PlaysChange) {
  return { game: id, change }
}
