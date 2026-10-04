import type { GameSnapshot } from "@sportal/domain/Game"
import type { Stage, StageCommand } from "@sportal/domain/Stage"
import { ArrowLeftRight, ArrowUpLeft, Shrink, SquareDashed, Volume2, X } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/design/sheet"
import { dispatch } from "../hub/HubClient.ts"
import { statusText } from "../slate/StatusText.ts"
import { TeamLogo } from "../slate/TeamLogo.tsx"

/**
 * The Stage's layout in miniature, every tile shown even while one is soloed. Tapping a tile selects it; tapping
 * the selected one opens its actions. "Swap with…" waits for the next tile tapped.
 */
export function StageMap(props: {
  stage: Stage
  slate: ReadonlyArray<GameSnapshot>
  selected: number
  onSelect: (slot: number) => void
}) {
  const [actions, setActions] = useState(false)
  const [swapFrom, setSwapFrom] = useState<number | undefined>(undefined)
  const tiles = props.stage.onStage()
  const tile = tiles[props.selected]
  const gameIn = (slot: number) => {
    const at = tiles[slot]
    return at === undefined || at._tag === "Empty"
      ? undefined
      : props.slate.find((game) => game.id === at.game)
  }
  const run = (command: StageCommand) => {
    dispatch(command)
    setActions(false)
  }
  const tap = (slot: number) => {
    if (swapFrom !== undefined) {
      if (slot !== swapFrom) dispatch({ _tag: "Swap", a: swapFrom, b: slot })
      setSwapFrom(undefined)
      return props.onSelect(slot)
    }
    if (slot === props.selected && tiles[slot]?._tag !== "Empty") return setActions(true)
    props.onSelect(slot)
  }

  return (
    <>
      <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-well">
        {props.stage
          .currentLayout()
          .slots()
          .map((slot, index) => {
            const at = tiles[index]
            const game = gameIn(index)
            const onAir = at !== undefined && at._tag !== "Empty" && props.stage.audioFocus === at.game
            const soloed = at !== undefined && at._tag !== "Empty" && props.stage.solo === at.game
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: a slot is identified by its place in the layout.
                key={index}
                type="button"
                onClick={() => tap(index)}
                aria-pressed={props.selected === index}
                aria-label={`Tile ${index + 1}${game === undefined ? ", empty" : `, ${game.away.team.name} at ${game.home.team.name}`}`}
                style={{
                  left: `${slot.x * 100}%`,
                  top: `${slot.y * 100}%`,
                  width: `${slot.width * 100}%`,
                  height: `${slot.height * 100}%`
                }}
                className="absolute p-0.5"
              >
                <span
                  className={`flex h-full w-full flex-col gap-0.5 overflow-hidden rounded-sm border p-1 text-left ${
                    props.selected === index
                      ? "border-foreground bg-accent"
                      : onAir
                        ? "border-on-air/60 bg-on-air/10"
                        : "border-border bg-card"
                  } ${swapFrom !== undefined && swapFrom !== index ? "border-dashed" : ""}`}
                >
                  <span className="flex items-center gap-1">
                    <span
                      className={`grid size-4 shrink-0 place-items-center rounded-sm font-mono text-[10px] ${
                        props.selected === index
                          ? "bg-foreground text-background"
                          : "bg-secondary text-muted-foreground"
                      }`}
                    >
                      {index + 1}
                    </span>
                    {onAir && <Volume2 className="size-3 text-on-air" />}
                    {soloed && <span className="label-caps text-[9px] text-on-air">Solo</span>}
                  </span>
                  {game === undefined ? (
                    <span className="m-auto text-[10px] text-muted-foreground">
                      {at?._tag === "Empty" ? "Empty" : "Loading…"}
                    </span>
                  ) : (
                    <span className="flex min-h-0 flex-1 flex-col justify-center gap-0.5 font-mono text-[11px] tabular-nums">
                      {[game.away, game.home].map((side) => (
                        <span key={side.team.id} className="flex items-center gap-1">
                          <TeamLogo team={side.team} size={14} />
                          <span className="truncate font-semibold">{side.team.abbreviation}</span>
                          <span className="ml-auto">{game.progress() === "upcoming" ? "" : side.score}</span>
                        </span>
                      ))}
                      <span
                        className={`label-caps truncate text-[9px] ${game.isLive() ? "text-live" : "text-muted-foreground"}`}
                      >
                        {statusText(game)}
                      </span>
                    </span>
                  )}
                </span>
              </button>
            )
          })}
      </div>
      {swapFrom !== undefined && (
        <div className="flex items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm">
          <span>Tap the tile to swap with tile {swapFrom + 1}</span>
          <button type="button" className="text-muted-foreground" onClick={() => setSwapFrom(undefined)}>
            Cancel
          </button>
        </div>
      )}
      <Sheet open={actions} onOpenChange={setActions}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="gap-0 pb-[env(safe-area-inset-bottom)]"
        >
          <div className="px-4 pt-4 pb-2">
            <SheetTitle className="label-caps text-xs">Tile {props.selected + 1}</SheetTitle>
            <SheetDescription className="font-mono text-sm">
              {(() => {
                const game = gameIn(props.selected)
                return game === undefined
                  ? ""
                  : `${game.away.team.abbreviation} ${game.away.score}–${game.home.score} ${game.home.team.abbreviation}`
              })()}
            </SheetDescription>
          </div>
          {tile !== undefined && tile._tag !== "Empty" && (
            <div className="flex flex-col pb-2">
              <Action icon={<Volume2 />} onClick={() => run({ _tag: "FocusAudio", tile: props.selected })}>
                Hear this game
              </Action>
              {props.selected !== 0 && (
                <Action icon={<ArrowUpLeft />} onClick={() => run({ _tag: "Promote", tile: props.selected })}>
                  Promote to the main tile
                </Action>
              )}
              {props.stage.solo === tile.game ? (
                <Action icon={<Shrink />} onClick={() => run({ _tag: "Unsolo" })}>
                  Unsolo
                </Action>
              ) : (
                <Action icon={<SquareDashed />} onClick={() => run({ _tag: "Solo", tile: props.selected })}>
                  Solo
                </Action>
              )}
              <Action
                icon={<ArrowLeftRight />}
                onClick={() => {
                  setSwapFrom(props.selected)
                  setActions(false)
                }}
              >
                Swap with…
              </Action>
              <Action icon={<X />} onClick={() => run({ _tag: "Clear", tile: props.selected })} destructive>
                Clear
              </Action>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}

function Action(props: { icon: ReactNode; onClick: () => void; destructive?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`flex min-h-12 items-center gap-3 px-4 text-left text-sm active:bg-accent [&_svg]:size-4 ${
        props.destructive === true ? "text-destructive" : ""
      }`}
    >
      {props.icon}
      {props.children}
    </button>
  )
}
