import { assert, describe, it } from "@effect/vitest"
import { DateTime, Option } from "effect"
import { BallSpot, GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import { Situation } from "./Situation.ts"
import { broadcast, liveSnapshot, situation, snapshot, team } from "./TestGame.ts"

describe("GameSnapshot#progress", () => {
  it.each([
    ["scheduled", "upcoming"],
    ["delayed", "upcoming"],
    ["live", "live"],
    ["halftime", "live"],
    ["final", "over"],
    ["postponed", "over"],
    ["canceled", "over"]
  ] as const)("should read a %s game as %s", (status, progress) => {
    const game = snapshot({ status })

    assert.strictEqual(game.progress(), progress)
  })

  it("should read a delay before kickoff as upcoming", () => {
    const game = snapshot({ status: "delayed", period: 0 })

    assert.strictEqual(game.progress(), "upcoming")
  })

  it("should read a delay during the game as live", () => {
    const game = snapshot({ status: "delayed", period: 2 })

    assert.strictEqual(game.progress(), "live")
  })
})

describe("GameSnapshot#margin", () => {
  it("should be the points the home team leads by", () => {
    const game = withScores(24, 17)

    assert.strictEqual(game.margin(), 7)
  })

  it("should be the points the away team leads by", () => {
    const game = withScores(3, 10)

    assert.strictEqual(game.margin(), 7)
  })

  it("should be zero when the scores are level", () => {
    const game = withScores(14, 14)

    assert.strictEqual(game.margin(), 0)
  })
})

describe("GameSnapshot#inOvertime", () => {
  it("should not be in overtime in the fourth period", () => {
    const game = snapshot({ period: 4 })

    assert.isFalse(game.inOvertime())
  })

  it("should be in overtime in the fifth period", () => {
    const game = snapshot({ period: 5 })

    assert.isTrue(game.inOvertime())
  })

  it("should be in overtime in the sixth period", () => {
    const game = snapshot({ period: 6 })

    assert.isTrue(game.inOvertime())
  })
})

describe("GameSnapshot#scored", () => {
  it.each([
    ["scheduled", 0, false],
    ["live", 2, true],
    ["halftime", 2, true],
    ["final", 4, true],
    ["delayed", 0, false],
    ["delayed", 2, true],
    ["postponed", 0, false],
    ["canceled", 0, false]
  ] as const)("should read %s in period %d as scored: %s", (status, period, scored) => {
    const game = snapshot({ status, period })

    assert.strictEqual(game.scored(), scored)
  })
})

describe("GameSnapshot#networks", () => {
  it("should be empty with no broadcasts", () => {
    const game = snapshot()

    assert.strictEqual(game.networks(), "")
  })

  it("should name the one network", () => {
    const game = snapshot({ broadcasts: [broadcast("CBS")] })

    assert.strictEqual(game.networks(), "CBS")
  })

  it("should join the networks with a dot", () => {
    const game = snapshot({ broadcasts: [broadcast("CBS"), broadcast("ESPN", "streaming")] })

    assert.strictEqual(game.networks(), "CBS · ESPN")
  })
})

describe("GameSnapshot#statusLine", () => {
  it("should read status, period, and clock", () => {
    const game = snapshot({ status: "live", period: 3, clock: "4:12" })

    assert.strictEqual(game.statusLine(), "live, period 3, 4:12")
  })
})

describe("GameSnapshot#abbreviationOf", () => {
  const game = snapshot({ home: { team: team("BAMA"), score: 0 }, away: { team: team("UGA"), score: 0 } })

  it("should name the home team by its abbreviation", () => {
    assert.strictEqual(game.abbreviationOf(team("BAMA").id), "BAMA")
  })

  it("should name the away team by its abbreviation", () => {
    assert.strictEqual(game.abbreviationOf(team("UGA").id), "UGA")
  })

  it("should name an unknown id as itself", () => {
    assert.strictEqual(game.abbreviationOf(team("XYZ").id), team("XYZ").id)
  })
})

describe("GameSnapshot#timed", () => {
  it("should run on a clock in a college fourth period", () => {
    const game = snapshot({ league: "fbs", status: "live", period: 4 })

    assert.isTrue(game.timed())
  })

  it("should have no clock in a college overtime", () => {
    const game = snapshot({ league: "fbs", status: "live", period: 5 })

    assert.isFalse(game.timed())
  })

  it("should run on a clock in an NFL overtime", () => {
    const game = snapshot({ league: "nfl", status: "live", period: 5 })

    assert.isTrue(game.timed())
  })
})

describe("GameSnapshot#matchup", () => {
  it("should name the away team at the home team", () => {
    const game = snapshot({ away: { team: team("UGA"), score: 0 }, home: { team: team("BAMA"), score: 0 } })

    assert.strictEqual(game.matchup(), "UGA at BAMA")
  })
})

describe("GameSnapshot.gameTime", () => {
  const compare = GameSnapshot.gameTime

  it("should put upcoming before live", () => {
    const upcoming = snapshot({ status: "scheduled" })
    const live = snapshot({ status: "live", period: 1, clock: "10:00" })

    assert.strictEqual(compare(upcoming, live), -1)
  })

  it("should put live before over", () => {
    const live = snapshot({ status: "live", period: 1, clock: "10:00" })
    const over = snapshot({ status: "final", period: 4, clock: "0:00" })

    assert.strictEqual(compare(live, over), -1)
  })

  it("should put over after upcoming", () => {
    const upcoming = snapshot({ status: "scheduled" })
    const over = snapshot({ status: "final", period: 4, clock: "0:00" })

    assert.strictEqual(compare(over, upcoming), 1)
  })

  it("should put a later period ahead of an earlier one whatever the clock", () => {
    const later = snapshot({ status: "live", period: 2, clock: "14:00" })
    const earlier = snapshot({ status: "live", period: 1, clock: "0:30" })

    assert.strictEqual(compare(later, earlier), 1)
  })

  it("should put less time left ahead within a period", () => {
    const later = snapshot({ status: "live", period: 3, clock: "2:00" })
    const earlier = snapshot({ status: "live", period: 3, clock: "9:00" })

    assert.strictEqual(compare(later, earlier), 1)
  })

  it("should put more time left behind within a period", () => {
    const later = snapshot({ status: "live", period: 3, clock: "2:00" })
    const earlier = snapshot({ status: "live", period: 3, clock: "9:00" })

    assert.strictEqual(compare(earlier, later), -1)
  })

  it("should ignore the score", () => {
    const scored = snapshot({
      status: "live",
      period: 2,
      clock: "5:00",
      home: { team: team("HOME"), score: 7 }
    })
    const level = snapshot({ status: "live", period: 2, clock: "5:00" })

    assert.strictEqual(compare(scored, level), 0)
  })

  it("should put halftime after the end of period 2 at the same clock", () => {
    const halftime = snapshot({ status: "halftime", period: 2, clock: "0:00" })
    const endOfHalf = snapshot({ status: "live", period: 2, clock: "0:00" })

    assert.strictEqual(compare(halftime, endOfHalf), 1)
  })

  it("should put the end of period 2 before halftime at the same clock", () => {
    const halftime = snapshot({ status: "halftime", period: 2, clock: "0:00" })
    const endOfHalf = snapshot({ status: "live", period: 2, clock: "0:00" })

    assert.strictEqual(compare(endOfHalf, halftime), -1)
  })

  it("should tie a delay with play at the same clock", () => {
    const delayed = snapshot({ status: "delayed", period: 3, clock: "8:00" })
    const playing = snapshot({ status: "live", period: 3, clock: "8:00" })

    assert.strictEqual(compare(delayed, playing), 0)
  })

  it("should put halftime after play with time left in period 2", () => {
    const halftime = snapshot({ status: "halftime", period: 2, clock: "0:00" })
    const playing = snapshot({ status: "live", period: 2, clock: "0:10" })

    assert.strictEqual(compare(halftime, playing), 1)
  })

  it("should put halftime before the start of period 3", () => {
    const halftime = snapshot({ status: "halftime", period: 2, clock: "0:00" })
    const secondHalf = snapshot({ status: "live", period: 3, clock: "15:00" })

    assert.strictEqual(compare(halftime, secondHalf), -1)
  })

  it("should read a delay during the game as live", () => {
    const delayed = snapshot({ status: "delayed", period: 2, clock: "5:00" })
    const earlierPlay = snapshot({ status: "live", period: 1, clock: "1:00" })

    assert.strictEqual(compare(delayed, earlierPlay), 1)
  })

  it("should read a delay before kickoff as upcoming", () => {
    const delayed = snapshot({ status: "delayed", period: 0 })
    const live = snapshot({ status: "live", period: 1 })

    assert.strictEqual(compare(delayed, live), -1)
  })
})

describe("GameSnapshot#isAheadOf", () => {
  it("should be ahead in a later period", () => {
    const later = at({ period: 3, clock: "15:00" })

    assert.isTrue(later.isAheadOf(at()))
  })

  it("should be ahead in the same period with less on the clock", () => {
    const later = at({ clock: "4:59" })

    assert.isTrue(later.isAheadOf(at()))
  })

  it("should be ahead at the same game time with more points", () => {
    assert.isTrue(scoredAt(7, 0).isAheadOf(scoredAt(6, 0)))
  })

  it("should not be ahead at the same game time with fewer points", () => {
    assert.isFalse(scoredAt(6, 0).isAheadOf(scoredAt(7, 0)))
  })

  it("should be ahead at the same game time with equal points split differently", () => {
    assert.isTrue(scoredAt(7, 3).isAheadOf(scoredAt(3, 7)))
  })

  it("should have halftime ahead of play at the end of the second period", () => {
    const halftime = at({ status: "halftime", clock: "0:00" })

    assert.isTrue(halftime.isAheadOf(at({ clock: "0:00" })))
  })

  it("should not have play at the end of the second period ahead of halftime", () => {
    const halftime = at({ status: "halftime", clock: "0:00" })

    assert.isFalse(at({ clock: "0:00" }).isAheadOf(halftime))
  })

  it("should have a final ahead of play at the end of the last period", () => {
    const final = at({ status: "final", period: 4, clock: "0:00" })
    const endOfGame = at({ period: 4, clock: "0:00" })

    assert.isTrue(final.isAheadOf(endOfGame))
  })

  it("should not have play at the end of the last period ahead of the final", () => {
    const final = at({ status: "final", period: 4, clock: "0:00" })
    const endOfGame = at({ period: 4, clock: "0:00" })

    assert.isFalse(endOfGame.isAheadOf(final))
  })

  it("should not have a delay ahead of play at the same clock and points", () => {
    const delayed = at({ status: "delayed" })

    assert.isFalse(delayed.isAheadOf(at()))
  })

  it("should not have play ahead of a delay at the same clock and points", () => {
    const delayed = at({ status: "delayed" })

    assert.isFalse(at().isAheadOf(delayed))
  })

  it.each(
    pairs([
      [at({ status: "halftime", clock: "0:00" }), at({ clock: "0:00" })],
      [at({ status: "delayed" }), at()],
      [at({ status: "delayed", clock: "0:00" }), at({ status: "halftime", clock: "0:00" })],
      [at({ status: "final", period: 4, clock: "0:00" }), at({ period: 4, clock: "0:00" })],
      [
        at({ status: "final", period: 4, clock: "0:00" }),
        at({ status: "canceled", period: 4, clock: "0:00" })
      ],
      [at({ status: "postponed" }), at()],
      [snapshot({ status: "scheduled" }), snapshot({ status: "delayed", period: 0 })],
      [scoredAt(7, 0), scoredAt(6, 0)],
      [at({ clock: "4:59" }), at()],
      [at(), at()]
    ])
  )("should never be ahead both ways, %s", (_name, a, b) => {
    assert.isFalse(a.isAheadOf(b) && b.isAheadOf(a))
  })

  it("should not have an equal snapshot ahead", () => {
    assert.isFalse(at().isAheadOf(at()))
  })

  it("should not be ahead at an earlier game time whatever its points", () => {
    assert.isFalse(scoredAt(14, 0).isAheadOf(at({ period: 3 })))
  })
})

describe("GameSnapshot.watchOrder", () => {
  it("should put live games first, then upcoming by kickoff, then finished", () => {
    const games = [
      gameAt("final", "final", "2026-10-03T16:00:00Z"),
      gameAt("late", "scheduled", "2026-10-03T23:30:00Z"),
      gameAt("halftime", "halftime", "2026-10-03T19:30:00Z"),
      gameAt("early", "scheduled", "2026-10-03T20:00:00Z"),
      gameAt("live", "live", "2026-10-03T16:00:00Z")
    ]

    const ordered = games.toSorted(GameSnapshot.watchOrder)

    assert.deepStrictEqual(
      ordered.map((g) => g.id),
      ["live", "halftime", "early", "late", "final"]
    )
  })
})

describe("GameSnapshot#advancedTo", () => {
  const situationPushed = new Situation({
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
    situation: situationPushed
  })

  it("should take the later status, period, and clock", () => {
    const advanced = polled.advancedTo(pushed)

    assert.strictEqual(advanced.status, "live")
    assert.strictEqual(advanced.period, 3)
    assert.strictEqual(advanced.clock, "7:45")
  })

  it("should take the later scores", () => {
    const advanced = polled.advancedTo(pushed)

    assert.strictEqual(advanced.home.score, 14)
    assert.strictEqual(advanced.away.score, 10)
  })

  it("should take the later situation", () => {
    const advanced = polled.advancedTo(pushed)

    assert.deepStrictEqual(advanced.situation, situationPushed)
  })

  it("should keep its own teams", () => {
    const advanced = polled.advancedTo(pushed)

    assert.strictEqual(advanced.home.team.shortName, "Home")
    assert.strictEqual(advanced.away.team.shortName, "Away")
  })

  it("should keep its own rankings", () => {
    const advanced = polled.advancedTo(pushed)

    assert.strictEqual(advanced.home.ranking, 5)
    assert.strictEqual(advanced.away.ranking, 12)
  })

  it("should keep its own kickoff and broadcasts", () => {
    const advanced = polled.advancedTo(pushed)

    assert.isTrue(DateTime.Equivalence(advanced.kickoff, polled.kickoff))
    assert.deepStrictEqual(advanced.broadcasts, polled.broadcasts)
  })

  it("should have no situation when the later snapshot has none", () => {
    const earlier = snapshot({ status: "live", period: 3, situation: situationPushed })

    const advanced = earlier.advancedTo(snapshot({ status: "final", period: 4 }))

    assert.isFalse("situation" in advanced)
  })

  it("should be at the later snapshot's game time", () => {
    const advanced = polled.advancedTo(pushed)

    assert.strictEqual(GameSnapshot.gameTime(advanced, pushed), 0)
  })
})

describe("GameSnapshot#isAheadOfOver", () => {
  const final = liveSnapshot({ status: "final", period: 4, clock: "0:00" })

  it("should not have play with 0:03 left ahead of the end of the game", () => {
    const lagging = snapshot({ ...final, status: "live", clock: "0:03" })

    assert.isFalse(lagging.isAheadOfOver(final))
  })

  it("should not have play at the end of the game ahead of it", () => {
    const lagging = snapshot({ ...final, status: "live" })

    assert.isFalse(lagging.isAheadOfOver(final))
  })

  it("should have overtime after a final ahead", () => {
    const overtime = snapshot({ ...final, status: "live", period: 5, clock: "15:00" })

    assert.isTrue(overtime.isAheadOfOver(final))
  })

  it("should have more points at the same clock ahead", () => {
    const moreScored = finalWithHomeScore(final, final.home.score + 1)

    assert.isTrue(moreScored.isAheadOfOver(final))
  })

  it("should not have as many points at the same clock ahead", () => {
    const equalScored = finalWithHomeScore(final, final.home.score)

    assert.isFalse(equalScored.isAheadOfOver(final))
  })

  it("should not have fewer points at the same clock ahead", () => {
    const fewerScored = finalWithHomeScore(final, final.home.score - 1)

    assert.isFalse(fewerScored.isAheadOfOver(final))
  })

  it("should have a postponed game resuming ahead once its clock runs", () => {
    const postponed = liveSnapshot({ status: "postponed", period: 2, clock: "8:00" })
    const resumed = snapshot({ ...postponed, status: "live", clock: "7:40" })

    assert.isTrue(resumed.isAheadOfOver(postponed))
  })

  it("should not have a postponed game resuming ahead before its clock runs", () => {
    const postponed = liveSnapshot({ status: "postponed", period: 2, clock: "8:00" })
    const resumed = snapshot({ ...postponed, status: "live" })

    assert.isFalse(resumed.isAheadOfOver(postponed))
  })
})

describe("GameSnapshot#eventsSince", () => {
  it("should report each side's points", () => {
    const before = inPlay()
    const after = inPlay({ home: { team: team("UGA"), score: 28 } })

    const events = after.eventsSince(before)

    assert.deepStrictEqual(
      events.map((e) => (e._tag === "ScoreChanged" ? { team: e.team, points: e.points } : e._tag)),
      [{ team: team("UGA").id, points: 7 }]
    )
  })

  it("should report a drive reaching the 40 as reaching scoring range", () => {
    assert.deepStrictEqual(tags(driveAt(55), driveAt(38)), ["ReachedScoringRange"])
  })

  it("should not report reaching scoring range again further down the field", () => {
    assert.deepStrictEqual(tags(driveAt(38), driveAt(30)), [])
  })

  it("should report a drive reaching the 20 as entering the red zone", () => {
    assert.deepStrictEqual(tags(driveAt(30), driveAt(18)), ["EnteredRedZone"])
  })

  it("should report a drive with the distance to the goal line as goal to go", () => {
    assert.deepStrictEqual(tags(driveAt(18), driveAt(6, 6)), ["GoalToGo"])
  })

  it("should report fourth down at a new spot", () => {
    const third = inPlay({ situation: ball("ALA", 34, 3, 3) })
    const fourth = inPlay({ situation: ball("ALA", 33, 4, 2) })

    assert.deepStrictEqual(tags(third, fourth), ["FourthDown"])
  })

  it("should report fourth down once per spot", () => {
    const fourth = inPlay({ situation: ball("ALA", 33, 4, 2) })

    assert.deepStrictEqual(tags(fourth, fourth), [])
  })

  it("should call a change of possession a turnover when the last play says interception", () => {
    const before = inPlay({ situation: ball("ALA", 45) })
    const picked = inPlay({ situation: ball("UGA", 70, 1, 10, { lastPlay: "Pass INTERCEPTED by K.Smith" }) })

    assert.deepStrictEqual(tags(before, picked), ["Turnover"])
  })

  it("should call a change of possession by a punt a possession change, not a turnover", () => {
    const before = inPlay({ situation: ball("ALA", 45) })
    const punted = inPlay({ situation: ball("UGA", 80, 1, 10, { lastPlay: "J.Doe punt 40 yards" }) })

    assert.deepStrictEqual(tags(before, punted), ["PossessionChanged"])
  })

  it("should call a change of possession with no clear last play a possession change, not a turnover", () => {
    const before = inPlay({ situation: ball("ALA", 45) })
    const unclear = inPlay({ situation: ball("UGA", 80) })

    assert.deepStrictEqual(tags(before, unclear), ["PossessionChanged"])
  })

  it("should not call the ball changing hands after a score a turnover", () => {
    const before = inPlay({ situation: ball("ALA", 3, 1, 3) })
    const after = inPlay({
      away: { team: team("ALA"), score: 24 },
      situation: ball("UGA", 75, 1, 10, { lastPlay: "Fumble recovered in the end zone, touchdown" })
    })

    assert.deepStrictEqual(tags(before, after), ["ScoreChanged", "PossessionChanged"])
  })

  it("should report a timeout from a drop in either side's count", () => {
    const before = inPlay({ situation: ball("ALA", 45) })
    const after = inPlay({ situation: ball("ALA", 45, 1, 10, { awayTimeouts: 2 }) })

    assert.deepStrictEqual(tags(before, after), ["TimeoutTaken"])
  })

  it("should report a timeout as one fewer in the same period", () => {
    assert.deepStrictEqual(tags(withTimeouts(4, 3, 3), withTimeouts(4, 3, 2)), ["TimeoutTaken"])
  })

  it("should not report a timeout when the counts drop by more than one", () => {
    assert.deepStrictEqual(tags(withTimeouts(4, 3, 3), withTimeouts(4, 0, 0)), [])
  })

  it("should not report a timeout when the period changes", () => {
    assert.deepStrictEqual(tags(withTimeouts(4, 3, 3), withTimeouts(5, 1, 1)), ["Overtime", "PeriodEnded"])
  })

  it("should report a new drive starting inside the 40 as reaching scoring range", () => {
    const before = inPlay({ situation: ball("ALA", 45) })
    const picked = inPlay({ situation: ball("UGA", 30, 1, 10, { lastPlay: "Pass INTERCEPTED by K.Smith" }) })

    assert.deepStrictEqual(tags(before, picked), ["Turnover", "ReachedScoringRange"])
  })

  it("should report the two-minute drill", () => {
    assert.deepStrictEqual(tags(inPlay({ clock: "2:05" }), inPlay({ clock: "1:58" })), ["TwoMinuteDrill"])
  })

  it("should report the end of a period", () => {
    const before = inPlay({ period: 1, clock: "0:00" })
    const after = inPlay({ period: 2, clock: "15:00" })

    assert.deepStrictEqual(tags(before, after), ["PeriodEnded"])
  })

  it("should report halftime", () => {
    const before = inPlay({ period: 2, clock: "0:00" })
    const after = inPlay({ period: 2, status: "halftime" })

    assert.deepStrictEqual(tags(before, after), ["WentToHalftime"])
  })

  it("should report overtime", () => {
    const before = inPlay({ clock: "0:00" })
    const after = inPlay({ period: 5, clock: "" })

    assert.deepStrictEqual(tags(before, after), ["Overtime", "PeriodEnded"])
  })

  it("should report the final", () => {
    assert.deepStrictEqual(tags(inPlay(), inPlay({ status: "final" })), ["WentFinal"])
  })
})

describe("GameSnapshot#secondsLeft", () => {
  it("should read the clock", () => {
    assert.strictEqual(inPlay({ clock: "2:10" }).secondsLeft(), 130)
  })

  it("should read an empty clock as none left", () => {
    assert.strictEqual(inPlay({ clock: "0:00" }).secondsLeft(), 0)
  })

  it("should read an unreadable clock as a full quarter", () => {
    assert.strictEqual(inPlay({ clock: "" }).secondsLeft(), 900)
  })
})

describe("GameSnapshot#quarterLeft", () => {
  it("should be the share of the quarter left on the clock", () => {
    assert.strictEqual(inPlay({ clock: "7:30" }).quarterLeft(), 0.5)
  })

  it("should be zero at 0:00", () => {
    assert.strictEqual(inPlay({ clock: "0:00" }).quarterLeft(), 0)
  })

  it("should read an unreadable clock as a full quarter", () => {
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
    "should put %s with %d to go at %d yards from the home goal, going %s",
    (side, toGo, yards, toward) => {
      const spot = game.spotOf({ team: game[side].team.id, yardsToEndzone: toGo })

      assert.deepStrictEqual(spot, Option.some(new BallSpot({ yards, toward })))
    }
  )

  it("should be none without a team", () => {
    assert.isTrue(Option.isNone(game.spotOf({ yardsToEndzone: 40 })))
  })

  it("should be none without a yard line", () => {
    assert.isTrue(Option.isNone(game.spotOf({ team: game.home.team.id })))
  })

  it("should be none for a team in neither side", () => {
    assert.isTrue(Option.isNone(game.spotOf({ team: team("X").id, yardsToEndzone: 40 })))
  })

  it.each([
    ["home", 105],
    ["home", -3],
    ["away", 105],
    ["away", -3]
  ] as const)("should be none for %s at %d yards to the goal, off the field", (side, yardsToEndzone) => {
    assert.isTrue(Option.isNone(game.spotOf({ team: game[side].team.id, yardsToEndzone })))
  })
})

describe("GameSnapshot#ball", () => {
  it("should be the spot of the team with the ball at its yard line", () => {
    const game = snapshot({ situation: situation({ yardLine: 75 }) })

    assert.deepStrictEqual(game.ball(), Option.some(new BallSpot({ yards: 25, toward: "away" })))
  })

  it("should be none without a situation", () => {
    assert.isTrue(Option.isNone(snapshot().ball()))
  })

  it("should be none without a team with the ball", () => {
    const game = snapshot({ situation: situation({ possession: undefined }) })

    assert.isTrue(Option.isNone(game.ball()))
  })
})

describe("GameSnapshot#inPlay", () => {
  it("should be in play when live with time on the clock", () => {
    const game = snapshot({ status: "live", period: 2, clock: "4:12" })

    assert.isTrue(game.inPlay())
  })

  it("should be in play in a college overtime at 0:00", () => {
    const game = snapshot({ status: "live", period: 5, clock: "0:00" })

    assert.isTrue(game.inPlay())
  })

  it("should not be in play at halftime", () => {
    const game = snapshot({ status: "halftime", period: 2, clock: "0:00" })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play in a delay", () => {
    const game = snapshot({ status: "delayed", period: 3, clock: "6:40" })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play between periods", () => {
    const game = snapshot({ status: "live", period: 1, clock: "0:00" })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play before kickoff", () => {
    const game = snapshot({ status: "scheduled" })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play after the final", () => {
    const game = snapshot({ status: "final", period: 4, clock: "0:00" })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play at 0:00 in an NFL overtime, which runs on a clock", () => {
    const game = snapshot({ league: "nfl", status: "live", period: 5, clock: "0:00" })

    assert.isFalse(game.inPlay())
  })

  it("should be in play with time on the clock in an NFL overtime", () => {
    const game = snapshot({ league: "nfl", status: "live", period: 5, clock: "3:20" })

    assert.isTrue(game.inPlay())
  })
})

function pairs(snapshots: ReadonlyArray<readonly [GameSnapshot, GameSnapshot]>) {
  return snapshots.map(([a, b]) => [`${a.statusLine()} against ${b.statusLine()}`, a, b] as const)
}

function withScores(home: number, away: number) {
  return snapshot({ home: { team: team("H"), score: home }, away: { team: team("A"), score: away } })
}

function at(overrides: Partial<GameSnapshot> = {}) {
  return liveSnapshot({ period: 2, clock: "5:00", ...overrides })
}

function scoredAt(home: number, away: number) {
  return at({ home: { team: team("HOME"), score: home }, away: { team: team("AWAY"), score: away } })
}

function gameAt(id: string, status: GameStatus, kickoff: string) {
  return snapshot({ id: GameId.make(id), status, kickoff: DateTime.makeUnsafe(kickoff) })
}

function finalWithHomeScore(final: GameSnapshot, home: number) {
  return snapshot({ ...final, home: { ...final.home, score: home } })
}

function inPlay(overrides: Partial<GameSnapshot> = {}) {
  return snapshot({
    status: "live",
    period: 4,
    clock: "5:00",
    home: { team: team("UGA"), score: 21 },
    away: { team: team("ALA"), score: 17 },
    ...overrides
  })
}

function ball(side: "UGA" | "ALA", yardLine: number, down = 1, distance = 10, rest: Partial<Situation> = {}) {
  return situation({ possession: team(side).id, yardLine, down, distance, ...rest })
}

function driveAt(yardLine: number, distance = 10) {
  return inPlay({ situation: ball("ALA", yardLine, 1, distance) })
}

function withTimeouts(period: number, home: number, away: number) {
  return inPlay({ period, situation: ball("ALA", 45, 1, 10, { homeTimeouts: home, awayTimeouts: away }) })
}

function tags(before: GameSnapshot, after: GameSnapshot) {
  return after.eventsSince(before).map((event) => event._tag)
}
