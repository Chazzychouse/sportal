import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { vi } from "vitest"
import { Shell } from "./Shell.ts"

describe("Shell.layerBrowser hotkeys", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget())
    vi.stubGlobal("HTMLElement", class {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should give a hotkey pressed on the page and prevent its default", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey
      const event = keydown({ code: "KeyL" })

      window.dispatchEvent(event)
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "NextLayout" })
      assert.isTrue(event.defaultPrevented)
    })
  )

  it.effect("should skip a repeated key", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey

      window.dispatchEvent(keydown({ code: "KeyL", repeat: true }))
      window.dispatchEvent(keydown({ code: "Slash", shiftKey: true }))
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "ShowKeys" })
    })
  )

  it.effect("should skip a key something already handled", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey
      const handled = keydown({ code: "KeyL" })
      handled.preventDefault()

      window.dispatchEvent(handled)
      window.dispatchEvent(keydown({ code: "Slash", shiftKey: true }))
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "ShowKeys" })
    })
  )

  it.effect("should give Ctrl+K even when something already handled it", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey
      const handled = keydown({ code: "KeyK", ctrlKey: true })
      handled.preventDefault()

      window.dispatchEvent(handled)
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "CommandPalette" })
    })
  )
})

/** The first hotkey the browser Shell gives, listening from the moment it is forked. */
const firstHotkey = Effect.gen(function* () {
  const shell = yield* Shell
  return yield* shell.hotkeys.pipe(
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
    Effect.forkChild({ startImmediately: true })
  )
}).pipe(Effect.provide(Shell.layerBrowser))

/** A cancelable keydown with these keys, as a browser dispatches it. */
function keydown(keys: { code: string; shiftKey?: boolean; ctrlKey?: boolean; repeat?: boolean }) {
  return Object.assign(new Event("keydown", { cancelable: true }), {
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    ...keys
  })
}
