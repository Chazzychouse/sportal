import type { Stage, StageCommand } from "@sportal/domain/Stage"
import { ArrowUpLeft, Shrink, SquareDashed, Volume2, VolumeX, X } from "lucide-react"
import type { ReactNode } from "react"

/**
 * What can be done to the tile in `slot`, in the order every host lists it: hear it, promote it unless it is the
 * main tile, solo or unsolo it, clear it. An empty tile has none. A host renders them as buttons, sheet rows, or
 * palette items, and sends `command` itself. `verb` is the short form for a list that already names the tile;
 * `key` is the hotkey, in the form `aria-keyshortcuts` takes.
 */
export function tileActions(
  stage: Stage,
  slot: number
): ReadonlyArray<{
  id: "hear" | "promote" | "solo" | "unsolo" | "clear"
  verb: string
  label: string
  icon: ReactNode
  command: StageCommand
  key: string | undefined
}> {
  const tile = stage.onStage()[slot]
  if (tile === undefined || tile._tag === "Empty") return []
  const hearing = stage.hears(tile.game)
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
            command: { _tag: "Promote", tile: slot } satisfies StageCommand,
            key: `Shift+${slot + 1}`
          }
        ]),
    stage.soloes(tile.game)
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
          key: undefined
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
