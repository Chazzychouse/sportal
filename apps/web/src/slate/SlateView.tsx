import type { GameSnapshot } from "@sportal/domain/Game"
import type { Stage, StageCommand } from "@sportal/domain/Stage"
import { Fragment, useEffect, useRef } from "react"
import type { Display } from "../Display.ts"
import type { useLive } from "../hub/Live.ts"
import { tileDrag } from "../stage/TileChrome.tsx"
import { statusText } from "./StatusText.ts"
import type { stripCards } from "./StripCards.ts"
import { TeamLogo } from "./TeamLogo.tsx"

/**
 * The slate as a strip under the Stage: the bench, then live, upcoming, and final games, scrolling sideways. It
 * takes its own room, so it never covers a video. Clicking a card drops it in the selected tile, as `Enter` does
 * the pick; a bench card can also be dragged onto a tile.
 */
export function SlateView(props: {
  cards: ReturnType<typeof stripCards>
  display: Display
  stage: Stage
  watchability: ReturnType<typeof useLive>["watchability"]
  onDrop: (dropped: { display: Display; commands: ReadonlyArray<StageCommand> }) => void
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
                    watch={props.watchability.get(card.id)}
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
function Card(props: {
  card: ReturnType<typeof stripCards>[number]
  picked: boolean
  droppable: boolean
  watch: ReturnType<ReturnType<typeof useLive>["watchability"]["get"]>
  onDrop: () => void
}) {
  const { game, place } = props.card
  const bench = place?._tag === "Bench" ? place.tile : undefined
  const onStage = place?._tag === "Slot"
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
          <Side side={game.away} other={game.home} game={game} />
          <span
            className={`label-caps truncate text-right text-[10px] ${game.progress() === "live" ? "text-live" : "text-muted-foreground"}`}
          >
            {statusText(game)}
          </span>
          <Side side={game.home} other={game.away} game={game} />
          <span className="flex min-w-0 items-center justify-end gap-1">
            <span className="truncate font-sans text-[10px] text-muted-foreground" title={networks}>
              {networks}
            </span>
            {game.progress() === "live" && props.watch !== undefined && (
              <span
                title={props.watch.reasons.join(" · ") || "Nothing happening"}
                className={`shrink-0 rounded-sm px-1 text-[9px] tabular-nums ${props.watch.lull ? "text-muted-foreground opacity-60" : "bg-live/15 text-live"}`}
              >
                {props.watch.score}
              </span>
            )}
            {place !== undefined && (
              <span
                className={`label-caps shrink-0 rounded-sm border px-1 text-[9px] ${onStage ? "border-on-air/50 text-on-air" : "text-muted-foreground"}`}
              >
                {place._tag === "Slot" ? `T${place.slot + 1}` : "Bench"}
              </span>
            )}
          </span>
        </>
      )}
    </button>
  )
}

/** One team's cells: logo, rank and abbreviation, and score. Once scores mean something, the trailing side is muted. */
function Side(props: { side: GameSnapshot["home"]; other: GameSnapshot["home"]; game: GameSnapshot }) {
  const scored = props.game.scored()
  const trailing = scored && props.side.score < props.other.score
  return (
    <>
      <TeamLogo team={props.side.team} size={16} />
      <span className={`truncate font-semibold ${trailing ? "text-muted-foreground" : ""}`}>
        {props.side.ranking !== undefined && (
          <span className="mr-0.5 font-normal text-[9px] text-muted-foreground">{props.side.ranking}</span>
        )}
        {props.side.team.abbreviation}
      </span>
      <span className={`text-right ${trailing ? "text-muted-foreground" : ""}`}>
        {scored ? props.side.score : null}
      </span>
    </>
  )
}
