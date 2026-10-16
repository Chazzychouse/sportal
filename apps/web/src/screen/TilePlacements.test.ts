import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { TileKey } from "@sportal/api/TileKey"
import { Effect, Option, Queue } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import { DisplayInput } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import * as TestWeb from "../TestWeb.ts"
import * as TilePlacements from "./TilePlacements.ts"

describe("TilePlacements.sync", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should tell the shell nothing until the area has a size, then its placements", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(TilePlacements.sync)
        yield* Atom.set(TilePlacements.area, sized)
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(call._tag, "SyncTiles")
      assert.deepStrictEqual(call._tag === "SyncTiles" && call.placements.map(({ key }) => key), [
        TileKey.game(TestWeb.bama)
      ])
    })
  )

  it.effect("should tell the shell before the registry's scheduler runs a task", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama]))
      const { registry, calls } = yield* TestWeb.withShell({}, () => () => {})

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(TilePlacements.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Effect.yieldNow
        return yield* Queue.poll(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(Option.exists(call, ({ _tag }) => _tag === "SyncTiles"))
    })
  )

  it.effect("should move the views along the transition when the arrangement changes", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama, TestWeb.irish]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(TilePlacements.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Queue.take(calls)
        yield* Atom.set(
          DisplayState.display,
          DisplayInput.Commanded({ command: { _tag: "Swap", a: 0, b: 1 } })
        )
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(
        call._tag === "SyncTiles" && call.transition,
        Option.some(TilePlacements.screenTransition)
      )
    })
  )

  it.effect("should move the views at once on a resize", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(TilePlacements.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Queue.take(calls)
        yield* Atom.set(TilePlacements.area, { ...sized, width: 1200 })
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call._tag === "SyncTiles" && call.transition, Option.none())
    })
  )

  it.effect("should move the views at once while a divider is dragged", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama, TestWeb.irish]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(TilePlacements.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Queue.take(calls)
        yield* Atom.set(TilePlacements.dragged, Option.some({ x: 0.3, y: 0.5 }))
        yield* Queue.take(calls)
        yield* Atom.set(
          DisplayState.display,
          DisplayInput.Commanded({ command: { _tag: "Swap", a: 0, b: 1 } })
        )
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call._tag === "SyncTiles" && call.transition, Option.none())
    })
  )

  it.effect("should tell the shell nothing when the placements are unchanged", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(TilePlacements.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Queue.take(calls)
        yield* Atom.set(TilePlacements.area, { ...sized })
        yield* Atom.set(TilePlacements.area, { ...sized, width: 1200 })
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(
        call._tag === "SyncTiles" && call.placements[0]?.bounds.width,
        // Quad at 1200 wide: half the width less the gap.
        594
      )
    })
  )
})

const sized = { x: 0, y: 44, width: 1600, height: 900 }
