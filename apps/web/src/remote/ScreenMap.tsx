import type { ListedGame } from "@sportal/api/ListedGame"
import { Data } from "effect"
import { ArrowLeftRight, ArrowUpToLine, Shrink, SquareDashed, Volume2, X } from "lucide-react"
import { Fragment, type ReactNode, useState } from "react"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/design/sheet"
import { GameStatus } from "../game/GameStatus.tsx"
import { Score } from "../game/Score.tsx"
import { Layout } from "../layout/Layout.ts"
import { type Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"
import { TileAction } from "../screen/TileAction.ts"

/**
 * The Screen's layout in miniature, every tile shown even while one is soloed; a custom or clip tile by its name, a
 * stats tile as "Stats" and its game. Tapping a tile selects it; tapping the selected one opens its actions. "Swap
 * with…" waits for the next tile tapped.
 */
export function ScreenMap(props: {
  screen: Screen
  games: ReadonlyArray<ListedGame>
  selected: number
  onSelect: (slot: number) => void
  onCommand: (command: ScreenCommand) => void
}) {
  const [mode, setMode] = useState<Mode>(Mode.Idle())
  const tiles = props.screen.onScreen()
  const gameIn = (slot: number) => {
    const at = tiles[slot]
    const game = at === undefined ? undefined : Tile.game(at)
    return game === undefined ? undefined : props.games.find(({ snapshot }) => snapshot.id === game)?.snapshot
  }
  const nameIn = (slot: number) => {
    const at = tiles[slot]
    return at === undefined ? undefined : Tile.label(at, gameIn(slot))
  }
  const titleIn = (slot: number) => {
    const at = tiles[slot]
    return at !== undefined && (Tile.guards.CustomTile(at) || Tile.guards.ClipTile(at))
      ? nameIn(slot)
      : undefined
  }
  const run = (command: ScreenCommand) => {
    props.onCommand(command)
    setMode(Mode.Idle())
  }
  const tap = (slot: number) => {
    if (Mode.$is("Swapping")(mode)) {
      if (slot !== mode.from) props.onCommand({ _tag: "Swap", a: mode.from, b: slot })
      setMode(Mode.Idle())
      return props.onSelect(slot)
    }
    if (slot === props.selected && !Tile.guards.Empty(tiles[slot])) return setMode(Mode.Actions())
    props.onSelect(slot)
  }

  return (
    <>
      <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-well">
        {Layout.of(props.screen)
          .slots()
          .map((slot, index) => {
            const at = tiles[index]
            const game = gameIn(index)
            const title = titleIn(index)
            const onAir = at !== undefined && !Tile.guards.Empty(at) && props.screen.hears(Tile.key(at))
            const soloed = at !== undefined && !Tile.guards.Empty(at) && props.screen.soloes(Tile.key(at))

            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: a slot is identified by its place in the layout.
                key={index}
                type="button"
                onClick={() => tap(index)}
                aria-pressed={props.selected === index}
                aria-label={`Tile ${index + 1}${Tile.guards.Empty(at) ? ", empty" : `, ${nameIn(index) ?? "loading"}`}`}
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
                  } ${Mode.$is("Swapping")(mode) && mode.from !== index ? "border-dashed" : ""}`}
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
                    {at !== undefined && Tile.guards.StatsTile(at) && (
                      <span className="label-caps text-[9px] text-muted-foreground">Stats</span>
                    )}
                  </span>
                  {title !== undefined ? (
                    <span className="m-auto line-clamp-3 px-0.5 text-center text-[11px]">{title}</span>
                  ) : game === undefined ? (
                    <span className="m-auto text-[10px] text-muted-foreground">
                      {Tile.guards.Empty(at) ? "Empty" : "Loading…"}
                    </span>
                  ) : (
                    <span className="flex min-h-0 flex-1 flex-col justify-center gap-0.5 font-mono text-[11px] tabular-nums">
                      {(["away", "home"] as const).map((side) => (
                        <span key={side} className="flex items-center gap-1">
                          <Score game={game} side={side} />
                        </span>
                      ))}
                      <GameStatus game={game} className="truncate text-[9px]" />
                    </span>
                  )}
                </span>
              </button>
            )
          })}
      </div>
      {Mode.$is("Swapping")(mode) && (
        <div className="flex items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm">
          <span>Tap the tile to swap with tile {mode.from + 1}</span>
          <button type="button" className="text-muted-foreground" onClick={() => setMode(Mode.Idle())}>
            Cancel
          </button>
        </div>
      )}
      <Sheet
        open={Mode.$is("Actions")(mode)}
        onOpenChange={(open) => setMode(open ? Mode.Actions() : Mode.Idle())}
      >
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="gap-0 pb-[env(safe-area-inset-bottom)]"
        >
          <div className="px-4 pt-4 pb-2">
            <SheetTitle className="label-caps text-xs">Tile {props.selected + 1}</SheetTitle>
            <SheetDescription className="font-mono text-sm">{nameIn(props.selected) ?? ""}</SheetDescription>
          </div>
          <div className="flex flex-col pb-2">
            {TileAction.of(props.screen, props.selected, true).map((action) => (
              <Fragment key={action.id}>
                {action.id === "clear" && (
                  <Action
                    icon={<ArrowLeftRight />}
                    onClick={() => setMode(Mode.Swapping({ from: props.selected }))}
                  >
                    Swap with…
                  </Action>
                )}
                <Action
                  icon={<ActionIcon id={action.id} />}
                  onClick={() => run(action.command)}
                  destructive={action.id === "clear"}
                >
                  {action.label}
                </Action>
              </Fragment>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

/** What a tap does next: select a tile, act from the open sheet, or finish a swap from tile `from`. */
type Mode = Data.TaggedEnum<{ Idle: object; Actions: object; Swapping: { readonly from: number } }>
const Mode = Data.taggedEnum<Mode>()

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

function ActionIcon(props: { id: TileAction["id"] }) {
  const Icon = actionIcons[props.id]
  return <Icon />
}

const actionIcons = { hear: Volume2, promote: ArrowUpToLine, solo: SquareDashed, unsolo: Shrink, clear: X }
