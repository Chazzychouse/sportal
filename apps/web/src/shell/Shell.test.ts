import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { vi } from "vitest"
import { Shell } from "./Shell.ts"

describe("Shell.layerBrowser hotkeys", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new PageWindow())
    vi.stubGlobal("HTMLElement", class {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should give a hotkey pressed on the page and prevent its default", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey
      const event = keydown({ code: "KeyS" })

      window.dispatchEvent(event)
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "ToggleSlate" })
      assert.isTrue(event.defaultPrevented)
    })
  )

  it.effect("should skip a repeated key", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey

      window.dispatchEvent(keydown({ code: "KeyS", repeat: true }))
      window.dispatchEvent(keydown({ code: "Slash", shiftKey: true }))
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "ShowKeys" })
    })
  )

  it.effect("should skip a key something already handled", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey
      const handled = keydown({ code: "KeyS" })
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

/** The first hotkey the browser Shell gives, once its listener is on the page. */
const firstHotkey = Effect.gen(function* () {
  const shell = yield* Shell
  const next = yield* shell.hotkeys.pipe(
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
    Effect.forkChild({ startImmediately: true })
  )

  yield* listening()
  return next
}).pipe(Effect.provide(Shell.layerBrowser))

/** Waits for a keydown listener on the page: the stream adds its listener in a fiber of its own. */
function listening(): Effect.Effect<void> {
  return Effect.suspend(() =>
    window instanceof PageWindow && window.keydownListeners > 0
      ? Effect.void
      : Effect.yieldNow.pipe(Effect.flatMap(listening))
  )
}

/** A window that counts the keydown listeners added to it. */
class PageWindow extends EventTarget {
  keydownListeners = 0

  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    if (args[0] === "keydown") this.keydownListeners += 1
    super.addEventListener(...args)
  }
}

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
