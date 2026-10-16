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
    ShowKeys: {},
    /** Open the guide's ribbon, or from the ribbon the full guide. */
    Guide: {},
    /** An arrow, while the guide is open. */
    Move: { direction: Schema.Literals(["up", "down", "left", "right"]) },
    /** Watch what the guide has focused. */
    Confirm: {},
    /** The guide's next entry. */
    NextEntry: {},
    /** The guide's previous entry. */
    PreviousEntry: {},
    /** Open the focused game's page. */
    Info: {}
  }),
  {
    /**
     * What a key press means, read by its physical `code`; none for a key the page should have. While the guide is
     * open, the arrows, Enter, the brackets and I are the guide's.
     */
    of(key: {
      code: string
      shift: boolean
      alt: boolean
      control: boolean
      meta: boolean
      guideOpen: boolean
    }): Hotkey | undefined {
      if (key.control || key.meta) return key.code === "KeyK" ? { _tag: "CommandPalette" } : undefined
      const digit = /^Digit([1-9])$/.exec(key.code)?.[1]
      if (key.alt) return digit === undefined ? undefined : { _tag: "SelectTile", slot: Number(digit) - 1 }
      if (digit !== undefined) return { _tag: key.shift ? "Promote" : "FocusAudio", slot: Number(digit) - 1 }
      const guide = key.guideOpen ? guideKey(key.code) : undefined
      if (guide !== undefined) return guide
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
        case "KeyG":
          return { _tag: "Guide" }
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
        does: "Close what is open (the full guide goes back to the ribbon), or unsolo",
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
      },
      {
        group: "Guide",
        keys: ["G"],
        does: "Open the guide, then the full guide",
        press: { code: "KeyG" },
        hotkey: { _tag: "Guide" }
      },
      {
        group: "Guide",
        keys: ["←", "↑", "→", "↓"],
        does: "Move in the guide (up from the ribbon opens the full guide)",
        press: { code: "ArrowLeft", guideOpen: true },
        hotkey: { _tag: "Move", direction: "left" }
      },
      {
        group: "Guide",
        keys: ["Enter"],
        does: "Watch the focused game in the selected tile",
        press: { code: "Enter", guideOpen: true },
        hotkey: { _tag: "Confirm" }
      },
      {
        group: "Guide",
        keys: ["]"],
        does: "Next league",
        press: { code: "BracketRight", guideOpen: true },
        hotkey: { _tag: "NextEntry" }
      },
      {
        group: "Guide",
        keys: ["["],
        does: "Previous league",
        press: { code: "BracketLeft", guideOpen: true },
        hotkey: { _tag: "PreviousEntry" }
      },
      {
        group: "Guide",
        keys: ["I"],
        does: "The focused game's page",
        press: { code: "KeyI", guideOpen: true },
        hotkey: { _tag: "Info" }
      }
    ] as const
  }
)
export type Hotkey = typeof Hotkey.Type

/** A key that is the guide's while it is open: the arrows, Enter, the brackets, and I. */
function guideKey(code: string): Hotkey | undefined {
  switch (code) {
    case "ArrowUp":
      return { _tag: "Move", direction: "up" }
    case "ArrowDown":
      return { _tag: "Move", direction: "down" }
    case "ArrowLeft":
      return { _tag: "Move", direction: "left" }
    case "ArrowRight":
      return { _tag: "Move", direction: "right" }
    case "Enter":
      return { _tag: "Confirm" }
    case "BracketRight":
      return { _tag: "NextEntry" }
    case "BracketLeft":
      return { _tag: "PreviousEntry" }
    case "KeyI":
      return { _tag: "Info" }
    default:
      return undefined
  }
}
