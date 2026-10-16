import { Order, Schema } from "effect"
import { TeamId } from "./Team.ts"

/** The feed's own id. Not ordered: order plays by `Play.sequence`. */
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

// What every play carries.
const common = {
  id: PlayId,
  sequence: Schema.Int,
  period: Schema.Int,
  clock: Schema.String,
  text: Schema.String,
  scoring: Schema.Boolean,
  homeScore: Schema.Int,
  awayScore: Schema.Int,
  start: Spot,
  end: EndSpot
}

// What a snap, a kick, a safety, or a penalty gains: `team` is the team with the ball, when the feed says.
const gained = {
  team: Schema.optional(TeamId),
  yards: Schema.Int
}

const Return = Schema.Literals(["none", "returned", "touchdown"])

/** A run. */
export class Rush extends Schema.TaggedClass<Rush>()("Rush", {
  ...common,
  ...gained,
  touchdown: Schema.Boolean
}) {}

/** A caught pass. */
export class Completion extends Schema.TaggedClass<Completion>()("Completion", {
  ...common,
  ...gained,
  touchdown: Schema.Boolean
}) {}

/** A pass no one caught. */
export class Incompletion extends Schema.TaggedClass<Incompletion>()("Incompletion", {
  ...common,
  ...gained
}) {}

/** A pass the defense caught, and how far it was run back. */
export class Interception extends Schema.TaggedClass<Interception>()("Interception", {
  ...common,
  ...gained,
  return: Return
}) {}

/** The passer tackled behind the line, and whether the defense took the ball from a fumble. */
export class Sack extends Schema.TaggedClass<Sack>()("Sack", {
  ...common,
  ...gained,
  fumbleLost: Schema.Boolean
}) {}

/** A fumble, and who recovered it, when the feed says. */
export class Fumble extends Schema.TaggedClass<Fumble>()("Fumble", {
  ...common,
  ...gained,
  recovery: Schema.Literals(["unknown", "own", "opponent", "touchdown"])
}) {}

/** A try for two points after a touchdown, passed or run. */
export class TwoPointTry extends Schema.TaggedClass<TwoPointTry>()("TwoPointTry", {
  ...common,
  ...gained,
  by: Schema.Literals(["pass", "rush"])
}) {}

/** A kickoff, and whether it was returned for a touchdown. */
export class Kickoff extends Schema.TaggedClass<Kickoff>()("Kickoff", {
  ...common,
  ...gained,
  returnTouchdown: Schema.Boolean
}) {}

/** A punt, and how far it was run back. */
export class Punt extends Schema.TaggedClass<Punt>()("Punt", { ...common, ...gained, return: Return }) {}

/** A field goal attempt, and how it ended. */
export class FieldGoal extends Schema.TaggedClass<FieldGoal>()("FieldGoal", {
  ...common,
  ...gained,
  result: Schema.Literals(["good", "missed", "blocked"])
}) {}

/** A kick for the point after a touchdown, and whether it was good. */
export class ExtraPoint extends Schema.TaggedClass<ExtraPoint>()("ExtraPoint", {
  ...common,
  ...gained,
  good: Schema.Boolean
}) {}

/** A safety. */
export class Safety extends Schema.TaggedClass<Safety>()("Safety", { ...common, ...gained }) {}

/** A penalty enforced without a play. */
export class Penalty extends Schema.TaggedClass<Penalty>()("Penalty", { ...common, ...gained }) {}

/** A team's timeout: `team` is the team that called it, when something says. */
export class Timeout extends Schema.TaggedClass<Timeout>()("Timeout", {
  ...common,
  team: Schema.optional(TeamId)
}) {}

/** A stop no team called. */
export class Stoppage extends Schema.TaggedClass<Stoppage>()("Stoppage", {
  ...common,
  kind: Schema.Literals(["officialTimeout", "twoMinuteWarning", "coinToss"])
}) {}

/** The end of a period, and what else ended with it. */
export class PeriodEnd extends Schema.TaggedClass<PeriodEnd>()("PeriodEnd", {
  ...common,
  ends: Schema.Literals(["period", "half", "regulation", "game"])
}) {}

/** A play of a type no case knows, with the feed's own type. */
export class Other extends Schema.TaggedClass<Other>()("Other", {
  ...common,
  type: Schema.Struct({ id: Schema.String, text: Schema.String })
}) {}

const cases = Schema.Union([
  Rush,
  Completion,
  Incompletion,
  Interception,
  Sack,
  Fumble,
  TwoPointTry,
  Kickoff,
  Punt,
  FieldGoal,
  ExtraPoint,
  Safety,
  Penalty,
  Timeout,
  Stoppage,
  PeriodEnd,
  Other
]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * Every football play, as the game's play-by-play lists it: a tagged union of its cases, each keeping what the feed's
 * play type says, with `.match`, `.guards`, `.cases`, `order`, `gainsYards`, `offense`, and `lostYards`.
 */
export const FootballPlay = Object.assign(cases, {
  /** By `sequence`. */
  order: Order.mapInput(Order.Number, (play: typeof cases.Type) => play.sequence),
  gainsYards,
  offense,
  lostYards
})
export type FootballPlay = typeof FootballPlay.Type

/**
 * A football play's case and what its feed's play type says of it: its `_tag` and its outcome fields, without what
 * every play carries or what it gained, as `{ _tag: "Punt", return: "none" }`.
 */
export type PlayOutcome = typeof cases.Encoded extends infer Case
  ? Case extends unknown
    ? Omit<Case, keyof typeof common | keyof typeof gained>
    : never
  : never

/**
 * The plays of every sport; football's only, for now.
 *
 * @alias
 */
export const Play = FootballPlay
export type Play = FootballPlay

/** Whether `play`'s case gains yards for a team: a snap, a kick, a safety, or a penalty. */
function gainsYards<P extends { readonly _tag: (typeof cases.Type)["_tag"] }>(
  play: P
): play is Extract<P, { readonly _tag: Extract<typeof cases.Type, { readonly yards: number }>["_tag"] }> {
  return "yards" in cases.cases[play._tag].fields
}

/** The team with the ball at the snap: the team a play that gains yards names, else its start spot's. */
function offense(play: typeof cases.Type): TeamId {
  return (gainsYards(play) ? play.team : undefined) ?? play.start.team
}

/** Whether `play` gains yards and went backwards: a sack always does. */
function lostYards(play: typeof cases.Type): boolean {
  return gainsYards(play) && (cases.guards.Sack(play) || play.yards < 0)
}
