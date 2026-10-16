import { Data } from "effect"
import { type Screen, type ScreenCommand, Tile } from "./Screen.ts"

/**
 * One thing that can be done to an on-screen tile. A host renders it as a button or a palette item and sends
 * `command` itself. `verb` is the short form for a list that already names the tile; `key` is the hotkey, in the
 * form `aria-keyshortcuts` takes.
 */
export class TileAction extends Data.Class<{
  readonly id: "hear" | "promote" | "solo" | "unsolo" | "clear"
  readonly verb: string
  readonly label: string
  readonly command: ScreenCommand
  readonly key: string | undefined
}> {
  /**
   * What can be done to the tile in `slot`, in the order every host lists it: hear it (not a stats tile, which has no
   * sound), promote it unless it is the main tile, solo or unsolo it, clear it. An empty tile has none. Solo acts on
   * the selected tile, so only `selected` gives it a key; Escape unsolos from anywhere.
   */
  static of(screen: Screen, slot: number, selected: boolean): ReadonlyArray<TileAction> {
    const tile = screen.onScreen()[slot]
    if (tile === undefined || Tile.guards.Empty(tile)) return []

    const hearLabel = screen.hears(Tile.key(tile)) ? "Sound on" : "Hear this game"
    const hear = new TileAction({
      id: "hear",
      verb: "Hear",
      label: hearLabel,
      command: { _tag: "FocusAudio", tile: slot },
      key: String(slot + 1)
    })
    const promote = new TileAction({
      id: "promote",
      verb: "Promote",
      label: "Promote to the main tile",
      command: { _tag: "Promote", tile: slot },
      key: `Shift+${slot + 1}`
    })
    const solo = screen.soloes(Tile.key(tile))
      ? new TileAction({
          id: "unsolo",
          verb: "Unsolo",
          label: "Unsolo",
          command: { _tag: "Unsolo" },
          key: "Escape"
        })
      : new TileAction({
          id: "solo",
          verb: "Solo",
          label: "Solo",
          command: { _tag: "Solo", tile: slot },
          key: selected ? "F" : undefined
        })
    const clear = new TileAction({
      id: "clear",
      verb: "Clear",
      label: "Clear",
      command: { _tag: "Clear", tile: slot },
      key: undefined
    })
    const heard = Tile.guards.StatsTile(tile) ? [] : [hear]
    return slot === 0 ? [...heard, solo, clear] : [...heard, promote, solo, clear]
  }

  /** The hotkey as a person reads it, in tooltips and the palette: `Shift+2` is "⇧2", `Escape` is "Esc". */
  shortcut(): string | undefined {
    return this.key?.replace("Shift+", "⇧").replace("Escape", "Esc")
  }
}
