import type { BallSpot, GameSnapshot } from "@sportal/domain/Game"
import { Play } from "@sportal/domain/Play"
import type { Situation } from "@sportal/domain/Situation"
import type { Team, TeamId } from "@sportal/domain/Team"
import { Data, Option } from "effect"
import { type CSSProperties, useEffect, useReducer } from "react"
import { cn } from "@/design/ClassName"

/**
 * A game's field from above, one SVG in yards: the end zones in their teams' colors, the ball and the lines of its
 * situation, and each new play drawn as an arrow from where it started to where it ended, one after another. The
 * plays on hand when it first draws are taken as drawn. With no ball on the field it is dimmed and shows no ball.
 * The away team defends the left end zone and the home team the right.
 */
export function Field(props: { game: GameSnapshot; plays: ReadonlyArray<Play>; className?: string }) {
  const { game, plays } = props
  const [drawing, dispatch] = useReducer(step, plays, (initial) =>
    Drawing.Settled({ last: Math.max(-1, ...initial.map((play) => play.sequence)) })
  )
  useEffect(() => dispatch({ _tag: "Arrived", plays, game }), [plays, game])
  const ball = game.ball()
  const situation = game.situation
  return (
    <svg
      viewBox={`0 0 ${length} ${width}`}
      role="img"
      aria-label={`The field, ${game.matchup()}`}
      className={cn(
        "transition-opacity duration-500",
        drawing._tag === "Settled" && Option.isNone(ball) && "opacity-40",
        props.className
      )}
    >
      <rect width={length} height={width} fill="var(--card)" />
      <rect width={10} height={width} fill={colorOf(game.away.team, "var(--secondary)")} />
      <rect x={110} width={10} height={width} fill={colorOf(game.home.team, "var(--accent)")} />
      {Array.from({ length: 21 }, (_, index) => {
        const x = 10 + index * 5
        const goal = index === 0 || index === 20
        return (
          <line
            key={x}
            x1={x}
            x2={x}
            y2={width}
            stroke="var(--muted-foreground)"
            strokeOpacity={goal ? 0.8 : 0.3}
            strokeWidth={goal ? 0.5 : 0.25}
          />
        )
      })}
      {Array.from({ length: 9 }, (_, index) => {
        const x = 20 + index * 10
        return (
          <text
            key={x}
            x={x}
            y={width - 3}
            textAnchor="middle"
            fontSize={4.5}
            fill="var(--muted-foreground)"
            className="font-display"
          >
            {50 - Math.abs(x - 60)}
          </text>
        )
      })}
      {Drawing.$match(drawing, {
        Settled: () =>
          situation !== undefined &&
          Option.match(ball, {
            onNone: () => null,
            onSome: (spot) => <Scrimmage game={game} situation={situation} spot={spot} />
          }),
        Drawing: ({ play }) => (
          <PlayArrow
            key={play.id}
            game={game}
            plays={plays}
            play={play}
            onDrawn={() => dispatch({ _tag: "Drawn", game })}
          />
        )
      })}
    </svg>
  )
}

/** The field's length and width in yards, end line to end line and sideline to sideline. */
const length = 120
const width = 53.3

/** Where arrows and the ball run: midway between the sidelines. */
const middle = width / 2

/** How long one play takes to draw. */
const drawSeconds = 0.6

/**
 * Which plays this field has drawn: settled on the situation after the play with sequence `last`, or drawing `play`
 * with `queued` to follow. `last` is the newest play taken in, drawn or queued.
 */
type Drawing = Data.TaggedEnum<{
  Settled: { readonly last: number }
  Drawing: { readonly play: Play; readonly queued: ReadonlyArray<Play>; readonly last: number }
}>
const Drawing = Data.taggedEnum<Drawing>()

function step(
  drawing: Drawing,
  event:
    | { readonly _tag: "Arrived"; readonly plays: ReadonlyArray<Play>; readonly game: GameSnapshot }
    | { readonly _tag: "Drawn"; readonly game: GameSnapshot }
): Drawing {
  switch (event._tag) {
    case "Arrived": {
      const fresh = event.plays.filter((play) => play.sequence > drawing.last).toSorted(Play.order)
      const newest = fresh.at(-1)
      if (newest === undefined) return drawing
      return Drawing.$match(drawing, {
        Settled: () => nextOf(fresh, newest.sequence, event.game),
        Drawing: (current) =>
          Drawing.Drawing({ ...current, queued: [...current.queued, ...fresh], last: newest.sequence })
      })
    }
    case "Drawn":
      return Drawing.$match(drawing, {
        Settled: () => drawing,
        Drawing: ({ queued, last }) => nextOf(queued, last, event.game)
      })
  }
}

/** The first play in `queue` with both spots on the field, drawing; the plays before it are skipped. */
function nextOf(queue: ReadonlyArray<Play>, last: number, game: GameSnapshot): Drawing {
  const index = queue.findIndex((play) => Option.isSome(spotsOf(game, play)))
  const play = queue[index]
  return play === undefined
    ? Drawing.Settled({ last })
    : Drawing.Drawing({ play, queued: queue.slice(index + 1), last })
}

function spotsOf(game: GameSnapshot, play: Play) {
  return Option.all({ start: game.spotOf(play.start), end: game.spotOf(play.end) })
}

/** A spot's x on the field: the home goal line is at 110 and the away goal line at 10. */
function xOf(spot: BallSpot): number {
  return 110 - spot.yards
}

/** The way a spot's team is going along x. */
function directionOf(spot: BallSpot): 1 | -1 {
  return spot.toward === "home" ? 1 : -1
}

/** A team's color as a fill, or `neutral` when the provider sends none. */
function colorOf(team: Team, neutral: string): string {
  return team.color === undefined ? neutral : `#${team.color}`
}

/** The color of the ball in a team's hands: its color, or a neutral that tells home from away. */
function ballColorOf(game: GameSnapshot, team: TeamId | undefined): string {
  return team === game.away.team.id
    ? colorOf(game.away.team, "var(--muted-foreground)")
    : colorOf(game.home.team, "var(--foreground)")
}

/** The situation at rest: the red zone when the ball is in it, the line of scrimmage, the line to gain, and the ball. */
function Scrimmage(props: { game: GameSnapshot; situation: Situation; spot: BallSpot }) {
  const { situation, spot } = props
  const x = xOf(spot)
  const direction = directionOf(spot)
  const goal = direction === 1 ? 110 : 10
  const gain =
    situation.distance === undefined || situation.goalToGo()
      ? undefined
      : Math.min(110, Math.max(10, x + direction * situation.distance))
  return (
    <g>
      {situation.inRedZone() && (
        <rect
          x={Math.min(goal, goal - direction * 20)}
          width={20}
          height={width}
          fill="var(--destructive)"
          fillOpacity={0.18}
        />
      )}
      <line x1={x} x2={x} y2={width} stroke="var(--foreground)" strokeOpacity={0.8} strokeWidth={0.5} />
      {gain !== undefined && <line x1={gain} x2={gain} y2={width} stroke="var(--warn)" strokeWidth={0.6} />}
      <Ball x={x} color={ballColorOf(props.game, situation.possession)} />
    </g>
  )
}

/**
 * One play, drawn once over `drawSeconds`: its arrow by kind, the ball leaving its start and arriving at its end in
 * the color of the team that has it there, and on a score the end zone the scorer attacks flashing in its color.
 * `onDrawn` runs when the arrow is finished.
 */
function PlayArrow(props: {
  game: GameSnapshot
  plays: ReadonlyArray<Play>
  play: Play
  onDrawn: () => void
}) {
  const { game, play } = props
  return Option.match(spotsOf(game, play), {
    onNone: () => null,
    onSome: ({ start, end }) => {
      const scorer = play.scoring ? scorerOf(game, props.plays, play) : undefined
      const losing = play.kind === "sack" || play.yards < 0
      return (
        <g>
          {scorer !== undefined && (
            <rect
              x={scorer === game.home.team ? 0 : 110}
              width={10}
              height={width}
              fill={colorOf(scorer, "var(--foreground)")}
              style={{ animation: `field-flash ${drawSeconds}s ease-in-out both` }}
            />
          )}
          <path
            d={pathOf(play, start, end)}
            pathLength={1}
            fill="none"
            stroke={losing ? "var(--destructive)" : "var(--foreground)"}
            strokeWidth={0.6}
            strokeLinecap="round"
            strokeDasharray={dashesOf(play)}
            style={{ animation: `field-draw ${drawSeconds}s ease-out both` }}
            onAnimationEnd={props.onDrawn}
          />
          <Ball x={xOf(start)} color={ballColorOf(game, play.start.team)} opacity={0.5} />
          <Ball
            x={xOf(end)}
            color={ballColorOf(game, play.end.team)}
            style={{ animation: `field-arrive ${drawSeconds}s ease-out both` }}
          />
        </g>
      )
    }
  })
}

/**
 * The arrow's course by kind: a high arc for a kick, an arc for a pass, a loop downfield and back for an
 * incompletion, and straight along the field for anything else.
 */
function pathOf(play: Play, start: BallSpot, end: BallSpot): string {
  const from = xOf(start)
  const to = xOf(end)
  const span = Math.abs(to - from)
  const arc = (height: number) =>
    `M ${from} ${middle} Q ${(from + to) / 2} ${middle - height} ${to} ${middle}`
  switch (play.kind) {
    case "kickoff":
    case "punt":
    case "fieldGoal":
    case "extraPoint":
      return arc(Math.min(24, Math.max(10, span * 0.6)))
    case "pass":
      return arc(Math.min(18, Math.max(4, span * 0.4)))
    case "incompletion": {
      const out = from + directionOf(start) * 16
      return `M ${from} ${middle} C ${out} ${middle - 16} ${out} ${middle - 2} ${from} ${middle}`
    }
    default:
      return `M ${from} ${middle} L ${to} ${middle}`
  }
}

/**
 * The arrow's dashes on a path of length 1, followed by a gap of 1, so `field-draw` (the offset from 1 to 0)
 * reveals them from the start: dashed for a penalty, dotted for an incompletion, solid otherwise.
 */
function dashesOf(play: Play): string {
  const pattern = (count: number, dash: number) =>
    `${Array.from({ length: count }, () => `${dash} ${1 / count - dash}`).join(" ")} 1`
  switch (play.kind) {
    case "penalty":
      return pattern(12, 0.05)
    case "incompletion":
      return pattern(24, 0.001)
    default:
      return "1 1"
  }
}

/**
 * The team that scored on `play`: the side whose score rose since the play before it, or the play's own team
 * when the play before it is not on hand.
 */
function scorerOf(game: GameSnapshot, plays: ReadonlyArray<Play>, play: Play): Team | undefined {
  const previous = plays.findLast((candidate) => candidate.sequence < play.sequence)
  if (previous !== undefined && play.homeScore > previous.homeScore) return game.home.team
  if (previous !== undefined && play.awayScore > previous.awayScore) return game.away.team
  const team = play.team ?? play.start.team
  return [game.home.team, game.away.team].find((candidate) => candidate.id === team)
}

function Ball(props: { x: number; color: string; opacity?: number; style?: CSSProperties }) {
  return (
    <ellipse
      cx={props.x}
      cy={middle}
      rx={1.6}
      ry={1}
      fill={props.color}
      stroke="var(--foreground)"
      strokeWidth={0.25}
      opacity={props.opacity}
      style={props.style}
    />
  )
}
