import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { GameId } from "./Game.ts"
import { GameStats } from "./GameStats.ts"

describe("GameStats.empty", () => {
  it("should have no linescore, stats, leaders, scoring plays or highlights", () => {
    const stats = GameStats.empty(game)

    assert.deepStrictEqual(
      [stats.linescore, stats.teamStats, stats.leaders, stats.scoringPlays, stats.highlights],
      [{ home: [], away: [] }, [], [], [], []]
    )
  })

  it("should have no win probability", () => {
    const stats = GameStats.empty(game)

    assert.isUndefined(stats.winProbability)
  })

  it("should name its game", () => {
    const stats = GameStats.empty(game)

    assert.strictEqual(stats.game, game)
  })
})

describe("GameStats.homeShare", () => {
  it("should give the home side's share of two whole numbers", () => {
    const share = GameStats.homeShare({ label: "1st Downs", home: "19", away: "26" })

    assert.deepStrictEqual(share, Option.some(19 / 45))
  })

  it("should read decimals", () => {
    const share = GameStats.homeShare({ label: "Yards per Play", home: "4.5", away: "4.5" })

    assert.deepStrictEqual(share, Option.some(0.5))
  })

  it("should split evenly when both sides are 0", () => {
    const share = GameStats.homeShare({ label: "Turnovers", home: "0", away: "0" })

    assert.deepStrictEqual(share, Option.some(0.5))
  })

  it.each([
    ["a made-attempted pair", "7-17", "6-13"],
    ["a clock", "35:38", "24:22"],
    ["a fraction", "27/51", "22/37"]
  ])("should give no share for %s", (_name, home, away) => {
    const share = GameStats.homeShare({ label: "Stat", home, away })

    assert.isTrue(Option.isNone(share))
  })
})

const game = GameId.make("401872971")
