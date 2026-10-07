import type { GameSnapshot } from "@sportal/domain/Game"
import type { Stage, Tile } from "@sportal/domain/Stage"
import { Button } from "@/design/button"
import { cn } from "@/design/ClassName"
import { GameStatus } from "../game/GameStatus.tsx"
import { Score } from "../game/Score.tsx"
import { dispatch } from "../hub/HubClient.ts"
import { runtime } from "../hub/HubRuntime.ts"
import { keyText, tileActions } from "./TileActions.tsx"
import { tileHeader } from "./TileRects.ts"

/**
 * A tile's header strip: its slot, its game and score, the on-air tally when its sound is on, and its controls.
 * It is a drop target for another tile or a benched game, which swaps in; and it can itself be dragged.
 */
export function TileChrome(props: {
  stage: Stage
  slot: number
  tile: Tile
  game: GameSnapshot | undefined
  selected: boolean
  onSelect: () => void
}) {
  const { tile, slot } = props
  const onAir = tile._tag !== "Empty" && props.stage.hears(tile.game)

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dragging is a shortcut; every swap is also in the command palette.
    <div
      draggable={tile._tag !== "Empty"}
      onDragStart={(event) => event.dataTransfer.setData(tileDrag, String(slot))}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(tileDrag)) event.preventDefault()
      }}
      onDrop={(event) => {
        const from = Number(event.dataTransfer.getData(tileDrag))
        if (Number.isInteger(from) && from !== slot)
          runtime.runFork(dispatch({ _tag: "Swap", a: from, b: slot }))
      }}
      style={{ height: tileHeader }}
      className={`flex shrink-0 items-center gap-2 border-b px-1.5 text-xs ${
        onAir ? "border-on-air/60 bg-on-air/10" : "bg-card"
      }`}
    >
      <button
        type="button"
        onClick={props.onSelect}
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
          {props.game === undefined ? (
            <span className="font-sans text-muted-foreground">
              {tile._tag === "Empty" ? "Empty — pick a game" : "Loading…"}
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
        {tileActions(props.stage, slot, props.selected).map((action) => (
          <Button
            key={action.id}
            variant="ghost"
            size="icon-xs"
            aria-label={action.label}
            aria-keyshortcuts={action.key}
            title={action.key === undefined ? action.label : `${action.label} · ${keyText(action.key)}`}
            className={cn(
              "text-muted-foreground",
              action.id === "hear" && onAir && "text-on-air",
              action.id === "clear" && "hover:text-destructive"
            )}
            onClick={() => runtime.runFork(dispatch(action.command))}
          >
            {action.icon}
          </Button>
        ))}
      </span>
    </div>
  )
}

/** The drag data type of a tile or benched game being dragged: its index in the Stage's tiles. */
export const tileDrag = "application/x-sportal-tile"
