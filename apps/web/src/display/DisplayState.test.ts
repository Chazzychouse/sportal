import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { TileKey } from "@sportal/api/TileKey"
import { GameId } from "@sportal/domain/Game"
import { Effect, Equal, Option, Queue, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import * as TestWeb from "../TestWeb.ts"
import { DisplayInput } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"

describe("DisplayState", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should keep the next Display an input gives", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const display = yield* Effect.gen(function* () {
        yield* Atom.set(DisplayState.display, DisplayInput.Opened({ overlay: "Keys" }))
        return yield* Atom.get(DisplayState.display)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(display.shows("Keys"))
    })
  )

  it.effect("should apply an input's commands to the Screen", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const screen = yield* Effect.gen(function* () {
        yield* Atom.set(
          DisplayState.display,
          DisplayInput.Commanded({ command: { _tag: "SetLayout", layout: "Single" } })
        )
        return yield* TestWeb.until(DisplayScreen.screen, (screen) => screen.layout === "Single")
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(screen.layout, "Single")
    })
  )

  it.effect("should tell the shell once the guide is open", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.guideOpenSync)
        yield* Atom.set(DisplayState.display, DisplayInput.Pressed({ hotkey: { _tag: "Guide" } }))
        return yield* Stream.fromQueue(calls).pipe(
          Stream.filter((each) => Equal.equals(each, { _tag: "SetGuideOpen", on: true })),
          Stream.runHead
        )
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, Option.some({ _tag: "SetGuideOpen", on: true }))
    })
  )

  it.effect("should follow the shell's full screen", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell({ fullScreen: Stream.make(true) })

      const on = yield* TestWeb.until(DisplayState.fullScreen, (on) => on).pipe(
        Effect.scoped,
        Effect.provide(registry)
      )

      assert.isTrue(on)
    })
  )

  it.effect("should ask the shell for the opposite of full screen when toggled", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell({ fullScreen: Stream.make(true) })

      const call = yield* Effect.gen(function* () {
        yield* TestWeb.until(DisplayState.fullScreen, (on) => on)
        yield* Atom.set(DisplayState.toggleFullScreen, undefined)
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SetFullScreen", on: false })
    })
  )

  it.effect("should toggle full screen for the FullScreen hotkey", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell({ hotkeys: Stream.make({ _tag: "FullScreen" }) })

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.inputs)
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SetFullScreen", on: true })
    })
  )

  it.effect("should press every other hotkey on the Display", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell({ hotkeys: Stream.make({ _tag: "ShowKeys" }) })

      const display = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.inputs)
        return yield* TestWeb.until(DisplayState.display, (display) => display.shows("Keys"))
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(display.shows("Keys"))
    })
  )

  it.effect("should select the slot of a video the shell says was pressed", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.withTiles(["live", "soon"]))
      const { registry } = yield* TestWeb.withShell({
        tilePressed: Stream.make(TileKey.game(GameId.make("soon")))
      })

      const display = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.inputs)
        return yield* TestWeb.until(DisplayState.display, (display) => display.selected === 1)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(display.selected, 1)
    })
  )
})
