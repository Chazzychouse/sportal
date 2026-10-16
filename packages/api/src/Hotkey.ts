import { Schema } from "effect"

/** A key Sportal acts on, wherever it was pressed: in the web UI, or in a stream view that had focus. */
export const Hotkey = Object.assign(
  Schema.TaggedUnion({
    FocusAudio: { slot: Schema.Int },
    Promote: { slot: Schema.Int },
    /** Make a tile the one the next chosen game goes to. */
    SelectTile: { slot: Schema.Int },
    /** Give the selected tile's player the mouse, or take it back. */
    Interact: {},
    ToggleSolo: {},
    Unsolo: {},
    FullScreen: {},
    NextLayout: {},
    CommandPalette: {},
    ShowKeys: {}
  }),
  {
    /** What a key press means, read by its physical `code`; none for a key the page should have. */
    of(key: {
      code: string
      shift: boolean
      alt: boolean
      control: boolean
      meta: boolean
    }): Hotkey | undefined {
      if (key.control || key.meta) return key.code === "KeyK" ? { _tag: "CommandPalette" } : undefined
      const digit = /^Digit([1-9])$/.exec(key.code)?.[1]
      if (key.alt) return digit === undefined ? undefined : { _tag: "SelectTile", slot: Number(digit) - 1 }
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
        case "KeyI":
          return { _tag: "Interact" }
        case "Slash":
          return key.shift ? { _tag: "ShowKeys" } : undefined
        default:
          return undefined
      }
    },

    /**
     * Every binding as the key help shows it: its keys, what it does, and its group. `press` is one press of
     * it, which `Hotkey.of` reads back to `hotkey`, so the help cannot drift from the bindings.
     */
    keys: [
      {
        group: "Tiles",
        keys: ["Alt", "1–9"],
        does: "Select that tile, for the next game (a choice selects the next empty one)",
        press: { code: "Digit3", alt: true },
        hotkey: { _tag: "SelectTile", slot: 2 }
      },
      {
        group: "Tiles",
        keys: ["1–9"],
        does: "Hear that tile",
        press: { code: "Digit1" },
        hotkey: { _tag: "FocusAudio", slot: 0 }
      },
      {
        group: "Tiles",
        keys: ["Shift", "1–9"],
        does: "Promote that tile to the main tile",
        press: { code: "Digit2", shift: true },
        hotkey: { _tag: "Promote", slot: 1 }
      },
      {
        group: "Tiles",
        keys: ["F"],
        does: "Solo the selected tile, or unsolo",
        press: { code: "KeyF" },
        hotkey: { _tag: "ToggleSolo" }
      },
      {
        group: "Tiles",
        keys: ["I"],
        does: "Use the selected tile's player with the mouse, or stop",
        press: { code: "KeyI" },
        hotkey: { _tag: "Interact" }
      },
      {
        group: "Tiles",
        keys: ["Esc"],
        does: "Close what is open, or unsolo",
        press: { code: "Escape" },
        hotkey: { _tag: "Unsolo" }
      },
      {
        group: "Screen",
        keys: ["L"],
        does: "Next layout",
        press: { code: "KeyL" },
        hotkey: { _tag: "NextLayout" }
      },
      {
        group: "Screen",
        keys: ["F11"],
        does: "Full screen",
        press: { code: "F11" },
        hotkey: { _tag: "FullScreen" }
      },
      {
        group: "Screen",
        keys: ["Ctrl", "K"],
        does: "Command palette",
        press: { code: "KeyK", control: true },
        hotkey: { _tag: "CommandPalette" }
      },
      {
        group: "Screen",
        keys: ["?"],
        does: "These keys",
        press: { code: "Slash", shift: true },
        hotkey: { _tag: "ShowKeys" }
      }
    ] as const
  }
)
export type Hotkey = typeof Hotkey.Type
