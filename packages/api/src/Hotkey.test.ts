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
    assert.deepStrictEqual(key("KeyS"), { _tag: "ToggleSlate" })
    assert.deepStrictEqual(key("KeyK", { control: true }), { _tag: "CommandPalette" })
    assert.deepStrictEqual(key("KeyK", { meta: true }), { _tag: "CommandPalette" })
  })

  it("reads Alt with a digit as selecting that tile, 0-based", () => {
    assert.deepStrictEqual(key("Digit3", { alt: true }), { _tag: "SelectTile", slot: 2 })
    assert.isUndefined(key("KeyF", { alt: true }))
  })

  it("reads the brackets as stepping the pick and Shift+Slash as the key help", () => {
    assert.deepStrictEqual(key("BracketLeft"), { _tag: "StepPick", step: -1 })
    assert.deepStrictEqual(key("BracketRight"), { _tag: "StepPick", step: 1 })
    assert.deepStrictEqual(key("Slash", { shift: true }), { _tag: "ShowKeys" })
    assert.isUndefined(key("Slash"))
  })

  it("reads Enter as dropping the pick only in the page, so a stream view keeps its Enter", () => {
    assert.deepStrictEqual(key("Enter", {}, "page"), { _tag: "DropPick" })
    assert.deepStrictEqual(key("NumpadEnter", {}, "page"), { _tag: "DropPick" })
    assert.isUndefined(key("Enter", {}, "stream"))
  })

  it("leaves every other key, and Sportal's keys with Ctrl or Cmd, to the page", () => {
    assert.isUndefined(key("KeyA"))
    assert.isUndefined(key("Digit0"))
    assert.isUndefined(key("Digit1", { control: true }))
    assert.isUndefined(key("KeyF", { meta: true }))
    assert.isUndefined(key("KeyS", { control: true }))
  })
})

describe("Hotkey.keys", () => {
  it("lists bindings that each read back to the hotkey they describe", () => {
    for (const binding of Hotkey.keys)
      assert.deepStrictEqual(
        Hotkey.of(
          { shift: false, alt: false, control: false, meta: false, ...binding.press },
          binding.press.from
        ),
        binding.hotkey,
        binding.does
      )
  })

  it("lists every hotkey", () => {
    const listed = new Set<unknown>(Hotkey.keys.map((binding) => binding.hotkey._tag))
    for (const member of Hotkey.members) {
      const tag = member.fields._tag.ast.literal
      assert.isTrue(listed.has(tag), String(tag))
    }
  })
})

function key(
  code: string,
  modifiers: Partial<{ shift: boolean; alt: boolean; control: boolean; meta: boolean }> = {},
  from: "page" | "stream" = "stream"
) {
  return Hotkey.of({ code, shift: false, alt: false, control: false, meta: false, ...modifiers }, from)
}
