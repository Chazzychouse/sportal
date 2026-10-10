import { Duration, Order, Schema } from "effect"
import type { LeagueId } from "./League.ts"
import { BigPlayKind, PlayId } from "./Play.ts"
import { TeamId } from "./Team.ts"

const reasons = Schema.Literals([
  "halftime",
  "delay",
  "periodEnd",
  "twoMinuteWarning",
  "timeout",
  "review",
  "injury",
  "afterScore",
  "afterKickoff",
  "possessionChange",
  "stall"
])

/** Why a live game has stopped, with how long each kind of stop typically lasts. */
export const BreakReason = Object.assign(reasons, {
  /** How long a break for `reason` typically lasts in `league`: a guess, tuned on game days. */
  typicalLength: (reason: typeof reasons.Type, league: LeagueId): Duration.Duration =>
    Duration.seconds(reason === "halftime" && league === "fbs" ? collegeHalftime : typicalSeconds[reason])
})
export type BreakReason = typeof reasons.Type

const typicalSeconds = {
  halftime: 13 * 60,
  delay: 10 * 60,
  periodEnd: 120,
  twoMinuteWarning: 135,
  timeout: 60,
  review: 150,
  injury: 120,
  afterScore: 135,
  afterKickoff: 120,
  possessionChange: 120,
  stall: 90
} satisfies Record<BreakReason, number>

const collegeHalftime = 20 * 60

const ScoringThreat = { team: TeamId, yardsToGo: Schema.Int }
const CrunchTime = { margin: Schema.Int, secondsLeft: Schema.Int }

/** What was at stake when a game stopped: a scoring threat or crunch time. */
export const Stakes = Schema.TaggedUnion({ ScoringThreat, CrunchTime })
export type Stakes = typeof Stakes.Type

const cases = Schema.TaggedUnion({
  /** The team with the ball is in the red zone. */
  ScoringThreat,
  /** The fourth quarter's last five minutes, or overtime, within one score. */
  CrunchTime,
  /** A big play, for a while after it. */
  BigPlay: { play: PlayId, kind: BigPlayKind },
  Live: {},
  /** A live game stopped, when it is likely back, what was at stake when it stopped, and the big play just before. */
  Break: {
    reason: reasons,
    expectedEnd: Schema.DateTimeUtcFromString,
    during: Schema.optional(Stakes),
    after: Schema.optional(Schema.Struct({ play: PlayId, kind: BigPlayKind }))
  },
  Upcoming: {},
  Final: {}
})

/**
 * What kind of thing is happening in a game now: one case per game, the one highest in `precedence` of those that
 * hold, with what commentary and prompts need of it.
 */
export const Moment = Object.assign(cases, {
  /**
   * Higher precedence first: a big play, a break, a scoring threat, crunch time, live play, then not live. It governs
   * what holds in `settled`; `momentOf` itself lets a break win over a big play and carry it.
   */
  precedence: Order.mapInput(Order.Number, (moment: typeof cases.Type) => rank[moment._tag])
})
export type Moment = typeof cases.Type

const rank = {
  BigPlay: 0,
  Break: 1,
  ScoringThreat: 2,
  CrunchTime: 3,
  Live: 4,
  Upcoming: 5,
  Final: 6
} satisfies Record<Moment["_tag"], number>
