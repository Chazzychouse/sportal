import { GameSnapshot } from "@sportal/domain/Game"
import { Layout } from "@sportal/domain/Layout"
import type { Stage } from "@sportal/domain/Stage"
import { ChevronRight } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/design/sheet"
import { dispatch } from "../hub/HubClient.ts"
import { tileDrag } from "../stage/TileChrome.tsx"
import { statusText } from "./StatusText.ts"

/**
 * The slate as a drawer over the Stage's left edge: the bench, then live, upcoming, and final games. Picking a
 * game puts it in the selected tile and closes the drawer. Non-modal, so a bench game can be dragged onto a tile.
 */
export function SlateView(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  stage: Stage
  slate: ReadonlyArray<GameSnapshot>
  selected: number
  fullScreen: boolean
}) {
  const [finalsOpen, setFinalsOpen] = useState(false)
  const first = Layout.slotCount(props.stage.layout)
  const benched = props.stage.tiles.flatMap((tile, index) =>
    index < first || tile._tag === "Empty" ? [] : [{ index, id: tile.game }]
  )
  const placeOf = (game: GameSnapshot) => {
    const slot = props.stage.slotOf(game.id)
    if (slot !== undefined) return `T${slot + 1}`
    return benched.some(({ id }) => id === game.id) ? "Bench" : undefined
  }
  const ordered = [...props.slate].sort(GameSnapshot.watchOrder)
  const inProgress = (progress: ReturnType<GameSnapshot["progress"]>) =>
    ordered.filter((game) => game.progress() === progress)
  const live = inProgress("live")
  const upcoming = inProgress("upcoming")
  const finals = inProgress("over")
  const close = () => props.onOpenChange(false)
  const row = (game: GameSnapshot) => {
    const place = placeOf(game)
    return (
      <li key={game.id}>
        <Matchup
          game={game}
          place={place}
          onClick={
            place === undefined
              ? () => {
                  dispatch({ _tag: "Assign", tile: props.selected, game: game.id })
                  close()
                }
              : undefined
          }
        />
      </li>
    )
  }

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange} modal={false}>
      <SheetContent
        side="left"
        showCloseButton={false}
        // App's hotkey handler closes the drawer on Esc, so a forwarded Esc from a stream view and a local one behave the same.
        onEscapeKeyDown={(event) => event.preventDefault()}
        // The top bar's Slate button toggles the drawer itself; a press on it is not a click outside.
        onInteractOutside={(event) => {
          if (event.target instanceof Element && event.target.closest("[data-slate-toggle]") !== null)
            event.preventDefault()
        }}
        className={`gap-0 bg-card p-0 sm:max-w-none ${props.fullScreen ? "" : "top-11 h-[calc(100%-2.75rem)]"} w-96`}
      >
        <header className="flex items-baseline justify-between border-b px-3 pt-2.5 pb-1.5">
          <SheetTitle className="label-caps text-[11px] text-muted-foreground">
            Slate <span className="font-mono">{props.slate.length}</span>
          </SheetTitle>
          <SheetDescription className="label-caps text-[11px] text-muted-foreground">
            to tile <span className="font-mono text-foreground">{props.selected + 1}</span>
          </SheetDescription>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {benched.length > 0 && (
            <Section title="Bench" count={benched.length}>
              {benched.map(({ index, id }) => {
                const game = props.slate.find((g) => g.id === id)
                const swap = () => {
                  dispatch({ _tag: "Swap", a: index, b: props.selected })
                  close()
                }
                return (
                  <li key={index}>
                    {game === undefined ? (
                      <button
                        type="button"
                        draggable
                        onClick={swap}
                        onDragStart={(event) => event.dataTransfer.setData(tileDrag, String(index))}
                        title={`Swap into tile ${props.selected + 1}`}
                        className="block w-full px-3 py-1.5 text-left font-mono text-xs text-muted-foreground transition-colors hover:bg-accent"
                      >
                        Off the slate
                      </button>
                    ) : (
                      <Matchup game={game} place="Bench" dragTile={index} onClick={swap} />
                    )}
                  </li>
                )
              })}
            </Section>
          )}
          <Section title="Live" count={live.length}>
            {live.map(row)}
          </Section>
          <Section title="Upcoming" count={upcoming.length}>
            {upcoming.map(row)}
          </Section>
          {finals.length > 0 && (
            <section className="border-t">
              <button
                type="button"
                onClick={() => setFinalsOpen((open) => !open)}
                aria-expanded={finalsOpen}
                className="label-caps flex w-full items-center gap-1 px-3 pt-2.5 pb-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
              >
                <ChevronRight className={`size-3 transition-transform ${finalsOpen ? "rotate-90" : ""}`} />
                Final <span className="font-mono">{finals.length}</span>
              </button>
              {finalsOpen && <ul className="pb-1.5">{finals.map(row)}</ul>}
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Section(props: { title: string; count: number; children: ReactNode }) {
  if (props.count === 0) return null
  return (
    <section className="border-t first:border-t-0">
      <h2 className="label-caps px-3 pt-2.5 pb-1 text-[11px] text-muted-foreground">
        {props.title} <span className="font-mono">{props.count}</span>
      </h2>
      <ul className="pb-1.5">{props.children}</ul>
    </section>
  )
}

/**
 * One game in fixed columns — rank, team, score, status, place — so nothing shifts as names, scores, and
 * clocks change length. A game already on the Stage or the Bench shows where, and is not pickable.
 */
function Matchup(props: {
  game: GameSnapshot
  place: string | undefined
  onClick?: (() => void) | undefined
  dragTile?: number
}) {
  const { game, dragTile } = props
  const scored = game.isLive() || game.status === "final"
  const networks = game.broadcasts.map(({ network }) => network).join(" · ")
  return (
    <button
      type="button"
      disabled={props.onClick === undefined}
      onClick={props.onClick}
      draggable={dragTile !== undefined}
      onDragStart={
        dragTile === undefined ? undefined : (event) => event.dataTransfer.setData(tileDrag, String(dragTile))
      }
      className="grid w-full grid-cols-[2ch_5ch_3ch_minmax(0,1fr)_3.25rem] items-baseline gap-x-2 px-3 py-1.5 text-left font-mono text-[13px] tabular-nums transition-colors enabled:hover:bg-accent disabled:cursor-default"
    >
      <Side side={game.away} other={game.home} scored={scored} row="row-start-1" />
      <span
        className={`label-caps col-start-4 row-start-1 truncate text-right text-[11px] ${game.isLive() ? "text-live" : "text-muted-foreground"}`}
      >
        {statusText(game)}
      </span>
      <span className="col-start-5 row-span-2 row-start-1 self-center justify-self-end">
        {props.place !== undefined && (
          <span
            className={`label-caps rounded-sm border px-1 py-px text-[10px] ${props.place === "Bench" ? "text-muted-foreground" : "border-on-air/50 text-on-air"}`}
          >
            {props.place}
          </span>
        )}
      </span>
      <Side side={game.home} other={game.away} scored={scored} row="row-start-2" />
      <span
        className="col-start-4 row-start-2 truncate text-right font-sans text-[11px] text-muted-foreground"
        title={networks}
      >
        {networks}
      </span>
    </button>
  )
}

/** One team's cells: rank, abbreviation, and score. Once scores mean something, the trailing side is muted. */
function Side(props: {
  side: GameSnapshot["home"]
  other: GameSnapshot["home"]
  scored: boolean
  row: "row-start-1" | "row-start-2"
}) {
  const trailing = props.scored && props.side.score < props.other.score
  return (
    <>
      <span className={`col-start-1 ${props.row} text-right text-[10px] text-muted-foreground`}>
        {props.side.ranking}
      </span>
      <span className={`col-start-2 ${props.row} font-semibold ${trailing ? "text-muted-foreground" : ""}`}>
        {props.side.team.abbreviation}
      </span>
      <span className={`col-start-3 ${props.row} text-right ${trailing ? "text-muted-foreground" : ""}`}>
        {props.scored ? props.side.score : null}
      </span>
    </>
  )
}
