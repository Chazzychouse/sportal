import type { Stage } from "@sportal/domain/Stage"
import { Fragment, useEffect, useRef } from "react"
import type { Display, DisplayStep } from "../display/Display.ts"
import { GameStatus } from "../game/GameStatus.tsx"
import { Score } from "../game/Score.tsx"
import { tileDrag } from "../stage/TileChrome.tsx"
import { PlaceBadge } from "./PlaceBadge.tsx"
import type { StripCard } from "./StripCards.ts"

/**
 * The slate as a strip under the Stage: the bench, then live, upcoming, and final games, scrolling sideways. It
 * takes its own room, so it never covers a video. Clicking a card drops it in the selected tile, as `Enter` does
 * the pick; a bench card can also be dragged onto a tile.
 */
export function SlateView(props: {
  cards: ReadonlyArray<StripCard>
  display: Display
  stage: Stage
  onDrop: (dropped: DisplayStep) => void
}) {
  const pick = props.display.pick
  const rowRef = useRef<HTMLOListElement | null>(null)

  // The pick stays in view as it steps along.
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
        <span className="font-mono text-lg leading-none">{props.display.selectedOn(props.stage) + 1}</span>
      </div>
      {props.cards.length === 0 ? (
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
          {props.cards.map((card, index) => {
            const section = card.section
            const starts = index === 0 || props.cards[index - 1]?.section !== section
            const dropped = props.display.drop(card, props.stage)

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
                    droppable={dropped.commands.length > 0}
                    onDrop={() => props.onDrop(dropped)}
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
 * and clocks change length. A game on stage shows its tile and cannot be picked.
 */
function Card(props: { card: StripCard; picked: boolean; droppable: boolean; onDrop: () => void }) {
  const { game, place } = props.card
  const bench = place?._tag === "Bench" ? place.tile : undefined
  const networks = game?.networks()

  return (
    <button
      type="button"
      // The keyboard picks with [ ] and Enter, so the cards stay out of the tab order.
      tabIndex={-1}
      disabled={!props.droppable}
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
