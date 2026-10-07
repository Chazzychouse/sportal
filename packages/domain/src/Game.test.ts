import { assert, describe, it } from "@effect/vitest"
import { DateTime, Option } from "effect"
import { BallSpot, GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import { Situation } from "./Situation.ts"
import { broadcast, situation, snapshot, team } from "./TestGame.ts"

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

describe("GameSnapshot#statusLine", () => {
  it("reads status, period, and clock", () => {
    assert.strictEqual(
      snapshot({ status: "live", period: 3, clock: "4:12" }).statusLine(),
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
    yardLine: 12,
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

const inPlay = (overrides: Partial<GameSnapshot> = {}) =>
  snapshot({
    status: "live",
    period: 4,
    clock: "5:00",
    home: { team: team("UGA"), score: 21 },
    away: { team: team("ALA"), score: 17 },
    ...overrides
  })
const ball = (
  side: "UGA" | "ALA",
  yardLine: number,
  down = 1,
  distance = 10,
  rest: Partial<Situation> = {}
) => situation({ possession: team(side).id, yardLine, down, distance, ...rest })
const tags = (before: GameSnapshot, after: GameSnapshot) =>
  after.eventsSince(before).map((event) => event._tag)

describe("GameSnapshot#eventsSince", () => {
  it("reports each side's points", () => {
    const events = inPlay({ home: { team: team("UGA"), score: 28 } }).eventsSince(inPlay())
    assert.deepStrictEqual(
      events.map((e) => (e._tag === "ScoreChanged" ? { team: e.team, points: e.points } : e._tag)),
      [{ team: team("UGA").id, points: 7 }]
    )
  })

  it("reports a drive reaching the 40, then the red zone, then goal to go, once each", () => {
    const at = (yardLine: number, distance = 10) => inPlay({ situation: ball("ALA", yardLine, 1, distance) })
    assert.deepStrictEqual(tags(at(55), at(38)), ["ReachedScoringRange"])
    assert.deepStrictEqual(tags(at(38), at(30)), [])
    assert.deepStrictEqual(tags(at(30), at(18)), ["EnteredRedZone"])
    assert.deepStrictEqual(tags(at(18), at(6, 6)), ["GoalToGo"])
  })

  it("reports fourth down once per spot", () => {
    const fourth = inPlay({ situation: ball("ALA", 33, 4, 2) })
    assert.deepStrictEqual(tags(inPlay({ situation: ball("ALA", 34, 3, 3) }), fourth), ["FourthDown"])
    assert.deepStrictEqual(tags(fourth, fourth), [])
  })

  it("calls a change of possession a turnover only when the last play says interception or fumble", () => {
    const before = inPlay({ situation: ball("ALA", 45) })
    const picked = inPlay({ situation: ball("UGA", 70, 1, 10, { lastPlay: "Pass INTERCEPTED by K.Smith" }) })
    const punted = inPlay({ situation: ball("UGA", 80, 1, 10, { lastPlay: "J.Doe punt 40 yards" }) })
    const unclear = inPlay({ situation: ball("UGA", 80) })
    assert.deepStrictEqual(tags(before, picked), ["Turnover"])
    assert.deepStrictEqual(tags(before, punted), ["PossessionChanged"])
    assert.deepStrictEqual(tags(before, unclear), ["PossessionChanged"])
  })

  it("does not call the ball changing hands after a score a turnover", () => {
    const before = inPlay({ situation: ball("ALA", 3, 1, 3) })
    const after = inPlay({
      away: { team: team("ALA"), score: 24 },
      situation: ball("UGA", 75, 1, 10, { lastPlay: "Fumble recovered in the end zone, touchdown" })
    })
    assert.deepStrictEqual(tags(before, after), ["ScoreChanged", "PossessionChanged"])
  })

  it("reports a timeout from a drop in either side's count", () => {
    const before = inPlay({ situation: ball("ALA", 45) })
    const after = inPlay({ situation: ball("ALA", 45, 1, 10, { awayTimeouts: 2 }) })
    assert.deepStrictEqual(tags(before, after), ["TimeoutTaken"])
  })

  it("reports a timeout only as one fewer within the same period", () => {
    const at = (period: number, home: number, away: number) =>
      inPlay({ period, situation: ball("ALA", 45, 1, 10, { homeTimeouts: home, awayTimeouts: away }) })
    assert.deepStrictEqual(tags(at(4, 3, 3), at(5, 1, 1)), ["Overtime", "PeriodEnded"])
    assert.deepStrictEqual(tags(at(4, 3, 3), at(4, 0, 0)), [])
    assert.deepStrictEqual(tags(at(4, 3, 3), at(4, 3, 2)), ["TimeoutTaken"])
  })

  it("reports a new drive starting inside the 40 as reaching scoring range", () => {
    const before = inPlay({ situation: ball("ALA", 45) })
    const picked = inPlay({ situation: ball("UGA", 30, 1, 10, { lastPlay: "Pass INTERCEPTED by K.Smith" }) })
    assert.deepStrictEqual(tags(before, picked), ["Turnover", "ReachedScoringRange"])
  })

  it("reports the clock and status: two-minute drill, end of a period, halftime, overtime, final", () => {
    assert.deepStrictEqual(tags(inPlay({ clock: "2:05" }), inPlay({ clock: "1:58" })), ["TwoMinuteDrill"])
    assert.deepStrictEqual(
      tags(inPlay({ period: 1, clock: "0:00" }), inPlay({ period: 2, clock: "15:00" })),
      ["PeriodEnded"]
    )
    assert.deepStrictEqual(
      tags(inPlay({ period: 2, clock: "0:00" }), inPlay({ period: 2, status: "halftime" })),
      ["WentToHalftime"]
    )
    assert.deepStrictEqual(tags(inPlay({ clock: "0:00" }), inPlay({ period: 5, clock: "" })), [
      "Overtime",
      "PeriodEnded"
    ])
    assert.deepStrictEqual(tags(inPlay(), inPlay({ status: "final" })), ["WentFinal"])
  })
})

describe("GameSnapshot#secondsLeft", () => {
  it("reads the clock, and an unreadable one as a full quarter", () => {
    assert.strictEqual(inPlay({ clock: "2:10" }).secondsLeft(), 130)
    assert.strictEqual(inPlay({ clock: "0:00" }).secondsLeft(), 0)
    assert.strictEqual(inPlay({ clock: "" }).secondsLeft(), 900)
  })
})

describe("GameSnapshot#quarterLeft", () => {
  it("is the share of the quarter left on the clock", () => {
    assert.strictEqual(inPlay({ clock: "7:30" }).quarterLeft(), 0.5)
    assert.strictEqual(inPlay({ clock: "0:00" }).quarterLeft(), 0)
    assert.strictEqual(inPlay({ clock: "" }).quarterLeft(), 1)
  })
})

describe("GameSnapshot#spotOf", () => {
  const game = snapshot({ home: { team: team("H"), score: 0 }, away: { team: team("A"), score: 0 } })

  it.each([
    ["home", 75, 25, "away"],
    ["away", 75, 75, "home"],
    ["home", 1, 99, "away"],
    ["away", 1, 1, "home"],
    ["home", 99, 1, "away"]
  ] as const)(
    "puts %s with %d to go at %d yards from the home goal, going %s",
    (side, toGo, yards, toward) => {
      assert.deepStrictEqual(
        game.spotOf({ team: game[side].team.id, yardsToEndzone: toGo }),
        Option.some(new BallSpot({ yards, toward }))
      )
    }
  )

  it("is none without a team, without a yard line, or for a team in neither side", () => {
    assert.isTrue(Option.isNone(game.spotOf({ yardsToEndzone: 40 })))
    assert.isTrue(Option.isNone(game.spotOf({ team: game.home.team.id })))
    assert.isTrue(Option.isNone(game.spotOf({ team: team("X").id, yardsToEndzone: 40 })))
  })

  it.each([105, -3])("is none for %d yards to the goal, off the field", (yardsToEndzone) => {
    assert.isTrue(Option.isNone(game.spotOf({ team: game.home.team.id, yardsToEndzone })))
    assert.isTrue(Option.isNone(game.spotOf({ team: game.away.team.id, yardsToEndzone })))
  })
})

describe("GameSnapshot#ball", () => {
  it("is the spot of the team with the ball at its yard line", () => {
    assert.deepStrictEqual(
      snapshot({ situation: situation({ yardLine: 75 }) }).ball(),
      Option.some(new BallSpot({ yards: 25, toward: "away" }))
    )
  })

  it("is none without a situation or without a team with the ball", () => {
    assert.isTrue(Option.isNone(snapshot().ball()))
    assert.isTrue(Option.isNone(snapshot({ situation: situation({ possession: undefined }) }).ball()))
  })
})

describe("GameSnapshot#inPlay", () => {
  it("is live with time on the clock, or in a college overtime", () => {
    assert.isTrue(snapshot({ status: "live", period: 2, clock: "4:12" }).inPlay())
    assert.isTrue(snapshot({ status: "live", period: 5, clock: "0:00" }).inPlay())
  })

  it("is not at halftime, between periods, in a delay, before kickoff, or after the final", () => {
    assert.isFalse(snapshot({ status: "halftime", period: 2, clock: "0:00" }).inPlay())
    assert.isFalse(snapshot({ status: "delayed", period: 3, clock: "6:40" }).inPlay())
    assert.isFalse(snapshot({ status: "live", period: 1, clock: "0:00" }).inPlay())
    assert.isFalse(snapshot({ status: "scheduled" }).inPlay())
    assert.isFalse(snapshot({ status: "final", period: 4, clock: "0:00" }).inPlay())
  })

  it("is not at 0:00 in an NFL overtime, which runs on a clock", () => {
    assert.isFalse(snapshot({ league: "nfl", status: "live", period: 5, clock: "0:00" }).inPlay())
    assert.isTrue(snapshot({ league: "nfl", status: "live", period: 5, clock: "3:20" }).inPlay())
  })
})
