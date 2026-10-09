import { ArrowUpLeft, Shrink, SquareDashed, Volume2, VolumeX, X } from "lucide-react"
import type { ReactNode } from "react"
import { type Screen, type ScreenCommand, Tile } from "./Screen.ts"

/**
 * What can be done to the tile in `slot`, in the order every host lists it: hear it, promote it unless it is the
 * main tile, solo or unsolo it, clear it. An empty tile has none. A host renders them as buttons, sheet rows, or
 * palette items, and sends `command` itself. `verb` is the short form for a list that already names the tile;
 * `key` is the hotkey, in the form `aria-keyshortcuts` takes; solo acts on the selected tile, so only
 * `selected` (whether `slot` is it) gives it one; Escape unsolos from anywhere.
 */
export function tileActions(
  screen: Screen,
  slot: number,
  selected: boolean
): ReadonlyArray<{
  id: "hear" | "promote" | "solo" | "unsolo" | "clear"
  verb: string
  label: string
  icon: ReactNode
  command: ScreenCommand
  key: string | undefined
}> {
  const tile = screen.onScreen()[slot]
  if (tile === undefined || Tile.guards.Empty(tile)) return []
  const hearing = screen.hears(tile.game)
  return [
    {
      id: "hear",
      verb: "Hear",
      label: hearing ? "Sound on" : "Hear this game",
      icon: hearing ? <Volume2 /> : <VolumeX />,
      command: { _tag: "FocusAudio", tile: slot },
      key: String(slot + 1)
    },
    ...(slot === 0
      ? []
      : [
          {
            id: "promote" as const,
            verb: "Promote",
            label: "Promote to the main tile",
            icon: <ArrowUpLeft />,
            command: { _tag: "Promote", tile: slot } satisfies ScreenCommand,
            key: `Shift+${slot + 1}`
          }
        ]),
    screen.soloes(tile.game)
      ? {
          id: "unsolo",
          verb: "Unsolo",
          label: "Unsolo",
          icon: <Shrink />,
          command: { _tag: "Unsolo" },
          key: "Escape"
        }
      : {
          id: "solo",
          verb: "Solo",
          label: "Solo",
          icon: <SquareDashed />,
          command: { _tag: "Solo", tile: slot },
          key: selected ? "F" : undefined
        },
    {
      id: "clear",
      verb: "Clear",
      label: "Clear",
      icon: <X />,
      command: { _tag: "Clear", tile: slot },
      key: undefined
    }
  ]
}

/** A hotkey as a person reads it, in tooltips and the palette: `Shift+2` is "⇧2", `Escape` is "Esc". */
export function keyText(key: string): string {
  return key.replace("Shift+", "⇧").replace("Escape", "Esc")
}
