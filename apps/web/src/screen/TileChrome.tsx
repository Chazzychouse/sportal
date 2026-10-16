import { useAtomSet } from "@effect/atom-react"
import type { GameSnapshot } from "@sportal/domain/Game"
import { ArrowUpLeft, Shrink, SquareDashed, Volume2, VolumeX, X } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/design/button"
import { cn } from "@/design/ClassName"
import { DisplayInput } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { GameStatus } from "../game/GameStatus.tsx"
import { Score } from "../game/Score.tsx"
import { type Screen, Tile } from "./Screen.ts"
import { TileAction } from "./TileAction.ts"
import * as TileRects from "./TileRects.ts"

/**
 * A tile's header strip: its slot, its game and score (a custom tile's name), the on-air tally when its sound is on, and its controls.
 * It is a drop target for another tile, which swaps in; and it can itself be dragged.
 */
export function TileChrome(props: {
  screen: Screen
  slot: number
  tile: Tile
  game: GameSnapshot | undefined
  selected: boolean
}) {
  const input = useAtomSet(DisplayState.display)
  const { tile, slot } = props
  const onAir = !Tile.guards.Empty(tile) && props.screen.hears(Tile.key(tile))

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dragging is a shortcut; every swap is also in the command palette.
    <div
      draggable={!Tile.guards.Empty(tile)}
      onDragStart={(event) => event.dataTransfer.setData(tileDrag, String(slot))}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(tileDrag)) event.preventDefault()
      }}
      onDrop={(event) => {
        const from = Number(event.dataTransfer.getData(tileDrag))
        if (Number.isInteger(from) && from !== slot)
          input(DisplayInput.Commanded({ command: { _tag: "Swap", a: from, b: slot } }))
      }}
      style={{ height: TileRects.tileHeader }}
      className={`flex shrink-0 items-center gap-2 border-b px-1.5 text-xs ${
        onAir ? "border-on-air/60 bg-on-air/10" : "bg-card"
      }`}
    >
      <button
        type="button"
        onClick={() => input(DisplayInput.Selected({ slot }))}
        aria-keyshortcuts={`Alt+${slot + 1}`}
        title={`Select tile ${slot + 1} · Alt ${slot + 1}`}
        className={`flex min-w-0 flex-1 items-center gap-2 text-left ${props.selected ? "" : "opacity-90"}`}
      >
        <span
          className={`grid size-5 shrink-0 place-items-center rounded-sm font-mono text-[11px] ${
            props.selected ? "bg-foreground text-background" : "bg-secondary text-muted-foreground"
          }`}
        >
          {slot + 1}
        </span>
        {onAir && (
          <span className="label-caps rounded-[2px] bg-on-air px-1 text-[10px] text-background">On air</span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 truncate font-mono">
          {Tile.guards.CustomTile(tile) ? (
            <span className="truncate font-sans">{tile.name}</span>
          ) : props.game === undefined ? (
            <span className="font-sans text-muted-foreground">
              {Tile.guards.Empty(tile) ? "Empty — G to choose a game" : "Loading…"}
            </span>
          ) : (
            <>
              <Score game={props.game} side="away" />
              {props.game.scored() && <span className="text-muted-foreground">–</span>}
              <Score game={props.game} side="home" />
              <GameStatus game={props.game} className="ml-1.5 truncate text-[11px]" />
            </>
          )}
        </span>
      </button>
      <span className="flex shrink-0 items-center">
        {TileAction.of(props.screen, slot, props.selected).map((action) => {
          const shortcut = action.shortcut()
          return (
            <Button
              key={action.id}
              variant="ghost"
              size="icon-xs"
              aria-label={action.label}
              aria-keyshortcuts={action.key}
              title={shortcut === undefined ? action.label : `${action.label} · ${shortcut}`}
              className={cn(
                "text-muted-foreground",
                action.id === "hear" && onAir && "text-on-air",
                action.id === "clear" && "hover:text-destructive"
              )}
              onClick={() => input(DisplayInput.Commanded({ command: action.command }))}
            >
              {iconOf(action, onAir)}
            </Button>
          )
        })}
      </span>
    </div>
  )
}

/** An action's icon; hear shows whether the tile's sound is on. */
function iconOf(action: TileAction, hearing: boolean): ReactNode {
  switch (action.id) {
    case "hear":
      return hearing ? <Volume2 /> : <VolumeX />
    case "promote":
      return <ArrowUpLeft />
    case "solo":
      return <SquareDashed />
    case "unsolo":
      return <Shrink />
    case "clear":
      return <X />
  }
}

/** The drag data type of a tile being dragged: its index in the Screen's tiles. */
const tileDrag = "application/x-sportal-tile"
