import type { GameSnapshot } from "@sportal/domain/Game"
import type { Stage, Tile } from "@sportal/domain/Stage"
import { ArrowUpLeft, Shrink, SquareDashed, Volume2, VolumeX, X } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/design/button"
import { dispatch } from "../hub/HubClient.ts"
import { statusText } from "../slate/StatusText.ts"
import { TeamLogo } from "../slate/TeamLogo.tsx"

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
  children?: ReactNode
}) {
  const { tile, slot } = props
  const onAir = tile._tag !== "Empty" && props.stage.audioFocus === tile.game
  const soloed = tile._tag !== "Empty" && props.stage.solo === tile.game
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
        if (Number.isInteger(from) && from !== slot) dispatch({ _tag: "Swap", a: from, b: slot })
      }}
      className={`flex h-7 shrink-0 items-center gap-2 border-b px-1.5 text-xs ${
        onAir ? "border-on-air/60 bg-on-air/10" : "bg-card"
      }`}
    >
      <button
        type="button"
        onClick={props.onSelect}
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
              <TeamLogo team={props.game.away.team} size={14} />
              <span className="font-semibold">{props.game.away.team.abbreviation}</span>
              {props.game.away.score}
              <span className="text-muted-foreground">–</span>
              {props.game.home.score}
              <span className="font-semibold">{props.game.home.team.abbreviation}</span>
              <TeamLogo team={props.game.home.team} size={14} />
              <span
                className={`label-caps ml-1.5 truncate text-[11px] ${props.game.isLive() ? "text-live" : "text-muted-foreground"}`}
              >
                {statusText(props.game)}
              </span>
            </>
          )}
        </span>
      </button>
      {props.children}
      {tile._tag !== "Empty" && (
        <span className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={onAir ? "Sound on" : "Hear this game"}
            aria-keyshortcuts={String(slot + 1)}
            title={`${onAir ? "Sound on" : "Hear this game"} · ${slot + 1}`}
            className={onAir ? "text-on-air" : "text-muted-foreground"}
            onClick={() => dispatch({ _tag: "FocusAudio", tile: slot })}
          >
            {onAir ? <Volume2 /> : <VolumeX />}
          </Button>
          {slot !== 0 && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Promote to the main tile"
              aria-keyshortcuts={`Shift+${slot + 1}`}
              title={`Promote to the main tile · Shift ${slot + 1}`}
              className="text-muted-foreground"
              onClick={() => dispatch({ _tag: "Promote", tile: slot })}
            >
              <ArrowUpLeft />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={soloed ? "Unsolo" : "Solo"}
            title={soloed ? "Unsolo · Esc" : "Solo · select, then F"}
            className="text-muted-foreground"
            onClick={() => dispatch(soloed ? { _tag: "Unsolo" } : { _tag: "Solo", tile: slot })}
          >
            {soloed ? <Shrink /> : <SquareDashed />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Clear"
            title="Clear"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => dispatch({ _tag: "Clear", tile: slot })}
          >
            <X />
          </Button>
        </span>
      )}
    </div>
  )
}

/** The drag data type of a tile or benched game being dragged: its index in the Stage's tiles. */
export const tileDrag = "application/x-sportal-tile"
