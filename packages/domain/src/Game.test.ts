import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import { Situation } from "./Situation.ts"
import { broadcast, snapshot, team } from "./TestGame.ts"

describe("GameSnapshot.progress", () => {
  it.each([
    ["scheduled", "upcoming"],
    ["delayed", "upcoming"],
    ["live", "live"],
    ["halftime", "live"],
    ["final", "over"],
    ["postponed", "over"],
    ["canceled", "over"]
  ] as const)("is %s → %s", (status, progress) => {
    assert.strictEqual(snapshot({ status }).progress(), progress)
  })

  it("reads a delay before kickoff as upcoming and a delay during the game as live", () => {
    assert.strictEqual(snapshot({ status: "delayed", period: 0 }).progress(), "upcoming")
    assert.strictEqual(snapshot({ status: "delayed", period: 2 }).progress(), "live")
  })
})

describe("GameSnapshot.margin", () => {
  it("is the points between the teams", () => {
    assert.strictEqual(
      snapshot({ home: { team: team("H"), score: 24 }, away: { team: team("A"), score: 17 } }).margin(),
      7
    )
    assert.strictEqual(
      snapshot({ home: { team: team("H"), score: 3 }, away: { team: team("A"), score: 10 } }).margin(),
      7
    )
    assert.strictEqual(
      snapshot({ home: { team: team("H"), score: 14 }, away: { team: team("A"), score: 14 } }).margin(),
      0
    )
  })
})

describe("GameSnapshot.inOvertime", () => {
  it("starts in the fifth period", () => {
    assert.isFalse(snapshot({ period: 4 }).inOvertime())
    assert.isTrue(snapshot({ period: 5 }).inOvertime())
    assert.isTrue(snapshot({ period: 6 }).inOvertime())
  })
})

describe("GameSnapshot.scored", () => {
  it.each([
    ["scheduled", 0, false],
    ["live", 2, true],
    ["halftime", 2, true],
    ["final", 4, true],
    ["delayed", 0, false],
    ["delayed", 2, true],
    ["postponed", 0, false],
    ["canceled", 0, false]
  ] as const)("is %s in period %d → %s", (status, period, scored) => {
    assert.strictEqual(snapshot({ status, period }).scored(), scored)
  })
})

describe("GameSnapshot.networks", () => {
  it("joins the networks with a dot", () => {
    assert.strictEqual(snapshot().networks(), "")
    assert.strictEqual(snapshot({ broadcasts: [broadcast("CBS")] }).networks(), "CBS")
    assert.strictEqual(
      snapshot({ broadcasts: [broadcast("CBS"), broadcast("ESPN", "streaming")] }).networks(),
      "CBS · ESPN"
    )
  })
})

describe("GameSnapshot#gameTime", () => {
  it("reads status, period, and clock", () => {
    assert.strictEqual(
      snapshot({ status: "live", period: 3, clock: "4:12" }).gameTime(),
      "live, period 3, 4:12"
    )
  })
})

describe("GameSnapshot.abbreviationOf", () => {
  const game = snapshot({ home: { team: team("BAMA"), score: 0 }, away: { team: team("UGA"), score: 0 } })

  it("names a team by its abbreviation, or an unknown id as itself", () => {
    assert.strictEqual(game.abbreviationOf(team("BAMA").id), "BAMA")
    assert.strictEqual(game.abbreviationOf(team("UGA").id), "UGA")
    assert.strictEqual(game.abbreviationOf(team("XYZ").id), team("XYZ").id)
  })
})

describe("GameSnapshot.timed", () => {
  it("knows a college overtime has no clock", () => {
    assert.isTrue(snapshot({ league: "fbs", status: "live", period: 4 }).timed())
    assert.isFalse(snapshot({ league: "fbs", status: "live", period: 5 }).timed())
    assert.isTrue(snapshot({ league: "nfl", status: "live", period: 5 }).timed())
  })
})

describe("GameSnapshot.matchup", () => {
  it("names the away team at the home team", () => {
    const game = snapshot({ away: { team: team("UGA"), score: 0 }, home: { team: team("BAMA"), score: 0 } })
    assert.strictEqual(game.matchup(), "UGA at BAMA")
  })
})

describe("GameSnapshot.gameTime", () => {
  const compare = GameSnapshot.gameTime

  it("puts upcoming behind live and live behind over", () => {
    const upcoming = snapshot({ status: "scheduled" })
    const live = snapshot({ status: "live", period: 1, clock: "10:00" })
    const over = snapshot({ status: "final", period: 4, clock: "0:00" })
    assert.strictEqual(compare(upcoming, live), -1)
    assert.strictEqual(compare(live, over), -1)
    assert.strictEqual(compare(over, upcoming), 1)
  })

  it("puts a later period ahead of an earlier one whatever the clock", () => {
    const later = snapshot({ status: "live", period: 2, clock: "14:00" })
    const earlier = snapshot({ status: "live", period: 1, clock: "0:30" })
    assert.strictEqual(compare(later, earlier), 1)
  })

  it("puts less time left ahead within a period", () => {
    const later = snapshot({ status: "live", period: 3, clock: "2:00" })
    const earlier = snapshot({ status: "live", period: 3, clock: "9:00" })
    assert.strictEqual(compare(later, earlier), 1)
    assert.strictEqual(compare(earlier, later), -1)
  })

  it("ignores the score", () => {
    const a = snapshot({ status: "live", period: 2, clock: "5:00", home: { team: team("HOME"), score: 7 } })
    const b = snapshot({ status: "live", period: 2, clock: "5:00" })
    assert.strictEqual(compare(a, b), 0)
  })

  it("puts halftime between the end of period 2 and the start of period 3", () => {
    const halftime = snapshot({ status: "halftime", period: 2, clock: "0:00" })
    assert.strictEqual(compare(halftime, snapshot({ status: "live", period: 2, clock: "0:10" })), 1)
    assert.strictEqual(compare(halftime, snapshot({ status: "live", period: 3, clock: "15:00" })), -1)
  })

  it("reads a delay during the game as live and a delay before kickoff as upcoming", () => {
    const delayed = snapshot({ status: "delayed", period: 2, clock: "5:00" })
    assert.strictEqual(compare(delayed, snapshot({ status: "live", period: 1, clock: "1:00" })), 1)
    assert.strictEqual(
      compare(snapshot({ status: "delayed", period: 0 }), snapshot({ status: "live", period: 1 })),
      -1
    )
  })
})

describe("GameSnapshot.watchOrder", () => {
  it("puts live games first, then upcoming by kickoff, then finished", () => {
    const ordered = [
      game("final", "final", "2026-10-03T16:00:00Z"),
      game("late", "scheduled", "2026-10-03T23:30:00Z"),
      game("halftime", "halftime", "2026-10-03T19:30:00Z"),
      game("early", "scheduled", "2026-10-03T20:00:00Z"),
      game("live", "live", "2026-10-03T16:00:00Z")
    ].sort(GameSnapshot.watchOrder)
    assert.deepStrictEqual(
      ordered.map((g) => g.id),
      ["live", "halftime", "early", "late", "final"]
    )
  })
})

describe("GameSnapshot#advancedTo", () => {
  const situation = new Situation({
    isRedZone: true,
    homeTimeouts: 2,
    awayTimeouts: 3,
    lastPlay: "Pass complete"
  })
  const polled = snapshot({
    home: { team: team("HOME", "fbs", { shortName: "Home" }), score: 0, ranking: 5 },
    away: { team: team("AWAY", "fbs", { shortName: "Away" }), score: 0, ranking: 12 },
    broadcasts: [broadcast("CBS")]
  })
  const pushed = snapshot({
    status: "live",
    period: 3,
    clock: "7:45",
    home: { team: team("HOME", "fbs", { shortName: "Pushed Home" }), score: 14 },
    away: { team: team("AWAY", "fbs", { shortName: "Pushed Away" }), score: 10 },
    situation
  })
  const advanced = polled.advancedTo(pushed)

  it("takes the later status, period, clock, scores, and situation", () => {
    assert.strictEqual(advanced.status, "live")
    assert.strictEqual(advanced.period, 3)
    assert.strictEqual(advanced.clock, "7:45")
    assert.strictEqual(advanced.home.score, 14)
    assert.strictEqual(advanced.away.score, 10)
    assert.deepStrictEqual(advanced.situation, situation)
  })

  it("keeps its own teams, rankings, kickoff, and broadcasts", () => {
    assert.strictEqual(advanced.home.team.shortName, "Home")
    assert.strictEqual(advanced.away.team.shortName, "Away")
    assert.strictEqual(advanced.home.ranking, 5)
    assert.strictEqual(advanced.away.ranking, 12)
    assert.isTrue(DateTime.Equivalence(advanced.kickoff, polled.kickoff))
    assert.deepStrictEqual(advanced.broadcasts, polled.broadcasts)
  })

  it("has no situation when the later snapshot has none", () => {
    const result = snapshot({ status: "live", period: 3, situation }).advancedTo(
      snapshot({ status: "final", period: 4 })
    )
    assert.isFalse("situation" in result)
  })

  it("is at the later snapshot's game time", () => {
    assert.strictEqual(GameSnapshot.gameTime(advanced, pushed), 0)
  })
})

function game(id: string, status: GameStatus, kickoff: string) {
  return snapshot({ id: GameId.make(id), status, kickoff: DateTime.makeUnsafe(kickoff) })
}
