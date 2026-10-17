import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { GameSnapshot } from "@sportal/domain/Game"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ArrowUpLeft, ChartNoAxesColumn, Shrink, SquareDashed, Volume2, VolumeX, X } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/design/button"
import { cn } from "@/design/ClassName"
import { DisplayInput } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { GameStatus } from "../game/GameStatus.tsx"
import { Score } from "../game/Score.tsx"
import * as Lineup from "../hub/Lineup.ts"
import { type Screen, Tile } from "./Screen.ts"
import { TileAction } from "./TileAction.ts"
import * as TileRects from "./TileRects.ts"

/**
 * A tile's header strip: its slot, its game and score (a custom tile's name; a channel tile's name and what airs on it
 * now; a stats tile's game, tagged "Stats"; a clip tile's headline, after "Replay"), the on-air tally when its sound
 * is on, and its controls, with Stats beside on a game's stream or data tile. It is a drop target for another tile,
 * which swaps in; and it can itself be dragged.
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
        {Tile.guards.StatsTile(tile) && (
          <span className="label-caps text-[10px] text-muted-foreground">Stats</span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 truncate font-mono">
          {Tile.guards.ChannelTile(tile) ? (
            <ChannelLabel tile={tile} />
          ) : Tile.guards.CustomTile(tile) || Tile.guards.ClipTile(tile) ? (
            <span className="truncate font-sans">{Tile.label(tile, props.game)}</span>
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
        {(Tile.guards.StreamTile(tile) || Tile.guards.DataTile(tile)) && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Stats beside"
            title="Stats beside"
            className="text-muted-foreground"
            onClick={() => input(DisplayInput.StatsBeside({ game: tile.game }))}
          >
            <ChartNoAxesColumn />
          </Button>
        )}
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

/** A channel tile's name, and what airs on it now when the lineup has it. */
function ChannelLabel(props: { tile: typeof Tile.cases.ChannelTile.Type }) {
  const lineup = AsyncResult.getOrElse(useAtomValue(Lineup.lineup), () => [])
  const onNow = lineup.find(
    ({ channel }) =>
      channel.source === props.tile.channel.source && channel.locator.url === props.tile.channel.locator.url
  )
  const title =
    onNow === undefined ? undefined : Option.getOrUndefined(Option.map(onNow.now, ({ title }) => title))
  return (
    <span className="truncate font-sans">
      {props.tile.channel.name}
      {title !== undefined && <span className="text-muted-foreground"> · {title}</span>}
    </span>
  )
}
