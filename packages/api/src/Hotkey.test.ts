import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { Hotkey } from "./Hotkey.ts"

describe("Hotkey.of", () => {
  it("should read a digit as audio focus, 0-based", () => {
    const hotkey = key("Digit1")

    assert.deepStrictEqual(hotkey, { _tag: "FocusAudio", slot: 0 })
  })

  it("should read a shifted digit as promote, 0-based", () => {
    const hotkey = key("Digit9", { shift: true })

    assert.deepStrictEqual(hotkey, { _tag: "Promote", slot: 8 })
  })

  it.each<{ code: string; modifiers?: Modifiers; from?: "page" | "stream"; hotkey: Hotkey }>([
    { code: "KeyF", hotkey: { _tag: "ToggleSolo" } },
    { code: "Escape", hotkey: { _tag: "Unsolo" } },
    { code: "F11", hotkey: { _tag: "FullScreen" } },
    { code: "KeyL", hotkey: { _tag: "NextLayout" } },
    { code: "KeyA", hotkey: { _tag: "ToggleAutopilot" } },
    { code: "KeyI", hotkey: { _tag: "Interact" } },
    { code: "KeyI", from: "stream", hotkey: { _tag: "Interact" } },
    { code: "KeyS", hotkey: { _tag: "ToggleSlate" } },
    { code: "KeyK", modifiers: { control: true }, hotkey: { _tag: "CommandPalette" } },
    { code: "KeyK", modifiers: { meta: true }, hotkey: { _tag: "CommandPalette" } }
  ])(
    "should read a letter or function key: $code $modifiers as $hotkey._tag",
    ({ code, modifiers, from, hotkey }) => {
      const read = key(code, modifiers, from)

      assert.deepStrictEqual(read, hotkey)
    }
  )

  it("should read Alt with a digit as selecting that tile, 0-based", () => {
    const hotkey = key("Digit3", { alt: true })

    assert.deepStrictEqual(hotkey, { _tag: "SelectTile", slot: 2 })
  })

  it("should leave Alt with a letter to the page", () => {
    const hotkey = key("KeyF", { alt: true })

    assert.isUndefined(hotkey)
  })

  it.each<{ code: string; step: -1 | 1 }>([
    { code: "BracketLeft", step: -1 },
    { code: "BracketRight", step: 1 }
  ])("should read $code as stepping the pick by $step", ({ code, step }) => {
    const hotkey = key(code)

    assert.deepStrictEqual(hotkey, { _tag: "StepPick", step })
  })

  it("should read Shift+Slash as the key help", () => {
    const hotkey = key("Slash", { shift: true })

    assert.deepStrictEqual(hotkey, { _tag: "ShowKeys" })
  })

  it("should leave Slash without Shift to the page", () => {
    const hotkey = key("Slash")

    assert.isUndefined(hotkey)
  })

  it.each(["Enter", "NumpadEnter"])("should read %s in the page as dropping the pick", (code) => {
    const hotkey = key(code, {}, "page")

    assert.deepStrictEqual(hotkey, { _tag: "DropPick" })
  })

  it("should leave Enter in a stream view to the stream", () => {
    const hotkey = key("Enter", {}, "stream")

    assert.isUndefined(hotkey)
  })

  it.each(["KeyZ", "Digit0"])("should leave %s, a key Sportal does not bind, to the page", (code) => {
    const hotkey = key(code)

    assert.isUndefined(hotkey)
  })

  it.each<{ code: string; modifiers: Modifiers }>([
    { code: "Digit1", modifiers: { control: true } },
    { code: "KeyF", modifiers: { meta: true } },
    { code: "KeyS", modifiers: { control: true } }
  ])("should leave Sportal's keys with Ctrl or Cmd to the page: $code $modifiers", ({ code, modifiers }) => {
    const hotkey = key(code, modifiers)

    assert.isUndefined(hotkey)
  })
})

describe("Hotkey.keys", () => {
  it.each(Hotkey.keys)("should list a binding that reads back to its hotkey: $does", (binding) => {
    const press = { shift: false, alt: false, control: false, meta: false, ...binding.press }

    const hotkey = Hotkey.of(press, binding.press.from)

    assert.deepStrictEqual(hotkey, binding.hotkey, binding.does)
  })

  it.each(Object.keys(Hotkey.cases))("should list the hotkey %s", (tag) => {
    const listed = new Set<unknown>(Hotkey.keys.map((binding) => binding.hotkey._tag))

    assert.isTrue(listed.has(tag), String(tag))
  })
})

const wire: ReadonlyArray<unknown> = [
  { _tag: "FocusAudio", slot: 0 },
  { _tag: "Promote", slot: 1 },
  { _tag: "SelectTile", slot: 2 },
  { _tag: "Interact" },
  { _tag: "ToggleSolo" },
  { _tag: "Unsolo" },
  { _tag: "FullScreen" },
  { _tag: "NextLayout" },
  { _tag: "ToggleAutopilot" },
  { _tag: "ToggleSlate" },
  { _tag: "CommandPalette" },
  { _tag: "StepPick", step: -1 },
  { _tag: "StepPick", step: 1 },
  { _tag: "DropPick" },
  { _tag: "ShowKeys" }
]

describe("Hotkey wire", () => {
  it.each(wire)("should decode what it encodes: %j", (json) => {
    const hotkey = Schema.decodeUnknownSync(Hotkey)(json)

    const encoded = Schema.encodeSync(Hotkey)(hotkey)

    assert.deepStrictEqual(encoded, json)
  })

  it.each(wire)("should encode as today: %j", (json) => {
    const hotkey = Schema.decodeUnknownSync(Hotkey)(json)

    const encoded = JSON.stringify(Schema.encodeSync(Hotkey)(hotkey))

    assert.strictEqual(encoded, JSON.stringify(json))
  })
})

type Modifiers = Partial<{ shift: boolean; alt: boolean; control: boolean; meta: boolean }>

function key(code: string, modifiers: Modifiers = {}, from: "page" | "stream" = "stream") {
  return Hotkey.of({ code, shift: false, alt: false, control: false, meta: false, ...modifiers }, from)
}
