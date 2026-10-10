import { Order, Schema } from "effect"
import { BigPlayKind, PlayId } from "./Play.ts"
import { TeamId } from "./Team.ts"

/** Why a live game has stopped. */
export const BreakReason = Schema.Literals(["timeout", "periodEnd", "halftime", "delay", "afterScore"])
export type BreakReason = typeof BreakReason.Type

const cases = Schema.TaggedUnion({
  /** The team with the ball is in the red zone. */
  ScoringThreat: { team: TeamId, yardsToGo: Schema.Int },
  /** The fourth quarter's last five minutes, or overtime, within one score. */
  CrunchTime: { margin: Schema.Int, secondsLeft: Schema.Int },
  /** A big play, for a while after it. */
  BigPlay: { play: PlayId, kind: BigPlayKind },
  Live: {},
  Break: { reason: BreakReason },
  Upcoming: {},
  Final: {}
})

/**
 * What kind of thing is happening in a game now: one case per game, the one highest in `precedence` of those that
 * hold, with what commentary and prompts need of it.
 */
export const Moment = Object.assign(cases, {
  /** Higher precedence first: a scoring threat, crunch time, a big play, live play, a break, then not live. */
  precedence: Order.mapInput(Order.Number, (moment: typeof cases.Type) => rank[moment._tag])
})
export type Moment = typeof cases.Type

const rank = {
  ScoringThreat: 0,
  CrunchTime: 1,
  BigPlay: 2,
  Live: 3,
  Break: 4,
  Upcoming: 5,
  Final: 6
} satisfies Record<Moment["_tag"], number>
