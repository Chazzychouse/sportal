import { type DateTime, Schema } from "effect"
import type { GameSnapshot, Odds } from "./Game.ts"
import { Moment } from "./Moment.ts"

const Breakdown = Schema.Struct({
  prior: Schema.Finite,
  closeness: Schema.Finite,
  swing: Schema.Finite,
  upset: Schema.Finite,
  momentBonus: Schema.Finite
})

/**
 * How worth watching a game is now: its moment and since when, and a score from 0 to 100 with the points each part
 * gave it (`breakdown`, which adds up to the score before it is rounded and kept within 0–100).
 */
export class Classification extends Schema.Class<Classification>("sportal/Classification")({
  moment: Moment,
  score: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  since: Schema.DateTimeUtcFromString,
  breakdown: Breakdown
}) {
  /**
   * `game` in `moment` since `since`, scored. Before kickoff the score is the matchup prior alone; once live, the prior
   * fades as the game is played and the live value takes over: closeness weighted by time played, the largest recent
   * swing in win probability, an upset brewing, and the moment's bonus. A game that is over scores 0.
   */
  static of(
    game: {
      readonly snapshot: GameSnapshot
      readonly odds: Odds | undefined
      readonly winProbabilities: ReadonlyArray<number>
    },
    moment: Moment,
    since: DateTime.Utc
  ): Classification {
    const breakdown = breakdownOf(game.snapshot, game.odds, game.winProbabilities, moment)
    const total =
      breakdown.prior + breakdown.closeness + breakdown.swing + breakdown.upset + breakdown.momentBonus
    const score = Math.round(Math.min(100, Math.max(0, total)))
    return new Classification({ moment, score, since, breakdown })
  }
}

// Every tunable number of the score, with `momentBonus` below.
const weights = {
  /** An upcoming game's share of its prior. */
  upcoming: 0.6,
  /** The spread at which a matchup's line counts for nothing. */
  maxSpread: 21,
  /** The prior of a game with no input to judge it by. */
  unknownPrior: 0.5,
  /** The margin at which a game with no win probability counts as not close at all. */
  closeMargin: 17,
  /** How much a tie counts at kickoff, rising to all of it at the end of regulation. */
  earlyCloseness: 0.4,
  /** The win-probability swing that counts in full. */
  swingCap: 0.3,
  /** What a full swing is worth. */
  swing: 0.3,
  /** What an upset brewing in the second half is worth. */
  upset: 0.15
}

const momentBonus = {
  ScoringThreat: 0.15,
  CrunchTime: 0.1,
  BigPlay: 0.1,
  Live: 0,
  Break: -0.2,
  Upcoming: 0,
  Final: 0
} satisfies Record<Moment["_tag"], number>

/** Each part's points. */
function breakdownOf(
  snapshot: GameSnapshot,
  odds: Odds | undefined,
  winProbabilities: ReadonlyArray<number>,
  moment: Moment
): typeof Breakdown.Type {
  const none = { prior: 0, closeness: 0, swing: 0, upset: 0, momentBonus: 0 }
  const progress = snapshot.progress()
  if (progress === "over") return none
  const prior = priorOf(snapshot, odds)
  if (progress === "upcoming") return { ...none, prior: 100 * weights.upcoming * prior }

  const played = snapshot.timePlayed()
  const winProbability = winProbabilities.at(-1)
  const close =
    winProbability === undefined
      ? Math.max(0, 1 - snapshot.margin() / weights.closeMargin)
      : 1 - 2 * Math.abs(winProbability - 0.5)
  const swing = Math.min(largestSwing(winProbabilities), weights.swingCap) / weights.swingCap
  const upset = played >= 0.5 && underdogAhead(snapshot, odds, winProbability) ? weights.upset : 0
  return {
    prior: 100 * (1 - played) * prior,
    closeness: 100 * played * close * (weights.earlyCloseness + (1 - weights.earlyCloseness) * played),
    swing: 100 * played * weights.swing * swing,
    upset: 100 * played * upset,
    momentBonus: 100 * momentBonus[moment._tag]
  }
}

/**
 * The matchup prior, 0–1: the mean of the inputs the game has — how close the line is, how highly the teams are
 * ranked (college only), and how often they have won. A game with none of them is middling.
 */
function priorOf(snapshot: GameSnapshot, odds: Odds | undefined): number {
  const inputs = [
    odds === undefined ? undefined : 1 - Math.min(odds.spread, weights.maxSpread) / weights.maxSpread,
    snapshot.league === "fbs"
      ? (rankShare(snapshot.home.ranking) + rankShare(snapshot.away.ranking)) / 2
      : undefined,
    winShare(snapshot)
  ].filter((input) => input !== undefined)
  return inputs.length === 0
    ? weights.unknownPrior
    : inputs.reduce((sum, input) => sum + input, 0) / inputs.length
}

/** A ranking's share: 1 for first, falling to 0.04 for 25th; 0 unranked. */
function rankShare(ranking: number | undefined): number {
  return ranking === undefined ? 0 : (26 - ranking) / 25
}

/** The two teams' mean share of games won, when both have played. */
function winShare(snapshot: GameSnapshot): number | undefined {
  const [home, away] = [snapshot.home.record, snapshot.away.record].map((record) =>
    record === undefined || record.wins + record.losses === 0
      ? undefined
      : record.wins / (record.wins + record.losses)
  )
  return home === undefined || away === undefined ? undefined : (home + away) / 2
}

/** The largest change in win probability from one play to the next. */
function largestSwing(winProbabilities: ReadonlyArray<number>): number {
  return winProbabilities
    .slice(1)
    .reduce((most, next, index) => Math.max(most, Math.abs(next - (winProbabilities[index] ?? next))), 0)
}

/** Whether the side the line did not favor is ahead: by win probability when there is one, else on the scoreboard. */
function underdogAhead(
  snapshot: GameSnapshot,
  odds: Odds | undefined,
  winProbability: number | undefined
): boolean {
  const favorite = odds?.favorite
  if (favorite === undefined) return false
  const underdog = favorite === "home" ? "away" : "home"
  if (winProbability !== undefined) return (underdog === "home" ? winProbability : 1 - winProbability) > 0.5
  return snapshot[underdog].score > snapshot[favorite].score
}
