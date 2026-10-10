import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { Classification } from "./Classification.ts"
import type { GameSnapshot, Odds } from "./Game.ts"
import type { Moment } from "./Moment.ts"
import { PlayId } from "./Play.ts"
import { liveSnapshot, odds, sides, snapshot, team } from "./TestGame.ts"

describe("Classification.of, ranking", () => {
  it("should rank a tie late in the fourth above a tie in the first", () => {
    const late = scoreOf(liveSnapshot({ period: 4, clock: "1:30" }))
    const early = scoreOf(liveSnapshot({ period: 1, clock: "10:00" }))

    assert.isAbove(late, early)
  })

  it("should rank a fourth-quarter blowout below a one-score game in the fourth", () => {
    const blowout = scoreOf(liveSnapshot({ period: 4, clock: "8:00", ...sides(28, 7) }))
    const close = scoreOf(liveSnapshot({ period: 4, clock: "8:00", ...sides(14, 7) }))

    assert.isBelow(blowout, close)
  })

  it("should rank two top-10 teams before kickoff above an unranked 21–0 game in the second quarter", () => {
    const topTen = scoreOf(snapshot(sides(0, 0, { home: 3, away: 8 })), { moment: upcoming })
    const lopsided = scoreOf(liveSnapshot({ period: 2, clock: "7:30", ...sides(21, 0) }))

    assert.isAbove(topTen, lopsided)
  })

  it("should rank a ranked team against an unranked one before kickoff below a tie in the third quarter", () => {
    const pregame = scoreOf(snapshot(sides(0, 0, { home: 10 })), {
      moment: upcoming,
      odds: odds({ favorite: "home", spread: 10 })
    })
    const tied = scoreOf(liveSnapshot({ period: 3, clock: "7:30", ...sides(17, 17) }))

    assert.isBelow(pregame, tied)
  })

  it("should rank the better matchup higher of two ties in the third quarter", () => {
    const better = scoreOf(
      liveSnapshot({ period: 3, clock: "7:30", ...sides(17, 17, { home: 5, away: 12 }) })
    )
    const worse = scoreOf(liveSnapshot({ period: 3, clock: "7:30", ...sides(17, 17) }))

    assert.isAbove(better, worse)
  })

  it("should rank a late sack that swings the game above a sack in the first quarter of a 28–0 game", () => {
    const late = scoreOf(liveSnapshot({ period: 4, clock: "1:40", ...sides(17, 20) }), {
      moment: sack,
      winProbabilities: [0.45, 0.3]
    })
    const early = scoreOf(liveSnapshot({ period: 1, clock: "5:00", ...sides(28, 0) }), {
      moment: sack,
      winProbabilities: [0.97, 0.98]
    })

    assert.isAbove(late, early)
  })

  it("should rank a game in the red zone above the same game at midfield", () => {
    const game = liveSnapshot({ period: 2, clock: "6:00", ...sides(7, 3) })

    const threat = scoreOf(game, { moment: { _tag: "ScoringThreat", team: team("HOME").id, yardsToGo: 12 } })
    const midfield = scoreOf(game)

    assert.isAbove(threat, midfield)
  })

  it("should rank a game in a break below the same game live", () => {
    const game = liveSnapshot({ period: 3, clock: "7:30", ...sides(17, 17) })

    const resting = scoreOf(game, {
      moment: { _tag: "Break", reason: "timeout", expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z") }
    })
    const live = scoreOf(game)

    assert.isBelow(resting, live)
  })

  it("should rank the pregame underdog leading in the fourth above the favorite leading by as much", () => {
    const game = liveSnapshot({ period: 4, clock: "6:00", ...sides(10, 17) })

    const upset = scoreOf(game, { odds: odds({ favorite: "home", spread: 7 }) })
    const expected = scoreOf(game, { odds: odds({ favorite: "away", spread: 7 }) })

    assert.isAbove(upset, expected)
  })

  it("should score a final game 0", () => {
    const final = scoreOf(snapshot({ status: "final", period: 4, ...sides(21, 20) }), {
      moment: { _tag: "Final" }
    })

    assert.strictEqual(final, 0)
  })
})

describe("Classification.of, the matchup prior", () => {
  it("should leave out an input the game lacks, not count it as none", () => {
    const records = { wins: 3, losses: 1 }
    const game = snapshot({
      league: "nfl",
      home: { team: team("HOME", "nfl"), score: 0, record: records },
      away: { team: team("AWAY", "nfl"), score: 0, record: records }
    })

    const withoutLine = Classification.of(
      { snapshot: game, odds: undefined, winProbabilities: [] },
      upcoming,
      at
    )
    const worstLine = Classification.of(
      { snapshot: game, odds: odds({ spread: 21 }), winProbabilities: [] },
      upcoming,
      at
    )

    assert.isAbove(withoutLine.score, worstLine.score)
  })

  it("should give each part's points in the breakdown, adding up to the score", () => {
    const game = liveSnapshot({ period: 3, clock: "7:30", ...sides(17, 14, { home: 4 }) })

    const { score, breakdown } = Classification.of(
      { snapshot: game, odds: odds(), winProbabilities: [0.5, 0.6] },
      { _tag: "Live" },
      at
    )

    const total =
      breakdown.prior + breakdown.closeness + breakdown.swing + breakdown.upset + breakdown.momentBonus
    assert.strictEqual(score, Math.round(total))
  })
})

const at = DateTime.makeUnsafe("2026-10-10T20:00:00Z")

const upcoming: Moment = { _tag: "Upcoming" }

const sack: Moment = { _tag: "BigPlay", play: PlayId.make("1"), kind: "sack" }

/** `game`'s score, live with no line and no win probability unless `given` says otherwise. */
function scoreOf(
  game: GameSnapshot,
  given: { moment?: Moment; odds?: Odds; winProbabilities?: ReadonlyArray<number> } = {}
): number {
  const moment = given.moment ?? { _tag: "Live" }
  return Classification.of(
    { snapshot: game, odds: given.odds, winProbabilities: given.winProbabilities ?? [] },
    moment,
    at
  ).score
}
