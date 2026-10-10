import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Effect, Option, Queue, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import * as AutopilotState from "../autopilot/AutopilotState.ts"
import { AutopilotInput } from "../autopilot/AutopilotState.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import * as TestWeb from "../TestWeb.ts"
import { DisplayInput } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"

describe("DisplayState", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should keep the next Display an input gives", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const display = yield* Effect.gen(function* () {
        yield* Atom.set(DisplayState.display, DisplayInput.SlateToggled())
        return yield* Atom.get(DisplayState.display)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isFalse(display.slateOpen)
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
      const { registry } = yield* TestWeb.withShell({ hotkeys: Stream.make({ _tag: "ToggleSlate" }) })

      const display = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.inputs)
        return yield* TestWeb.until(DisplayState.display, (display) => !display.slateOpen)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isFalse(display.slateOpen)
    })
  )

  it.effect("should select the slot of a video the shell says was pressed", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.withTiles(["live", "soon"]))
      const { registry } = yield* TestWeb.withShell({ tilePressed: Stream.make(GameId.make("soon")) })

      const display = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.inputs)
        return yield* TestWeb.until(DisplayState.display, (display) => display.selected === 1)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(display.selected, 1)
    })
  )

  it.effect("should make the main tile yours when you promote a tile with the autopilot on", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.withTiles(["live", "soon"]))
      const { registry } = yield* TestWeb.withShell()

      const pilot = yield* Effect.gen(function* () {
        yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())
        yield* Atom.set(
          DisplayState.display,
          DisplayInput.Commanded({ command: { _tag: "Promote", tile: 1 } })
        )
        return yield* Atom.get(AutopilotState.autopilot)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(Option.isSome(pilot.suspended.main))
    })
  )

  it.effect("should leave the autopilot as it was when the Screen refuses your command", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.withTiles(["live", "soon"]))
      const { registry } = yield* TestWeb.withShell()

      const [before, after] = yield* Effect.gen(function* () {
        yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())
        const before = yield* Atom.get(AutopilotState.autopilot)
        yield* Atom.set(
          DisplayState.display,
          DisplayInput.Commanded({ command: { _tag: "Promote", tile: 2 } })
        )
        const after = yield* Atom.get(AutopilotState.autopilot)
        return [before, after] as const
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(after, before)
    })
  )

  it.effect("should turn the autopilot on for the ToggleAutopilot hotkey", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell({ hotkeys: Stream.make({ _tag: "ToggleAutopilot" }) })

      const pilot = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.inputs)
        return yield* TestWeb.until(AutopilotState.autopilot, (pilot) => pilot.on)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(pilot.on)
    })
  )
})
