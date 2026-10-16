import { Schema } from "effect"

/** A key Sportal acts on, wherever it was pressed: in the web UI, or in a stream view that had focus. */
export const Hotkey = Object.assign(
  Schema.TaggedUnion({
    FocusAudio: { slot: Schema.Int },
    Promote: { slot: Schema.Int },
    /** Make a tile the one the next dropped game goes to. */
    SelectTile: { slot: Schema.Int },
    /** Give the selected tile's player the mouse, or take it back. */
    Interact: {},
    ToggleSolo: {},
    Unsolo: {},
    FullScreen: {},
    NextLayout: {},
    ToggleSlate: {},
    CommandPalette: {},
    /** Move the slate's pick to the previous or next game that can be picked. */
    StepPick: { step: Schema.Literals([-1, 1]) },
    /** Put the picked game in the selected tile. */
    DropPick: {},
    ShowKeys: {}
  }),
  {
    /**
     * What a key press means, read by its physical `code`; none for a key the page should have. Enter is a
     * hotkey only when pressed in the page: in a stream view it stays the player's.
     */
    of(
      key: { code: string; shift: boolean; alt: boolean; control: boolean; meta: boolean },
      from: "page" | "stream"
    ): Hotkey | undefined {
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
        case "KeyS":
          return { _tag: "ToggleSlate" }
        case "BracketLeft":
          return { _tag: "StepPick", step: -1 }
        case "BracketRight":
          return { _tag: "StepPick", step: 1 }
        case "Enter":
        case "NumpadEnter":
          return from === "page" ? { _tag: "DropPick" } : undefined
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
        group: "Strip",
        keys: ["S"],
        does: "Show or hide the slate",
        press: { code: "KeyS", from: "stream" },
        hotkey: { _tag: "ToggleSlate" }
      },
      {
        group: "Strip",
        keys: ["[", "]"],
        does: "Pick the previous or next game",
        press: { code: "BracketRight", from: "stream" },
        hotkey: { _tag: "StepPick", step: 1 }
      },
      {
        group: "Strip",
        keys: ["Enter"],
        does: "Put the picked game in the selected tile",
        press: { code: "Enter", from: "page" },
        hotkey: { _tag: "DropPick" }
      },
      {
        group: "Tiles",
        keys: ["Alt", "1–9"],
        does: "Select that tile, for the next game (a drop selects the next empty one)",
        press: { code: "Digit3", alt: true, from: "stream" },
        hotkey: { _tag: "SelectTile", slot: 2 }
      },
      {
        group: "Tiles",
        keys: ["1–9"],
        does: "Hear that tile",
        press: { code: "Digit1", from: "stream" },
        hotkey: { _tag: "FocusAudio", slot: 0 }
      },
      {
        group: "Tiles",
        keys: ["Shift", "1–9"],
        does: "Promote that tile to the main tile",
        press: { code: "Digit2", shift: true, from: "stream" },
        hotkey: { _tag: "Promote", slot: 1 }
      },
      {
        group: "Tiles",
        keys: ["F"],
        does: "Solo the selected tile, or unsolo",
        press: { code: "KeyF", from: "stream" },
        hotkey: { _tag: "ToggleSolo" }
      },
      {
        group: "Tiles",
        keys: ["I"],
        does: "Use the selected tile's player with the mouse, or stop",
        press: { code: "KeyI", from: "stream" },
        hotkey: { _tag: "Interact" }
      },
      {
        group: "Tiles",
        keys: ["Esc"],
        does: "Close what is open, or unsolo",
        press: { code: "Escape", from: "stream" },
        hotkey: { _tag: "Unsolo" }
      },
      {
        group: "Screen",
        keys: ["L"],
        does: "Next layout",
        press: { code: "KeyL", from: "stream" },
        hotkey: { _tag: "NextLayout" }
      },
      {
        group: "Screen",
        keys: ["F11"],
        does: "Full screen",
        press: { code: "F11", from: "stream" },
        hotkey: { _tag: "FullScreen" }
      },
      {
        group: "Screen",
        keys: ["Ctrl", "K"],
        does: "Command palette",
        press: { code: "KeyK", control: true, from: "stream" },
        hotkey: { _tag: "CommandPalette" }
      },
      {
        group: "Screen",
        keys: ["?"],
        does: "These keys",
        press: { code: "Slash", shift: true, from: "stream" },
        hotkey: { _tag: "ShowKeys" }
      }
    ] as const
  }
)
export type Hotkey = typeof Hotkey.Type
