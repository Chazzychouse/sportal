import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { TileKey } from "@sportal/api/TileKey"
import { Effect, Option, Queue } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import * as TilePlacements from "../screen/TilePlacements.ts"
import * as TestWeb from "../TestWeb.ts"
import * as Covering from "./Covering.ts"

describe("Covering.sync", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should hide the videos an open overlay covers", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama, TestWeb.irish]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(Covering.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Atom.set(Covering.overlays, new Map([["palette", overMain]]))
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SetHidden", keys: [TileKey.game(TestWeb.bama)] })
    })
  )

  it.effect("should tell the shell before the registry's scheduler runs a task", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama, TestWeb.irish]))
      const { registry, calls } = yield* TestWeb.withShell({}, () => () => {})

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(Covering.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Atom.set(Covering.overlays, new Map([["palette", overMain]]))
        yield* Effect.yieldNow
        return yield* Queue.poll(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, Option.some({ _tag: "SetHidden", keys: [TileKey.game(TestWeb.bama)] }))
    })
  )

  it.effect("should show the videos again once the overlay closes", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama, TestWeb.irish]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(Covering.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Atom.set(Covering.overlays, new Map([["palette", overMain]]))
        yield* Queue.take(calls)
        yield* Atom.set(Covering.overlays, new Map())
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SetHidden", keys: [] })
    })
  )

  it.effect("should tell the shell nothing while what is hidden is unchanged", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama, TestWeb.irish]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(Covering.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Atom.set(Covering.overlays, new Map([["palette", overMain]]))
        yield* Queue.take(calls)
        yield* Atom.set(Covering.overlays, new Map([["palette", { ...overMain, width: 201 }]]))
        yield* Atom.set(Covering.overlays, new Map())
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SetHidden", keys: [] })
    })
  )
})

const sized = { x: 0, y: 0, width: 1600, height: 900 }

/** A palette over the main tile's video only (the main tile's video is below its 28px header, left of x 800). */
const overMain = { x: 100, y: 100, width: 200, height: 200 }
