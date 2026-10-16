import type { GameSnapshot } from "@sportal/domain/Game"
import { type FootballDetail, type Play, PlayDetail } from "@sportal/domain/Play"
import { type BallSpot, type FootballSituation, Situation } from "@sportal/domain/Situation"
import type { Team, TeamId } from "@sportal/domain/Team"
import { Option } from "effect"
import { type CSSProperties, useEffect, useMemo, useReducer } from "react"
import { cn } from "@/design/ClassName"
import { FieldDrawing, FieldEvent } from "./FieldDrawing.ts"

/**
 * A game's field from above, one SVG in yards: the end zones in their teams' colors, the ball and the lines of its
 * situation, and each new play drawn as an arrow from where it started to where it ended, as `FieldDrawing` orders
 * them. Out of play, or with no ball on the field, it is dimmed and shows no ball. The away team defends the left end
 * zone and the home team the right.
 */
export function Field(props: { game: GameSnapshot; plays: ReadonlyArray<Play>; className?: string }) {
  const { game, plays } = props
  const situation =
    game.situation !== undefined && Situation.guards.Football(game.situation) ? game.situation : undefined
  const ball = game.inPlay() && situation !== undefined ? situation.ball(game) : Option.none()
  const drawn = useMemo(() => plays.filter((play) => PlayDetail.guards.Football(play.detail)), [plays])
  const [drawing, dispatch] = useReducer(FieldDrawing.step, drawn, FieldDrawing.initial)
  useEffect(() => dispatch(FieldEvent.Arrived({ plays: drawn, game })), [drawn, game])

  return (
    <svg
      viewBox={`0 0 ${length} ${width}`}
      role="img"
      aria-label={`The field, ${game.matchup()}`}
      className={cn(
        "transition-opacity duration-500",
        FieldDrawing.$is("Settled")(drawing) && Option.isNone(ball) && "opacity-40",
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
      {FieldDrawing.$match(drawing, {
        Settled: () =>
          situation !== undefined &&
          Option.match(ball, {
            onNone: () => null,
            onSome: (spot) => <Scrimmage game={game} situation={situation} spot={spot} />
          }),
        Animating: ({ play }) => (
          <PlayArrow
            key={play.id}
            game={game}
            plays={drawn}
            play={play}
            onDrawn={() => dispatch(FieldEvent.Drawn({ play: play.id, game }))}
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
function Scrimmage(props: { game: GameSnapshot; situation: FootballSituation; spot: BallSpot }) {
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
 * One football play, drawn once over `drawSeconds`: its arrow by kind, the ball leaving its start and arriving at its end in
 * the color of the team that has it there, and on a score the end zone the scorer attacks flashing in its color.
 * `onDrawn` runs when the arrow is finished.
 */
function PlayArrow(props: {
  game: GameSnapshot
  plays: ReadonlyArray<Play>
  play: Play
  onDrawn: () => void
}) {
  const { game, play, onDrawn } = props
  const spots = Option.all({
    detail: Option.liftPredicate(play.detail, PlayDetail.guards.Football),
    spots: FieldDrawing.spotsOf(game, play)
  })
  const missing = Option.isNone(spots)
  // A play dequeued with both spots always has them, but should one go missing no animation would end the play.
  useEffect(() => {
    if (missing) onDrawn()
  }, [missing, onDrawn])

  return Option.match(spots, {
    onNone: () => null,
    onSome: ({ detail, spots: { start, end } }) => {
      const scorer = play.scoring ? scorerOf(game, props.plays, play) : undefined
      const losing = detail.lostYards()

      return (
        <g>
          {scorer !== undefined && (
            <rect
              x={scorer === game.home.team ? 0 : 110}
              width={10}
              height={width}
              fill={colorOf(scorer, "var(--foreground)")}
              stroke="var(--foreground)"
              strokeWidth={0.5}
              style={{ animation: `field-flash ${drawSeconds}s ease-in-out both` }}
            />
          )}
          <path
            d={pathOf(detail, start, end)}
            pathLength={1}
            fill="none"
            stroke={losing ? "var(--destructive)" : "var(--foreground)"}
            strokeWidth={0.6}
            strokeLinecap="round"
            strokeDasharray={dashesOf(detail)}
            style={{ animation: `field-draw ${drawSeconds}s ease-out both` }}
            onAnimationEnd={onDrawn}
          />
          <Ball x={xOf(start)} color={ballColorOf(game, detail.start.team)} opacity={0.5} />
          <Ball
            x={xOf(end)}
            color={ballColorOf(game, detail.end.team)}
            style={{ animation: `field-arrive ${drawSeconds}s ease-out both` }}
          />
        </g>
      )
    }
  })
}

/**
 * The arrow's course by kind: a high arc for a kick, an arc for a caught pass, a loop downfield and back for an
 * incomplete pass, and straight along the field for anything else.
 */
function pathOf(detail: FootballDetail, start: BallSpot, end: BallSpot): string {
  const from = xOf(start)
  const to = xOf(end)
  const span = Math.abs(to - from)
  const arc = (height: number) =>
    `M ${from} ${middle} Q ${(from + to) / 2} ${middle - height} ${to} ${middle}`
  const straight = `M ${from} ${middle} L ${to} ${middle}`
  switch (detail.kind) {
    case "kick":
      return arc(Math.min(24, Math.max(10, span * 0.6)))
    case "pass":
      return arc(Math.min(18, Math.max(4, span * 0.4)))
    case "incomplete": {
      const out = from + directionOf(start) * 16
      return `M ${from} ${middle} C ${out} ${middle - 16} ${out} ${middle - 2} ${from} ${middle}`
    }
    default:
      return straight
  }
}

/**
 * The arrow's dashes on a path of length 1, then a gap of 1, so `field-draw` (the offset from 1 to 0) reveals them
 * from the start: dashed for a penalty, dotted for an incomplete pass, solid otherwise. The list has an even length,
 * since SVG repeats an odd one twice and that would show the dashes before they are drawn.
 */
function dashesOf(detail: FootballDetail): string {
  const pattern = (count: number, dash: number) =>
    Array.from(
      { length: count },
      (_, index) => `${dash} ${1 / count - dash + (index === count - 1 ? 1 : 0)}`
    ).join(" ")
  return detail.kind === "penalty"
    ? pattern(12, 0.05)
    : detail.kind === "incomplete"
      ? pattern(24, 0.001)
      : "1 1"
}

/**
 * The team that scored on `play`: the side whose score rose since the play before it, or the offense when the play
 * before it is not on hand.
 */
function scorerOf(game: GameSnapshot, plays: ReadonlyArray<Play>, play: Play): Team | undefined {
  const previous = plays.findLast((candidate) => candidate.sequence < play.sequence)
  if (previous !== undefined && play.homeScore > previous.homeScore) return game.home.team
  if (previous !== undefined && play.awayScore > previous.awayScore) return game.away.team
  const team = Option.getOrUndefined(play.offense())
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
