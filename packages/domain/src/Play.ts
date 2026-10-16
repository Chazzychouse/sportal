import { Option, Order, Schema } from "effect"
import { TeamId } from "./Team.ts"

/** The feed's own id. Not ordered: order plays by `Play.order`. */
export const PlayId = Schema.String.pipe(Schema.brand("PlayId"))
export type PlayId = typeof PlayId.Type

const Spot = Schema.Struct({
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardsToEndzone: Schema.optional(Schema.Int),
  team: TeamId
})

// Where a play ended, which can lack its team: the feed has sent a completion's, a blocked field goal's, and an
// official timeout's end without one.
const EndSpot = Schema.Struct({ ...Spot.fields, team: Schema.optional(TeamId) })

/**
 * How a football play moved the ball, as the field draws it: a run, a caught pass, an incomplete pass, a sack, a
 * kick, a penalty, or anything else (a turnover, a safety, a timeout, a stoppage, the end of a period).
 */
export const FootballKind = Schema.Literals(["run", "pass", "incomplete", "sack", "kick", "penalty", "other"])
export type FootballKind = typeof FootballKind.Type

/** What a football play adds: how it moved the ball, the yards it gained, and where it started and ended. */
export class FootballDetail extends Schema.TaggedClass<FootballDetail>()("Football", {
  kind: FootballKind,
  yards: Schema.Int,
  start: Spot,
  end: EndSpot
}) {
  /** Whether the play went backwards: a sack always does. */
  lostYards(): boolean {
    return this.kind === "sack" || this.yards < 0
  }
}

/** What a baseball play adds: the outs and the count after it. */
export class BaseballDetail extends Schema.TaggedClass<BaseballDetail>()("Baseball", {
  outs: Schema.Int,
  balls: Schema.Int,
  strikes: Schema.Int
}) {}

/** What a basketball play adds: nothing yet. */
export class BasketballDetail extends Schema.TaggedClass<BasketballDetail>()("Basketball", {}) {}

/**
 * A play's sport-specific part, by sport. A sport's case can later become a union of play cases read from the feed's
 * type, without changing `Play` or any other sport.
 */
export const PlayDetail = Schema.Union([FootballDetail, BaseballDetail, BasketballDetail]).pipe(
  Schema.toTaggedUnion("_tag")
)
export type PlayDetail = typeof PlayDetail.Type

/** One play as a game's play-by-play lists it, in any sport: what every sport's plays carry, and its sport's detail. */
export class Play extends Schema.Class<Play>("sportal/Play")({
  id: PlayId,
  sequence: Schema.Int,
  period: Schema.Int,
  /** The game clock as the feed shows it ("4:12"); empty in a sport without one. */
  clock: Schema.String,
  text: Schema.String,
  /** The feed's own type for the play, kept so a sport's detail can later grow into cases read from it. */
  type: Schema.Struct({ id: Schema.String, text: Schema.String }),
  scoring: Schema.Boolean,
  homeScore: Schema.Int,
  awayScore: Schema.Int,
  /** The team the play is credited to, when the feed says: the team with the ball, or a timeout's caller. */
  team: Schema.optional(TeamId),
  detail: PlayDetail
}) {
  /** By `sequence`. */
  static readonly order: Order.Order<Play> = Order.mapInput(Order.Number, (play: Play) => play.sequence)

  /** The team with the ball at the snap: the play's own team, else a football play's start spot team. */
  offense(): Option.Option<TeamId> {
    if (this.team !== undefined) return Option.some(this.team)
    return PlayDetail.guards.Football(this.detail) ? Option.some(this.detail.start.team) : Option.none()
  }
}
