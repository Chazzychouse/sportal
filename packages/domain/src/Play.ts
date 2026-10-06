import { Order, Schema } from "effect"
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
}
