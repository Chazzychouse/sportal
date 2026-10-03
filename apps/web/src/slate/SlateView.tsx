import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { Fragment, useEffect, useRef } from "react"
import { dispatch } from "../hub/HubClient.ts"
import { tileDrag } from "../stage/TileChrome.tsx"
import { statusText } from "./StatusText.ts"
import { dropCommand, type stripCards } from "./StripCards.ts"
import { TeamLogo } from "./TeamLogo.tsx"

/**
 * The slate as a strip under the Stage: the bench, then live, upcoming, and final games, scrolling sideways. It
 * takes its own room, so it never covers a video. Clicking a card, or `Enter` on the pick, puts it in the selected
 * tile; a bench card can also be dragged onto a tile.
 */
export function SlateView(props: {
  cards: ReturnType<typeof stripCards>
  selected: number
  pick: GameId | undefined
  onPick: (game: GameId) => void
}) {
  const rowRef = useRef<HTMLOListElement | null>(null)

  // The pick stays in view as it steps along.
  useEffect(() => {
    if (props.pick === undefined) return
    rowRef.current
      ?.querySelector(`[data-game="${CSS.escape(props.pick)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" })
  }, [props.pick])

  return (
    <section aria-label="Slate" className="flex h-16 min-w-0 items-stretch border-t bg-card/60">
      <div className="flex w-16 shrink-0 flex-col justify-center gap-1 border-r px-3">
        <span className="label-caps text-[10px] text-muted-foreground">to tile</span>
        <span className="font-mono text-lg leading-none">{props.selected + 1}</span>
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
            const section = sectionOf(card)
            const starts = index === 0 || sectionOf(props.cards[index - 1]) !== section
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
                    picked={props.pick === card.id}
                    onDrop={() => {
                      const command = dropCommand(card, props.selected)
                      if (command === undefined) return
                      props.onPick(card.id)
                      dispatch(command)
                    }}
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

function sectionOf(card: ReturnType<typeof stripCards>[number] | undefined) {
  if (card?.place?._tag === "Bench") return "Bench"
  switch (card?.game?.progress()) {
    case "live":
      return "Live"
    case "upcoming":
      return "Next"
    default:
      return "Final"
  }
}

/**
 * One game in fixed columns — logo, team, score, then status and networks — so nothing shifts as names, scores,
 * and clocks change length. A game on stage shows its tile and cannot be picked.
 */
function Card(props: { card: ReturnType<typeof stripCards>[number]; picked: boolean; onDrop: () => void }) {
  const { game, place } = props.card
  const bench = place?._tag === "Bench" ? place.tile : undefined
  const onStage = place?._tag === "Slot"
  const networks = game?.broadcasts.map(({ network }) => network).join(" · ")
  return (
    <button
      type="button"
      // The keyboard picks with [ ] and Enter, so the cards stay out of the tab order.
      tabIndex={-1}
      disabled={onStage}
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
            className={`label-caps truncate text-right text-[10px] ${game.isLive() ? "text-live" : "text-muted-foreground"}`}
          >
            {statusText(game)}
          </span>
          <Side side={game.home} other={game.away} game={game} />
          <span className="flex min-w-0 items-center justify-end gap-1">
            <span className="truncate font-sans text-[10px] text-muted-foreground" title={networks}>
              {networks}
            </span>
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
  const scored = props.game.isLive() || props.game.status === "final"
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
