import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Option } from "effect"
import { BallSpot, Game, GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import { PlayId } from "./Play.ts"
import { Situation } from "./Situation.ts"
import { broadcast, liveSnapshot, play, situation, snapshot, team } from "./TestGame.ts"

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

describe("GameSnapshot#isLiveOrKicksOffWithin", () => {
  const window = Duration.minutes(30)
  const now = DateTime.makeUnsafe("2026-10-03T15:30:00Z")

  it("should be true for a live game", () => {
    const game = liveSnapshot({ kickoff: DateTime.makeUnsafe("2026-10-03T12:00:00Z") })

    assert.isTrue(game.isLiveOrKicksOffWithin(window, now))
  })

  it("should be true for an upcoming game kicking off within the window", () => {
    const game = snapshot({ kickoff: DateTime.makeUnsafe("2026-10-03T16:00:00Z") })

    assert.isTrue(game.isLiveOrKicksOffWithin(window, now))
  })

  it("should be false for an upcoming game kicking off after the window", () => {
    const game = snapshot({ kickoff: DateTime.makeUnsafe("2026-10-03T16:00:01Z") })

    assert.isFalse(game.isLiveOrKicksOffWithin(window, now))
  })

  it("should be false for a game that is over", () => {
    const game = snapshot({
      status: "final",
      period: 4,
      kickoff: DateTime.makeUnsafe("2026-10-03T15:45:00Z")
    })

    assert.isFalse(game.isLiveOrKicksOffWithin(window, now))
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

    const ahead = later.isAheadOf(at())

    assert.isTrue(ahead)
  })

  it("should be ahead in the same period with less on the clock", () => {
    const later = at({ clock: "4:59" })

    const ahead = later.isAheadOf(at())

    assert.isTrue(ahead)
  })

  it("should be ahead at the same game time with more points", () => {
    const ahead = scoredAt(7, 0).isAheadOf(scoredAt(6, 0))

    assert.isTrue(ahead)
  })

  it("should not be ahead at the same game time with fewer points", () => {
    const ahead = scoredAt(6, 0).isAheadOf(scoredAt(7, 0))

    assert.isFalse(ahead)
  })

  it("should be ahead at the same game time with equal points split differently", () => {
    const ahead = scoredAt(7, 3).isAheadOf(scoredAt(3, 7))

    assert.isTrue(ahead)
  })

  it("should have halftime ahead of play at the end of the second period", () => {
    const halftime = at({ status: "halftime", clock: "0:00" })

    const ahead = halftime.isAheadOf(at({ clock: "0:00" }))

    assert.isTrue(ahead)
  })

  it("should not have play at the end of the second period ahead of halftime", () => {
    const halftime = at({ status: "halftime", clock: "0:00" })

    const ahead = at({ clock: "0:00" }).isAheadOf(halftime)

    assert.isFalse(ahead)
  })

  it("should have a final ahead of play at the end of the last period", () => {
    const final = at({ status: "final", period: 4, clock: "0:00" })
    const endOfGame = at({ period: 4, clock: "0:00" })

    const ahead = final.isAheadOf(endOfGame)

    assert.isTrue(ahead)
  })

  it("should not have play at the end of the last period ahead of the final", () => {
    const final = at({ status: "final", period: 4, clock: "0:00" })
    const endOfGame = at({ period: 4, clock: "0:00" })

    const ahead = endOfGame.isAheadOf(final)

    assert.isFalse(ahead)
  })

  it("should not have a delay ahead of play at the same clock and points", () => {
    const delayed = at({ status: "delayed" })

    const ahead = delayed.isAheadOf(at())

    assert.isFalse(ahead)
  })

  it("should not have play ahead of a delay at the same clock and points", () => {
    const delayed = at({ status: "delayed" })

    const ahead = at().isAheadOf(delayed)

    assert.isFalse(ahead)
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
    const ahead = at().isAheadOf(at())

    assert.isFalse(ahead)
  })

  it("should not be ahead at an earlier game time whatever its points", () => {
    const ahead = scoredAt(14, 0).isAheadOf(at({ period: 3 }))

    assert.isFalse(ahead)
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
  const pushed = {
    status: "live",
    period: 3,
    clock: "7:45",
    homeScore: 14,
    awayScore: 10,
    situation: situationPushed
  } as const

  it("should take the moved status, period, clock, scores, and situation", () => {
    const advanced = polled.advancedTo(pushed)

    assert.strictEqual(advanced.status, "live")
    assert.strictEqual(advanced.period, 3)
    assert.strictEqual(advanced.clock, "7:45")
    assert.strictEqual(advanced.home.score, 14)
    assert.strictEqual(advanced.away.score, 10)
    assert.deepStrictEqual(advanced.situation, situationPushed)
  })

  it("should keep its own teams, rankings, kickoff, and broadcasts", () => {
    const advanced = polled.advancedTo(pushed)

    assert.strictEqual(advanced.home.team.shortName, "Home")
    assert.strictEqual(advanced.away.team.shortName, "Away")
    assert.strictEqual(advanced.home.ranking, 5)
    assert.strictEqual(advanced.away.ranking, 12)
    assert.isTrue(DateTime.Equivalence(advanced.kickoff, polled.kickoff))
    assert.deepStrictEqual(advanced.broadcasts, polled.broadcasts)
  })

  it("should have no situation when the moved fields have none", () => {
    const earlier = snapshot({ status: "live", period: 3, situation: situationPushed })

    const advanced = earlier.advancedTo({
      status: "final",
      period: 4,
      clock: "0:00",
      homeScore: 0,
      awayScore: 0
    })

    assert.isFalse("situation" in advanced)
  })

  it("should be at the moved fields' game time", () => {
    const advanced = polled.advancedTo(pushed)

    assert.strictEqual(
      GameSnapshot.gameTime(advanced, snapshot({ status: "live", period: 3, clock: "7:45" })),
      0
    )
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
  return snapshots.map(([a, b]) => [`${line(a)} against ${line(b)}`, a, b] as const)
}

/** The status, period, and clock of `game`, to name a case. */
function line(game: GameSnapshot) {
  return `${game.status}, period ${game.period}, ${game.clock}`
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

function _driveAt(yardLine: number, distance = 10) {
  return inPlay({ situation: ball("ALA", yardLine, 1, distance) })
}

function _withTimeouts(period: number, home: number, away: number) {
  return inPlay({ period, situation: ball("ALA", 45, 1, 10, { homeTimeouts: home, awayTimeouts: away }) })
}

describe("GameSnapshot#isBehind", () => {
  it("should be behind a snapshot later in game time", () => {
    const had = liveSnapshot({ clock: "9:00" })

    const behind = liveSnapshot({ clock: "10:00" }).isBehind(had)

    assert.isTrue(behind)
  })

  it("should not be behind a snapshot at the same game time and score", () => {
    const had = liveSnapshot()

    const behind = liveSnapshot().isBehind(had)

    assert.isFalse(behind)
  })

  it("should not be behind a final when it is ahead of its end", () => {
    const had = snapshot({ status: "final", period: 4, clock: "0:00" })

    const behind = liveSnapshot({ period: 5, clock: "15:00" }).isBehind(had)

    assert.isFalse(behind)
  })
})

describe("GameSnapshot#tiesLive", () => {
  it("should tie a live snapshot at the same game time", () => {
    const had = liveSnapshot({ situation: situation({ yardLine: 45 }) })

    const ties = liveSnapshot({ situation: situation({ yardLine: 60 }) }).tiesLive(had)

    assert.isTrue(ties)
  })

  it("should not tie an upcoming snapshot", () => {
    const had = snapshot()

    const ties = snapshot({ broadcasts: [broadcast("ESPN")] }).tiesLive(had)

    assert.isFalse(ties)
  })
})

describe("Game#recent", () => {
  it("should keep only the last ten plays", () => {
    const plays = Array.from({ length: 12 }, (_, index) =>
      play({ id: PlayId.make(`p${index + 1}`), sequence: index + 1 })
    )
    const game = new Game({ snapshot: liveSnapshot(), plays })

    const recent = game.recent()

    assert.deepStrictEqual(
      recent.plays.map(({ sequence }) => sequence),
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    )
  })

  it("should give back the game itself with ten plays or fewer", () => {
    const game = new Game({ snapshot: liveSnapshot(), plays: [play()] })

    const recent = game.recent()

    assert.strictEqual(recent, game)
  })
})

describe("Game#playsAfter", () => {
  it("should give the plays the earlier game lacks, in order", () => {
    const first = play({ id: PlayId.make("1"), sequence: 1 })
    const second = play({ id: PlayId.make("2"), sequence: 2 })
    const third = play({ id: PlayId.make("3"), sequence: 3 })
    const earlier = Game.of(snapshot()).playsTaken([first])
    const later = earlier.playsTaken([third, first, second])

    const added = later.playsAfter(earlier)

    assert.deepStrictEqual(
      added.map(({ id }) => id),
      [second.id, third.id]
    )
  })

  it("should not give a play the earlier game had, though the feed corrected its text", () => {
    const first = play({ id: PlayId.make("1"), sequence: 1, text: "Rush for 1 yard" })
    const corrected = play({ id: PlayId.make("1"), sequence: 1, text: "Rush for 2 yards" })
    const earlier = Game.of(snapshot()).playsTaken([first])
    const later = earlier.playsTaken([corrected])

    const added = later.playsAfter(earlier)

    assert.deepStrictEqual(added, [])
  })
})
