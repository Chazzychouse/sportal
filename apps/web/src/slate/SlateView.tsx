import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Fragment, useEffect, useRef } from "react"
import { DisplayInput } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { GameStatus } from "../game/GameStatus.tsx"
import { MomentBadge } from "../game/MomentBadge.tsx"
import { Score } from "../game/Score.tsx"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { tileDrag } from "../screen/TileChrome.tsx"
import { PlaceBadge } from "./PlaceBadge.tsx"
import { Place, type StripCard } from "./StripCard.ts"

/**
 * The slate as a strip under the Screen: the bench, then live, upcoming, and final games, scrolling sideways. It
 * takes its own room, so it never covers a video. Clicking a card drops it in the selected tile, as `Enter` does
 * the pick; a bench card can also be dragged onto a tile.
 */
export function SlateView() {
  const display = useAtomValue(DisplayState.display)
  const input = useAtomSet(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const cards = useAtomValue(DisplayState.cards)
  const pick = display.pick
  const rowRef = useRef<HTMLOListElement | null>(null)

  useEffect(() => {
    if (pick === undefined) return
    rowRef.current
      ?.querySelector(`[data-game="${CSS.escape(pick)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" })
  }, [pick])

  return (
    <section aria-label="Slate" className="flex h-16 min-w-0 items-stretch border-t bg-card/60">
      <div className="flex w-16 shrink-0 flex-col justify-center gap-1 border-r px-3">
        <span className="label-caps text-[10px] text-muted-foreground">to tile</span>
        <span className="font-mono text-lg leading-none">{display.selectedOn(screen) + 1}</span>
      </div>
      {cards.length === 0 ? (
        <p className="self-center px-3 text-xs text-muted-foreground">No games in the slate.</p>
      ) : (
        <ol
          ref={rowRef}
          // A plain mouse wheel scrolls the strip sideways.
          onWheel={(event) => {
            if (rowRef.current !== null && event.deltaX === 0) rowRef.current.scrollLeft += event.deltaY
          }}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden px-2 [scrollbar-width:thin]"
        >
          {cards.map((card, index) => {
            const section = card.section
            const starts = index === 0 || cards[index - 1]?.section !== section

            return (
              <Fragment key={card.id}>
                {starts && (
                  <li
                    aria-hidden
                    className={`label-caps flex h-11 shrink-0 rotate-180 items-center pr-1 text-[9px] text-muted-foreground [writing-mode:vertical-rl] ${
                      index === 0 ? "" : "ml-1 border-r"
                    }`}
                  >
                    {section}
                  </li>
                )}
                <li data-game={card.id} className="shrink-0">
                  <Card
                    card={card}
                    picked={pick === card.id}
                    onDrop={() => input(DisplayInput.Dropped({ card }))}
                  />
                </li>
              </Fragment>
            )
          })}
        </ol>
      )}
    </section>
  )
}

/**
 * One game in fixed columns — logo, team, score, then status and networks — so nothing shifts as names, scores,
 * and clocks change length. A game on screen shows its tile and cannot be picked.
 */
function Card(props: { card: StripCard; picked: boolean; onDrop: () => void }) {
  const { game, place, classification } = props.card
  const bench = Place.$is("Bench")(place) ? place.tile : undefined
  const networks = game?.networks()

  return (
    <button
      type="button"
      // The keyboard picks with [ ] and Enter, so the cards stay out of the tab order.
      tabIndex={-1}
      disabled={!props.card.pickable()}
      onClick={props.onDrop}
      draggable={bench !== undefined}
      onDragStart={
        bench === undefined ? undefined : (event) => event.dataTransfer.setData(tileDrag, String(bench))
      }
      title={game === undefined ? "Off the slate" : `${game.away.team.name} at ${game.home.team.name}`}
      className={`grid h-12 w-52 grid-cols-[16px_7ch_3ch_minmax(0,1fr)] items-center gap-x-1.5 rounded-sm border px-2 text-left font-mono text-[12px] tabular-nums transition-colors enabled:hover:bg-accent disabled:cursor-default ${
        props.picked ? "border-foreground/70 bg-accent" : "border-transparent"
      } ${game?.progress() === "over" ? "opacity-60" : ""}`}
    >
      {game === undefined ? (
        <span className="col-span-4 text-muted-foreground">Off the slate</span>
      ) : (
        <>
          <Score game={game} side="away" />
          <GameStatus game={game} className="truncate text-right text-[10px]" />
          <Score game={game} side="home" />
          <span className="flex min-w-0 items-center justify-end gap-1">
            <MomentBadge classification={classification} />
            <span className="truncate font-sans text-[10px] text-muted-foreground" title={networks}>
              {networks}
            </span>
            <PlaceBadge place={place} className="text-[9px]" />
          </span>
        </>
      )}
    </button>
  )
}
