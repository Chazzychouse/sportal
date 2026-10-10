import type { BallSpot, GameSnapshot } from "@sportal/domain/Game"
import { Play, type PlayId } from "@sportal/domain/Play"
import type { Situation } from "@sportal/domain/Situation"
import type { Team, TeamId } from "@sportal/domain/Team"
import { Data, Option } from "effect"
import { type CSSProperties, useEffect, useReducer } from "react"
import { cn } from "@/design/ClassName"

/**
 * A game's field from above, one SVG in yards: the end zones in their teams' colors, the ball and the lines of its
 * situation, and each new play drawn as an arrow from where it started to where it ended, one after another (only the
 * newest few when many arrive at once). The plays on hand when it first draws are taken as drawn, and so are all of
 * them again when the plays go back to an earlier sequence (the feed started over). Out of play, or with no ball on
 * the field, it is dimmed and shows no ball. The away team defends the left end zone and the home team the right.
 */
export function Field(props: { game: GameSnapshot; plays: ReadonlyArray<Play>; className?: string }) {
  const { game, plays } = props
  const [drawing, dispatch] = useReducer(step, plays, (initial) =>
    Drawing.Settled({ last: Math.max(-1, ...initial.map((play) => play.sequence)) })
  )
  useEffect(() => dispatch(FieldEvent.Arrived({ plays, game })), [plays, game])

  const ball = game.inPlay() ? game.ball() : Option.none()
  const situation = game.situation

  return (
    <svg
      viewBox={`0 0 ${length} ${width}`}
      role="img"
      aria-label={`The field, ${game.matchup()}`}
      className={cn(
        "transition-opacity duration-500",
        Drawing.$is("Settled")(drawing) && Option.isNone(ball) && "opacity-40",
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
        Animating: ({ play }) => (
          <PlayArrow
            key={play.id}
            game={game}
            plays={plays}
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

/**
 * Which plays this field has drawn: settled on the situation after the play with sequence `last`, or animating `play`
 * with `queued` to follow. `last` is the newest play taken in, drawn, queued, or dropped from a full queue.
 */
type Drawing = Data.TaggedEnum<{
  Settled: { readonly last: number }
  Animating: { readonly play: Play; readonly queued: ReadonlyArray<Play>; readonly last: number }
}>
const Drawing = Data.taggedEnum<Drawing>()

/**
 * The most plays a field waits to draw: a page that was hidden while plays arrived draws only the newest few, not the
 * whole backlog.
 */
const queueLength = 3

/** What a field hears: plays arrived from the Hub, or a play finished drawing. */
type FieldEvent = Data.TaggedEnum<{
  Arrived: { readonly plays: ReadonlyArray<Play>; readonly game: GameSnapshot }
  Drawn: { readonly play: PlayId; readonly game: GameSnapshot }
}>
const FieldEvent = Data.taggedEnum<FieldEvent>()

function step(drawing: Drawing, event: FieldEvent): Drawing {
  return FieldEvent.$match(event, {
    Arrived: ({ plays, game }) => {
      const newestSent = Math.max(-1, ...plays.map((play) => play.sequence))
      if (newestSent < drawing.last) return Drawing.Settled({ last: newestSent })
      const fresh = plays.filter((play) => play.sequence > drawing.last).toSorted(Play.order)
      const newest = fresh.at(-1)
      if (newest === undefined) return drawing
      return Drawing.$match(drawing, {
        Settled: () => nextOf(fresh.slice(-queueLength), newest.sequence, game),
        Animating: (current) =>
          Drawing.Animating({
            ...current,
            queued: [...current.queued, ...fresh].slice(-queueLength),
            last: newest.sequence
          })
      })
    },
    Drawn: (drawn) =>
      Drawing.$match(drawing, {
        Settled: () => drawing,
        Animating: ({ play, queued, last }) =>
          play.id === drawn.play ? nextOf(queued, last, drawn.game) : drawing
      })
  })
}

/** The first play in `queue` with both spots on the field, drawing; the plays before it are skipped. */
function nextOf(queue: ReadonlyArray<Play>, last: number, game: GameSnapshot): Drawing {
  const index = queue.findIndex((play) => Option.isSome(spotsOf(game, play)))
  const play = queue[index]
  return play === undefined
    ? Drawing.Settled({ last })
    : Drawing.Animating({ play, queued: queue.slice(index + 1), last })
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
 * One play, drawn once over `drawSeconds`: its arrow by case, the ball leaving its start and arriving at its end in
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
  const spots = spotsOf(game, play)
  const missing = Option.isNone(spots)
  // A play dequeued with both spots always has them, but should one go missing no animation would end the play.
  useEffect(() => {
    if (missing) onDrawn()
  }, [missing, onDrawn])

  return Option.match(spots, {
    onNone: () => null,
    onSome: ({ start, end }) => {
      const scorer = play.scoring ? scorerOf(game, props.plays, play) : undefined
      const losing = Play.lostYards(play)

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
            d={pathOf(play, start, end)}
            pathLength={1}
            fill="none"
            stroke={losing ? "var(--destructive)" : "var(--foreground)"}
            strokeWidth={0.6}
            strokeLinecap="round"
            strokeDasharray={dashesOf(play)}
            style={{ animation: `field-draw ${drawSeconds}s ease-out both` }}
            onAnimationEnd={onDrawn}
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
 * The arrow's course by case: a high arc for a kick, an arc for a completion, a loop downfield and back for an
 * incompletion, and straight along the field for anything else.
 */
function pathOf(play: Play, start: BallSpot, end: BallSpot): string {
  const from = xOf(start)
  const to = xOf(end)
  const span = Math.abs(to - from)
  const arc = (height: number) =>
    `M ${from} ${middle} Q ${(from + to) / 2} ${middle - height} ${to} ${middle}`
  const kick = () => arc(Math.min(24, Math.max(10, span * 0.6)))
  const straight = () => `M ${from} ${middle} L ${to} ${middle}`
  return Play.match(play, {
    Kickoff: kick,
    Punt: kick,
    FieldGoal: kick,
    ExtraPoint: kick,
    Completion: () => arc(Math.min(18, Math.max(4, span * 0.4))),
    Incompletion: () => {
      const out = from + directionOf(start) * 16
      return `M ${from} ${middle} C ${out} ${middle - 16} ${out} ${middle - 2} ${from} ${middle}`
    },
    Rush: straight,
    Interception: straight,
    Sack: straight,
    Fumble: straight,
    TwoPointTry: straight,
    Safety: straight,
    Penalty: straight,
    Timeout: straight,
    Stoppage: straight,
    PeriodEnd: straight,
    Other: straight
  })
}

/**
 * The arrow's dashes on a path of length 1, then a gap of 1, so `field-draw` (the offset from 1 to 0) reveals them
 * from the start: dashed for a penalty, dotted for an incompletion, solid otherwise. The list has an even length,
 * since SVG repeats an odd one twice and that would show the dashes before they are drawn.
 */
function dashesOf(play: Play): string {
  const pattern = (count: number, dash: number) =>
    Array.from(
      { length: count },
      (_, index) => `${dash} ${1 / count - dash + (index === count - 1 ? 1 : 0)}`
    ).join(" ")
  const solid = () => "1 1"
  return Play.match(play, {
    Penalty: () => pattern(12, 0.05),
    Incompletion: () => pattern(24, 0.001),
    Rush: solid,
    Completion: solid,
    Interception: solid,
    Sack: solid,
    Fumble: solid,
    TwoPointTry: solid,
    Kickoff: solid,
    Punt: solid,
    FieldGoal: solid,
    ExtraPoint: solid,
    Safety: solid,
    Timeout: solid,
    Stoppage: solid,
    PeriodEnd: solid,
    Other: solid
  })
}

/**
 * The team that scored on `play`: the side whose score rose since the play before it, or the offense when the play
 * before it is not on hand.
 */
function scorerOf(game: GameSnapshot, plays: ReadonlyArray<Play>, play: Play): Team | undefined {
  const previous = plays.findLast((candidate) => candidate.sequence < play.sequence)
  if (previous !== undefined && play.homeScore > previous.homeScore) return game.home.team
  if (previous !== undefined && play.awayScore > previous.awayScore) return game.away.team
  const team = Play.offense(play)
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
