import { assert, describe, it } from "@effect/vitest"
import { Hotkey } from "./Hotkey.ts"

describe("Hotkey.of", () => {
  it("reads digits as audio focus and shifted digits as promote, 0-based", () => {
    assert.deepStrictEqual(key("Digit1"), { _tag: "FocusAudio", slot: 0 })
    assert.deepStrictEqual(key("Digit9", { shift: true }), { _tag: "Promote", slot: 8 })
  })

  it("reads the letter and function keys", () => {
    assert.deepStrictEqual(key("KeyF"), { _tag: "ToggleSolo" })
    assert.deepStrictEqual(key("Escape"), { _tag: "Unsolo" })
    assert.deepStrictEqual(key("F11"), { _tag: "FullScreen" })
    assert.deepStrictEqual(key("KeyL"), { _tag: "NextLayout" })
    assert.deepStrictEqual(key("KeyK", { control: true }), { _tag: "CommandPalette" })
    assert.deepStrictEqual(key("KeyK", { meta: true }), { _tag: "CommandPalette" })
  })

  it("leaves every other key, and Sportal's keys with Ctrl or Cmd, to the page", () => {
    assert.isUndefined(key("KeyA"))
    assert.isUndefined(key("Digit0"))
    assert.isUndefined(key("Digit1", { control: true }))
    assert.isUndefined(key("KeyF", { meta: true }))
  })
})

function key(code: string, modifiers: Partial<{ shift: boolean; control: boolean; meta: boolean }> = {}) {
  return Hotkey.of({ code, shift: false, control: false, meta: false, ...modifiers })
}
