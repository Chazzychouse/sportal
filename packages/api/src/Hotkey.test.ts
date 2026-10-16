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

  it.each<{ code: string; modifiers?: Modifiers; hotkey: Hotkey }>([
    { code: "KeyF", hotkey: { _tag: "ToggleSolo" } },
    { code: "Escape", hotkey: { _tag: "Unsolo" } },
    { code: "F11", hotkey: { _tag: "FullScreen" } },
    { code: "KeyL", hotkey: { _tag: "NextLayout" } },
    { code: "KeyI", hotkey: { _tag: "Interact" } },
    { code: "KeyK", modifiers: { control: true }, hotkey: { _tag: "CommandPalette" } },
    { code: "KeyK", modifiers: { meta: true }, hotkey: { _tag: "CommandPalette" } }
  ])(
    "should read a letter or function key: $code $modifiers as $hotkey._tag",
    ({ code, modifiers, hotkey }) => {
      const read = key(code, modifiers)

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

  it("should read Shift+Slash as the key help", () => {
    const hotkey = key("Slash", { shift: true })

    assert.deepStrictEqual(hotkey, { _tag: "ShowKeys" })
  })

  it("should leave Slash without Shift to the page", () => {
    const hotkey = key("Slash")

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

describe("Hotkey.of in the guide", () => {
  it.each<{ code: string; direction: "up" | "down" | "left" | "right" }>([
    { code: "ArrowUp", direction: "up" },
    { code: "ArrowDown", direction: "down" },
    { code: "ArrowLeft", direction: "left" },
    { code: "ArrowRight", direction: "right" }
  ])("should read $code as a move $direction while the guide is open", ({ code, direction }) => {
    const hotkey = key(code, { guideOpen: true })

    assert.deepStrictEqual(hotkey, { _tag: "Move", direction })
  })

  it.each(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])(
    "should leave %s to the page while the guide is closed",
    (code) => {
      const hotkey = key(code)

      assert.isUndefined(hotkey)
    }
  )

  it.each([false, true])("should read G as the guide, whether it is open or not: open %s", (guideOpen) => {
    const hotkey = key("KeyG", { guideOpen })

    assert.deepStrictEqual(hotkey, { _tag: "Guide" })
  })

  it.each<{ code: string; hotkey: Hotkey }>([
    { code: "Enter", hotkey: { _tag: "Confirm" } },
    { code: "BracketRight", hotkey: { _tag: "NextEntry" } },
    { code: "BracketLeft", hotkey: { _tag: "PreviousEntry" } },
    { code: "KeyI", hotkey: { _tag: "Info" } }
  ])("should read $code as $hotkey._tag while the guide is open", ({ code, hotkey }) => {
    const read = key(code, { guideOpen: true })

    assert.deepStrictEqual(read, hotkey)
  })

  it.each(["Enter", "BracketRight", "BracketLeft"])(
    "should leave %s to the page while the guide is closed",
    (code) => {
      const hotkey = key(code)

      assert.isUndefined(hotkey)
    }
  )

  it("should read I as interacting while the guide is closed", () => {
    const hotkey = key("KeyI")

    assert.deepStrictEqual(hotkey, { _tag: "Interact" })
  })
})

describe("Hotkey.keys", () => {
  it.each(Hotkey.keys)("should list a binding that reads back to its hotkey: $does", (binding) => {
    const press = {
      shift: false,
      alt: false,
      control: false,
      meta: false,
      guideOpen: false,
      ...binding.press
    }

    const hotkey = Hotkey.of(press)

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
  { _tag: "CommandPalette" },
  { _tag: "ShowKeys" },
  { _tag: "Guide" },
  { _tag: "Move", direction: "up" },
  { _tag: "Confirm" },
  { _tag: "NextEntry" },
  { _tag: "PreviousEntry" },
  { _tag: "Info" }
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

type Modifiers = Partial<{
  shift: boolean
  alt: boolean
  control: boolean
  meta: boolean
  guideOpen: boolean
}>

function key(code: string, modifiers: Modifiers = {}) {
  return Hotkey.of({
    code,
    shift: false,
    alt: false,
    control: false,
    meta: false,
    guideOpen: false,
    ...modifiers
  })
}
