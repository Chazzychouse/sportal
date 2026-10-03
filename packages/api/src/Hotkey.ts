import { Schema } from "effect"

/** A key Sportal acts on, wherever it was pressed: in the web UI, or in a stream view that had focus. */
export const Hotkey = Object.assign(
  Schema.Union([
    Schema.TaggedStruct("FocusAudio", { slot: Schema.Int }),
    Schema.TaggedStruct("Promote", { slot: Schema.Int }),
    Schema.TaggedStruct("ToggleSolo", {}),
    Schema.TaggedStruct("Unsolo", {}),
    Schema.TaggedStruct("FullScreen", {}),
    Schema.TaggedStruct("NextLayout", {}),
    Schema.TaggedStruct("ToggleSlate", {}),
    Schema.TaggedStruct("CommandPalette", {})
  ]),
  {
    /** What a key press means, read by its physical `code`; none for a key the page should have. */
    of(key: { code: string; shift: boolean; control: boolean; meta: boolean }): Hotkey | undefined {
      if (key.control || key.meta) return key.code === "KeyK" ? { _tag: "CommandPalette" } : undefined
      const digit = /^Digit([1-9])$/.exec(key.code)?.[1]
      if (digit !== undefined) return { _tag: key.shift ? "Promote" : "FocusAudio", slot: Number(digit) - 1 }
      switch (key.code) {
        case "KeyF":
          return { _tag: "ToggleSolo" }
        case "Escape":
          return { _tag: "Unsolo" }
        case "F11":
          return { _tag: "FullScreen" }
        case "KeyL":
          return { _tag: "NextLayout" }
        case "KeyS":
          return { _tag: "ToggleSlate" }
        default:
          return undefined
      }
    }
  }
)
export type Hotkey = typeof Hotkey.Type
