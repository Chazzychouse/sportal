import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { GameId, PlaysChange } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { play } from "@sportal/domain/TestGame"
import { Effect, Schema } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as TestWeb from "../TestWeb.ts"
import * as Games from "./Games.ts"

describe("Games.plays", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should start from a reset's plays", () =>
    Effect.gen(function* () {
      yield* Atom.mount(Games.plays(id))
      const source = yield* TestWeb.openedAt(`/api/games/${id}/plays/live`)

      source.onmessage?.({ data: changeMessage({ _tag: "Reset", plays: playsOf([2, 1]) }) })
      const { value } = yield* TestWeb.until(Games.plays(id), ({ value }) => value.length > 0)

      assert.deepStrictEqual(
        value.map(({ sequence }) => sequence),
        [2, 1]
      )
    }).pipe(Effect.scoped, Effect.provide(AtomRegistry.layer))
  )

  it.effect("should put appended plays before the ones it had", () =>
    Effect.gen(function* () {
      yield* Atom.mount(Games.plays(id))
      const source = yield* TestWeb.openedAt(`/api/games/${id}/plays/live`)
      source.onmessage?.({ data: changeMessage({ _tag: "Reset", plays: playsOf([1]) }) })

      source.onmessage?.({ data: changeMessage({ _tag: "Appended", plays: playsOf([3, 2]) }) })
      const { value } = yield* TestWeb.until(Games.plays(id), ({ value }) => value.length === 3)

      assert.deepStrictEqual(
        value.map(({ sequence }) => sequence),
        [3, 2, 1]
      )
    }).pipe(Effect.scoped, Effect.provide(AtomRegistry.layer))
  )

  it.effect("should replace its plays on a reset", () =>
    Effect.gen(function* () {
      yield* Atom.mount(Games.plays(id))
      const source = yield* TestWeb.openedAt(`/api/games/${id}/plays/live`)
      source.onmessage?.({ data: changeMessage({ _tag: "Reset", plays: playsOf([1]) }) })

      source.onmessage?.({ data: changeMessage({ _tag: "Reset", plays: playsOf([5, 4]) }) })
      const { value } = yield* TestWeb.until(Games.plays(id), ({ value }) => value[0]?.sequence === 5)

      assert.deepStrictEqual(
        value.map(({ sequence }) => sequence),
        [5, 4]
      )
    }).pipe(Effect.scoped, Effect.provide(AtomRegistry.layer))
  )
})

describe("Games.game", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should open the game's live stream", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.openedBy(Games.game(id))

      assert.strictEqual(source.url, "/api/games/401/live")
    }).pipe(Effect.scoped, Effect.provide(AtomRegistry.layer))
  )
})

const id = GameId.make("401")

/** Plays with these sequences, in the order given. */
function playsOf(sequences: ReadonlyArray<number>) {
  return sequences.map((sequence) => play({ id: PlayId.make(`p${sequence}`), sequence }))
}

/** A plays change's `data`, as the Hub sends it. */
function changeMessage(change: PlaysChange) {
  return Schema.encodeSync(Schema.fromJsonString(PlaysChange))(change)
}
