import { Order, Schema } from "effect"
import { GameEvent } from "./GameEvent.ts"
import { TeamId } from "./Team.ts"

/** ESPN's play id. Not ordered: order plays by `Play.sequence`. */
export const PlayId = Schema.String.pipe(Schema.brand("PlayId"))
export type PlayId = typeof PlayId.Type

export const PlayKind = Schema.Literals([
  "rush",
  "pass",
  "incompletion",
  "sack",
  "interception",
  "fumble",
  "fumbleLost",
  "punt",
  "kickoff",
  "fieldGoal",
  "extraPoint",
  "twoPoint",
  "penalty",
  "timeout",
  "endPeriod",
  "other"
])
export type PlayKind = typeof PlayKind.Type

const Spot = Schema.Struct({
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardsToEndzone: Schema.optional(Schema.Int),
  team: Schema.optional(TeamId)
})

/** A single snap, or a timeout, a penalty, or the end of a period, as the game's play-by-play lists it. */
export class Play extends Schema.Class<Play>("sportal/Play")({
  id: PlayId,
  sequence: Schema.Int,
  period: Schema.Int,
  clock: Schema.String,
  team: Schema.optional(TeamId),
  kind: PlayKind,
  text: Schema.String,
  yards: Schema.Int,
  scoring: Schema.Boolean,
  homeScore: Schema.Int,
  awayScore: Schema.Int,
  start: Spot,
  end: Spot,
  homeWinProbability: Schema.optional(Schema.Number)
}) {
  /** By `sequence`. */
  static readonly order: Order.Order<Play> = Order.mapInput(Order.Number, (play: Play) => play.sequence)

  /**
   * The events of the plays in `after` that `before` does not have, in `Play.order`. `teams` say which side is which,
   * since a play's own `team` is not always the side that scored.
   */
  static eventsSince(
    before: ReadonlyArray<Play>,
    after: ReadonlyArray<Play>,
    teams: { readonly home: TeamId; readonly away: TeamId }
  ): ReadonlyArray<GameEvent> {
    const known = new Set(before.map((play) => play.id))
    const ordered = after.toSorted(Play.order)
    return ordered.flatMap((play, index) =>
      known.has(play.id) ? [] : eventsOf(play, ordered[index - 1], teams)
    )
  }
}

/** A play of at least this many yards is a big play. */
const bigPlayYards = 20

function eventsOf(
  play: Play,
  previous: Play | undefined,
  teams: { readonly home: TeamId; readonly away: TeamId }
): ReadonlyArray<GameEvent> {
  const events: GameEvent[] = [GameEvent.Played({ play })]
  if (play.scoring) {
    const rises = [
      { team: teams.home, points: play.homeScore - (previous?.homeScore ?? 0) },
      { team: teams.away, points: play.awayScore - (previous?.awayScore ?? 0) }
    ]
    events.push(...rises.filter((rise) => rise.points > 0).map(GameEvent.ScoreChanged))
  }
  const taker = play.end.team
  if (taker !== undefined && (play.kind === "interception" || play.kind === "fumbleLost")) {
    events.push(GameEvent.Turnover({ team: taker }))
  } else if (taker !== undefined && !play.scoring && play.start.team !== taker) {
    events.push(GameEvent.PossessionChanged({ team: taker }))
  }
  if (play.kind === "timeout" && play.team !== undefined)
    events.push(GameEvent.TimeoutTaken({ team: play.team }))
  if (play.kind === "endPeriod") events.push(GameEvent.PeriodEnded({ period: play.period }))
  if (play.end.down === 4 && play.end.team !== undefined)
    events.push(GameEvent.FourthDown({ team: play.end.team }))
  if (play.yards >= bigPlayYards && play.team !== undefined) {
    events.push(GameEvent.BigPlay({ team: play.team, yards: play.yards }))
  }
  const sacked = play.team ?? play.start.team
  if (play.kind === "sack" && sacked !== undefined) events.push(GameEvent.Sack({ team: sacked }))
  return events
}
