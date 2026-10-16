import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Option } from "effect"
import { Game, GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import { PlayId } from "./Play.ts"
import type { FootballSituation } from "./Situation.ts"
import { baseballSituation, broadcast, liveSnapshot, play, situation, snapshot, team } from "./TestGame.ts"

describe("GameSnapshot#progress", () => {
  it.each([
    ["scheduled", "upcoming"],
    ["delayed", "upcoming"],
    ["live", "live"],
    ["break", "live"],
    ["final", "over"],
    ["postponed", "over"],
    ["canceled", "over"]
  ] as const)("should read a %s game as %s", (status, progress) => {
    const game = snapshot({ status })

    assert.strictEqual(game.progress(), progress)
  })

  it("should read a delay before the start as upcoming", () => {
    const game = snapshot({ status: "delayed", period: 0 })

    assert.strictEqual(game.progress(), "upcoming")
  })

  it("should read a delay during the game as live", () => {
    const game = snapshot({ status: "delayed", period: 2 })

    assert.strictEqual(game.progress(), "live")
  })
})

describe("GameSnapshot#isLiveOrStartsWithin", () => {
  const window = Duration.minutes(30)
  const now = DateTime.makeUnsafe("2026-10-03T15:30:00Z")

  it("should be true for a live game", () => {
    const game = liveSnapshot({ startsAt: DateTime.makeUnsafe("2026-10-03T12:00:00Z") })

    assert.isTrue(game.isLiveOrStartsWithin(window, now))
  })

  it("should be true for an upcoming game starting within the window", () => {
    const game = snapshot({ startsAt: DateTime.makeUnsafe("2026-10-03T16:00:00Z") })

    assert.isTrue(game.isLiveOrStartsWithin(window, now))
  })

  it("should be false for an upcoming game starting after the window", () => {
    const game = snapshot({ startsAt: DateTime.makeUnsafe("2026-10-03T16:00:01Z") })

    assert.isFalse(game.isLiveOrStartsWithin(window, now))
  })

  it("should be false for a game that is over", () => {
    const game = snapshot({
      status: "final",
      period: 4,
      startsAt: DateTime.makeUnsafe("2026-10-03T15:45:00Z")
    })

    assert.isFalse(game.isLiveOrStartsWithin(window, now))
  })
})

describe("GameSnapshot#scored", () => {
  it.each([
    ["scheduled", 0, false],
    ["live", 2, true],
    ["break", 2, true],
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

describe("GameSnapshot#matchup", () => {
  it("should name the away team at the home team", () => {
    const game = snapshot({ away: { team: team("UGA"), score: 0 }, home: { team: team("BAMA"), score: 0 } })

    assert.strictEqual(game.matchup(), "UGA at BAMA")
  })
})

describe("GameSnapshot#scoreline", () => {
  it("should read the away side first, the abbreviations around the scores", () => {
    const game = liveSnapshot({
      away: { ...snapshot().away, score: 21 },
      home: { ...snapshot().home, score: 14 }
    })

    const line = game.scoreline()

    assert.strictEqual(line, "AWAY 21–14 HOME")
  })

  it("should show no score before the start", () => {
    const line = snapshot().scoreline()

    assert.strictEqual(line, "AWAY @ HOME")
  })
})

describe("GameSnapshot.watchOrder", () => {
  it("should put live games first, then upcoming by start, then finished", () => {
    const games = [
      gameAt("final", "final", "2026-10-03T16:00:00Z"),
      gameAt("late", "scheduled", "2026-10-03T23:30:00Z"),
      gameAt("halftime", "break", "2026-10-03T19:30:00Z"),
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

describe("GameSnapshot#inPlay", () => {
  it("should be in play when live with time on the clock", () => {
    const game = snapshot({ status: "live", period: 2, clock: 252 })

    assert.isTrue(game.inPlay())
  })

  it("should be in play when live with no clock", () => {
    const game = liveSnapshot({ clock: undefined })

    assert.isTrue(game.inPlay())
  })

  it("should not be in play when live at 0:00", () => {
    const game = liveSnapshot({ clock: 0 })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play at halftime", () => {
    const game = snapshot({ status: "break", period: 2, clock: 0 })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play in a delay", () => {
    const game = snapshot({ status: "delayed", period: 3, clock: 400 })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play at 0:00 in a college fourth period, which runs on a clock", () => {
    const game = snapshot({ league: "fbs", status: "live", period: 4, clock: 0 })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play between periods", () => {
    const game = snapshot({ status: "live", period: 1, clock: 0 })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play before the start", () => {
    const game = snapshot({ status: "scheduled" })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play after the final", () => {
    const game = snapshot({ status: "final", period: 4, clock: 0 })

    assert.isFalse(game.inPlay())
  })

  it("should not be in play at 0:00 in an NFL overtime, which runs on a clock", () => {
    const game = snapshot({ league: "nfl", status: "live", period: 5, clock: 0 })

    assert.isFalse(game.inPlay())
  })

  it("should be in play with time on the clock in an NFL overtime", () => {
    const game = snapshot({ league: "nfl", status: "live", period: 5, clock: 200 })

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

function at(overrides: Partial<GameSnapshot> = {}) {
  return liveSnapshot({ period: 2, clock: 300, ...overrides })
}

function scoredAt(home: number, away: number) {
  return at({ home: { team: team("HOME"), score: home }, away: { team: team("AWAY"), score: away } })
}

function gameAt(id: string, status: GameStatus, startsAt: string) {
  return snapshot({ id: GameId.make(id), status, startsAt: DateTime.makeUnsafe(startsAt) })
}

function finalWithHomeScore(final: GameSnapshot, home: number) {
  return snapshot({ ...final, home: { ...final.home, score: home } })
}

function inPlay(overrides: Partial<GameSnapshot> = {}) {
  return snapshot({
    status: "live",
    period: 4,
    clock: 300,
    home: { team: team("UGA"), score: 21 },
    away: { team: team("ALA"), score: 17 },
    ...overrides
  })
}

function ball(
  side: "UGA" | "ALA",
  yardLine: number,
  down = 1,
  distance = 10,
  rest: Partial<FootballSituation> = {}
) {
  return situation({ possession: team(side).id, yardLine, down, distance, ...rest })
}

function _driveAt(yardLine: number, distance = 10) {
  return inPlay({ situation: ball("ALA", yardLine, 1, distance) })
}

function _withTimeouts(period: number, home: number, away: number) {
  return inPlay({ period, situation: ball("ALA", 45, 1, 10, { homeTimeouts: home, awayTimeouts: away }) })
}

describe("GameSnapshot#isBehind", () => {
  it("should be behind a live snapshot when upcoming", () => {
    const upcoming = snapshot({ status: "scheduled" })
    const live = snapshot({ status: "live", period: 1, clock: 600 })

    assert.isTrue(upcoming.isBehind(live))
  })

  it("should be behind an over snapshot when live", () => {
    const live = snapshot({ status: "live", period: 1, clock: 600 })
    const over = snapshot({ status: "final", period: 4, clock: 0 })

    assert.isTrue(live.isBehind(over))
  })

  it("should be behind an over snapshot when upcoming", () => {
    const upcoming = snapshot({ status: "scheduled" })
    const over = snapshot({ status: "final", period: 4, clock: 0 })

    assert.isTrue(upcoming.isBehind(over))
  })

  it("should be behind a later period whatever the clock", () => {
    const later = snapshot({ status: "live", period: 2, clock: 840 })
    const earlier = snapshot({ status: "live", period: 1, clock: 30 })

    assert.isTrue(earlier.isBehind(later))
  })

  it("should be behind a snapshot with less time left in the period", () => {
    const later = snapshot({ status: "live", period: 3, clock: 120 })
    const earlier = snapshot({ status: "live", period: 3, clock: 540 })

    assert.isTrue(earlier.isBehind(later))
  })

  it("should not be behind a snapshot with more time left in the period", () => {
    const later = snapshot({ status: "live", period: 3, clock: 120 })
    const earlier = snapshot({ status: "live", period: 3, clock: 540 })

    assert.isFalse(later.isBehind(earlier))
  })

  it("should be behind a snapshot later in the period whatever its own points", () => {
    const scored = snapshot({
      status: "live",
      period: 2,
      clock: 300,
      home: { team: team("HOME"), score: 7 }
    })
    const level = snapshot({ status: "live", period: 2, clock: 299 })

    assert.isTrue(scored.isBehind(level))
  })

  it("should be behind a later period whatever its own points", () => {
    const behind = scoredAt(14, 0).isBehind(at({ period: 3 }))

    assert.isTrue(behind)
  })

  it("should be behind halftime at the end of period 2", () => {
    const halftime = snapshot({ status: "break", period: 2, clock: 0 })
    const endOfHalf = snapshot({ status: "live", period: 2, clock: 0 })

    assert.isTrue(endOfHalf.isBehind(halftime))
  })

  it("should not have halftime behind the end of period 2", () => {
    const halftime = snapshot({ status: "break", period: 2, clock: 0 })
    const endOfHalf = snapshot({ status: "live", period: 2, clock: 0 })

    assert.isFalse(halftime.isBehind(endOfHalf))
  })

  it("should be behind halftime with time left in period 2", () => {
    const halftime = snapshot({ status: "break", period: 2, clock: 0 })
    const playing = snapshot({ status: "live", period: 2, clock: 10 })

    assert.isTrue(playing.isBehind(halftime))
  })

  it("should have halftime behind the start of period 3", () => {
    const halftime = snapshot({ status: "break", period: 2, clock: 0 })
    const secondHalf = snapshot({ status: "live", period: 3, clock: 900 })

    assert.isTrue(halftime.isBehind(secondHalf))
  })

  it("should not have a delay behind play at the same clock and points", () => {
    const delayed = snapshot({ status: "delayed", period: 3, clock: 480 })
    const playing = snapshot({ status: "live", period: 3, clock: 480 })

    assert.isFalse(delayed.isBehind(playing))
  })

  it("should not have play behind a delay at the same clock and points", () => {
    const delayed = at({ status: "delayed" })

    const behind = at().isBehind(delayed)

    assert.isFalse(behind)
  })

  it("should read a delay during the game as live", () => {
    const delayed = snapshot({ status: "delayed", period: 2, clock: 300 })
    const earlierPlay = snapshot({ status: "live", period: 1, clock: 60 })

    assert.isTrue(earlierPlay.isBehind(delayed))
  })

  it("should read a delay before the start as upcoming", () => {
    const delayed = snapshot({ status: "delayed", period: 0 })
    const live = snapshot({ status: "live", period: 1 })

    assert.isTrue(delayed.isBehind(live))
  })

  it("should be behind a snapshot later in game time", () => {
    const had = liveSnapshot({ clock: 540 })

    const behind = liveSnapshot({ clock: 600 }).isBehind(had)

    assert.isTrue(behind)
  })

  it("should be behind a later period at its start", () => {
    const behind = at().isBehind(at({ period: 3, clock: 900 }))

    assert.isTrue(behind)
  })

  it("should be behind the same game time with more points", () => {
    const behind = scoredAt(6, 0).isBehind(scoredAt(7, 0))

    assert.isTrue(behind)
  })

  it("should not be behind the same game time with fewer points", () => {
    const behind = scoredAt(7, 0).isBehind(scoredAt(6, 0))

    assert.isFalse(behind)
  })

  it("should not be behind the same game time with as many points split differently", () => {
    const behind = scoredAt(3, 7).isBehind(scoredAt(7, 3))

    assert.isFalse(behind)
  })

  it("should not be behind a snapshot at the same game time and score", () => {
    const had = liveSnapshot()

    const behind = liveSnapshot().isBehind(had)

    assert.isFalse(behind)
  })

  it.each(
    pairs([
      [at({ status: "break", clock: 0 }), at({ clock: 0 })],
      [at({ status: "delayed" }), at()],
      [at({ status: "delayed", clock: 0 }), at({ status: "break", clock: 0 })],
      [at({ status: "final", period: 4, clock: 0 }), at({ period: 4, clock: 0 })],
      [at({ status: "final", period: 4, clock: 0 }), at({ status: "canceled", period: 4, clock: 0 })],
      [at({ status: "postponed" }), at()],
      [snapshot({ status: "scheduled" }), snapshot({ status: "delayed", period: 0 })],
      [scoredAt(7, 0), scoredAt(6, 0)],
      [at({ clock: 299 }), at()],
      [at(), at()]
    ])
  )("should never be behind both ways, %s", (_name, a, b) => {
    assert.isFalse(a.isBehind(b) && b.isBehind(a))
  })

  describe("a game that is over", () => {
    const final = liveSnapshot({ status: "final", period: 4, clock: 0 })

    it("should have play with 0:03 left behind the final", () => {
      const lagging = snapshot({ ...final, status: "live", clock: 3 })

      assert.isTrue(lagging.isBehind(final))
    })

    it("should have play at the end of the game behind the final", () => {
      const lagging = snapshot({ ...final, status: "live" })

      assert.isTrue(lagging.isBehind(final))
    })

    it("should not have the final behind play at the end of the game", () => {
      const endOfGame = snapshot({ ...final, status: "live" })

      assert.isFalse(final.isBehind(endOfGame))
    })

    it("should not have overtime after a final behind it", () => {
      const had = snapshot({ status: "final", period: 4, clock: 0 })

      const behind = liveSnapshot({ period: 5, clock: 900 }).isBehind(had)

      assert.isFalse(behind)
    })

    it("should not have more points at the same clock behind it", () => {
      const moreScored = finalWithHomeScore(final, final.home.score + 1)

      assert.isFalse(moreScored.isBehind(final))
    })

    it("should not have as many points at the same clock behind it", () => {
      const equalScored = finalWithHomeScore(final, final.home.score)

      assert.isFalse(equalScored.isBehind(final))
    })

    it("should have fewer points at the same clock behind it", () => {
      const fewerScored = finalWithHomeScore(final, final.home.score - 1)

      assert.isTrue(fewerScored.isBehind(final))
    })

    it("should not have a postponed game resuming behind it once its clock runs", () => {
      const postponed = liveSnapshot({ status: "postponed", period: 2, clock: 480 })
      const resumed = snapshot({ ...postponed, status: "live", clock: 460 })

      assert.isFalse(resumed.isBehind(postponed))
    })

    it("should have a postponed game resuming behind it before its clock runs", () => {
      const postponed = liveSnapshot({ status: "postponed", period: 2, clock: 480 })
      const resumed = snapshot({ ...postponed, status: "live" })

      assert.isTrue(resumed.isBehind(postponed))
    })
  })
})

describe("GameSnapshot#isBehind in baseball", () => {
  it("should hold of a snapshot in the top of an inning against its bottom", () => {
    const top = liveSnapshot({
      league: "mlb",
      period: 7,
      clock: undefined,
      situation: baseballSituation({ half: "top" })
    })
    const bottom = liveSnapshot({
      league: "mlb",
      period: 7,
      clock: undefined,
      situation: baseballSituation({ half: "bottom" })
    })

    assert.isTrue(top.isBehind(bottom))
  })
})

describe("Game#playsPage", () => {
  it("should give the latest plays newest first", () => {
    const game = withPlays(1, 2, 3)

    const page = game.playsPage(undefined, 2)

    assert.deepStrictEqual(
      page.plays.map(({ sequence }) => sequence),
      [3, 2]
    )
  })

  it("should say there are more when the page is short of them", () => {
    const game = withPlays(1, 2, 3)

    const page = game.playsPage(undefined, 2)

    assert.isTrue(page.more)
  })

  it("should give only the plays before a sequence", () => {
    const game = withPlays(1, 2, 3)

    const page = game.playsPage(3, 50)

    assert.deepStrictEqual(
      page.plays.map(({ sequence }) => sequence),
      [2, 1]
    )
  })
})

describe("Game#playsChange", () => {
  it("should be none when the plays are the same", () => {
    const game = withPlays(1, 2)

    const change = game.playsChange(withPlays(1, 2))

    assert.isTrue(Option.isNone(change))
  })

  it("should append the plays added at the end, newest first", () => {
    const game = withPlays(1, 2, 3, 4)

    const change = game.playsChange(withPlays(1, 2))

    assert.deepStrictEqual(
      Option.map(change, (each) => [each._tag, each.plays.map(({ sequence }) => sequence)]),
      Option.some(["Appended", [4, 3]])
    )
  })

  it("should reset when a play it had is gone", () => {
    const game = withPlays(1, 3)

    const change = game.playsChange(withPlays(1, 2, 3))

    assert.deepStrictEqual(
      Option.map(change, ({ _tag }) => _tag),
      Option.some("Reset")
    )
  })

  it("should reset when a play it had was revised", () => {
    const earlier = withPlays(1, 2)
    const revised = new Game({
      ...earlier,
      plays: [earlier.plays[0], play({ id: PlayId.make("2"), sequence: 2, text: "Revised" })].filter(
        (each) => each !== undefined
      )
    })

    const change = revised.playsChange(earlier)

    assert.deepStrictEqual(
      Option.map(change, ({ _tag }) => _tag),
      Option.some("Reset")
    )
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

function withPlays(...sequences: ReadonlyArray<number>): Game {
  const plays = sequences.map((sequence) => play({ id: PlayId.make(String(sequence)), sequence }))
  return new Game({ snapshot: liveSnapshot(), plays })
}
