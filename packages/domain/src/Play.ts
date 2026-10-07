import { Order, Schema } from "effect"
import { GameEventKind } from "./GameEvent.ts"
import { TeamId } from "./Team.ts"

/** The feed's own id. Not ordered: order plays by `Play.sequence`. */
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
  homeWinProbability: Schema.optional(Schema.Finite)
}) {
  /** By `sequence`. */
  static readonly order: Order.Order<Play> = Order.mapInput(Order.Number, (play: Play) => play.sequence)

  /**
   * The events of the plays in `after` that `before` does not have, in `Play.order`: each play is `Played`, and a
   * big play or a sack says so. What a play changed (the score, the ball, the clock) is the snapshot's to say.
   */
  static eventsSince(before: ReadonlyArray<Play>, after: ReadonlyArray<Play>): ReadonlyArray<GameEventKind> {
    const known = new Set(before.map((play) => play.id))
    return after
      .toSorted(Play.order)
      .filter((play) => !known.has(play.id))
      .flatMap(eventsOf)
  }
}

/** A play of at least this many yards is a big play. */
const bigPlayYards = 20

function eventsOf(play: Play): ReadonlyArray<GameEventKind> {
  const sacked = play.team ?? play.start.team
  return [
    [GameEventKind.Played({ play })],
    (play.kind === "rush" || play.kind === "pass") && play.yards >= bigPlayYards && play.team !== undefined
      ? [GameEventKind.BigPlay({ team: play.team, yards: play.yards })]
      : [],
    play.kind === "sack" && sacked !== undefined ? [GameEventKind.Sack({ team: sacked })] : []
  ].flat()
}
