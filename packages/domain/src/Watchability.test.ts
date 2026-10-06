import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Option } from "effect"
import type { GameSnapshot } from "./Game.ts"
import { GameEvent } from "./GameEvent.ts"
import { Situation } from "./Situation.ts"
import { play, situation, snapshot, team } from "./TestGame.ts"
import { Watchability } from "./Watchability.ts"

const now = DateTime.makeUnsafe("2026-10-03T20:00:00Z")
const later = (seconds: number) => DateTime.addDuration(now, Duration.seconds(seconds))
const game = (overrides: Partial<GameSnapshot> = {}) =>
  snapshot({
    status: "live",
    period: 4,
    clock: "2:10",
    home: { team: team("UGA"), score: 24 },
    away: { team: team("ALA"), score: 24 },
    ...overrides
  })
const ball = (yardLine: number, down = 1, distance = 10, rest: Partial<Situation> = {}) =>
  situation({ possession: team("UGA").id, yardLine, down, distance, ...rest })
const score = (g: GameSnapshot) => Watchability.initial(g, now).score

describe("Watchability.initial", () => {
  it("scores a game that is not live 0", () => {
    assert.strictEqual(score(game({ status: "scheduled" })), 0)
    assert.strictEqual(score(game({ status: "final" })), 0)
  })

  it("scores a game delayed mid-game as live, in a lull", () => {
    const delayed = Watchability.initial(game({ status: "delayed" }), now)
    assert.isTrue(delayed.lull)
    assert.isAbove(delayed.score, 0)
    assert.strictEqual(delayed.reasons[0], "tied Q4, 2:10")
    assert.strictEqual(score(game({ status: "delayed", period: 0, clock: "" })), 0)
  })

  it("ranks late and close first", () => {
    assert.isAbove(score(game()), score(game({ period: 2, clock: "8:00" })))
    assert.isAbove(score(game()), score(game({ home: { team: team("UGA"), score: 45 } })))
    assert.isAbove(score(game({ period: 5, clock: "" })), score(game({ period: 4, clock: "12:00" })))
  })

  it("raises a one-score game as its drive nears the goal, and barely a blowout's", () => {
    const tied = (situation: Situation) => score(game({ situation }))
    assert.isAbove(tied(ball(38)), tied(ball(75)))
    assert.isAbove(tied(ball(15)), tied(ball(38)))
    assert.isAbove(tied(ball(4, 1, 4)), tied(ball(15)))
    const blowout = (situation: Situation) =>
      score(game({ home: { team: team("UGA"), score: 52 }, situation }))
    assert.isBelow(blowout(ball(4, 1, 4)) - blowout(ball(75)), tied(ball(4, 1, 4)) - tied(ball(75)))
  })

  it("puts late and close above field position: a tied fourth quarter at midfield beats a two-score third in the red zone", () => {
    const tiedLate = score(game({ situation: ball(50) }))
    const redZoneEarlier = score(
      game({ period: 3, clock: "9:00", home: { team: team("UGA"), score: 31 }, situation: ball(12) })
    )
    assert.isAbove(tiedLate, redZoneEarlier)
  })

  it("names an upset brewing", () => {
    const upset = Watchability.initial(
      game({
        clock: "6:00",
        home: { team: team("ALA"), score: 17, ranking: 3 },
        away: { team: team("VAN"), score: 24 }
      }),
      now
    )
    assert.include(upset.reasons.join(" | "), "upset brewing: VAN leads #3 ALA")
  })

  it("leads its reasons with the largest part", () => {
    assert.strictEqual(Watchability.initial(game(), now).reasons[0], "tied Q4, 2:10")
    assert.strictEqual(Watchability.initial(game({ period: 5, clock: "" }), now).reasons[0], "tied OT")
  })

  it("is in a lull at halftime, in a delay, at 0:00 between periods, and after a timeout called as the last play", () => {
    assert.isTrue(Watchability.initial(game({ period: 2, status: "halftime", clock: "0:00" }), now).lull)
    assert.isTrue(Watchability.initial(game({ status: "delayed" }), now).lull)
    assert.isTrue(Watchability.initial(game({ period: 1, clock: "0:00" }), now).lull)
    assert.isTrue(
      Watchability.initial(
        game({ clock: "8:00", situation: ball(60, 1, 10, { lastPlay: "Timeout Georgia" }) }),
        now
      ).lull
    )
    assert.isFalse(Watchability.initial(game({ situation: ball(60) }), now).lull)
  })

  it("is not in a lull at 0:00 in a college overtime, but is in an NFL one", () => {
    assert.isFalse(Watchability.initial(game({ period: 5, clock: "0:00", situation: ball(25) }), now).lull)
    assert.isTrue(
      Watchability.initial(game({ league: "nfl", period: 5, clock: "0:00", situation: ball(25) }), now).lull
    )
  })
})

describe("Watchability#next", () => {
  it("falls into a lull once neither the clock nor the last play has changed for 60 seconds", () => {
    const g = game({ clock: "8:00", situation: ball(60) })
    const first = Watchability.initial(g, now)
    assert.isFalse(first.next(g, g, g.eventsSince(g), later(59)).lull)
    assert.isTrue(first.next(g, g, g.eventsSince(g), later(60)).lull)
    const moved = game({ clock: "7:40", situation: ball(55) })
    assert.isFalse(
      first.next(g, g, g.eventsSince(g), later(60)).next(g, moved, moved.eventsSince(g), later(70)).lull
    )
  })

  it("takes a 90-second break after a score, ended early by a new last play", () => {
    const before = game({ clock: "8:00", situation: ball(3, 1, 3) })
    const scored = game({
      clock: "7:52",
      home: { team: team("UGA"), score: 31 },
      situation: ball(75, 1, 10, { lastPlay: "TD" })
    })
    const afterScore = Watchability.initial(before, now).next(
      before,
      scored,
      scored.eventsSince(before),
      later(10)
    )
    assert.isTrue(afterScore.lull)
    // The clock moves but no new play shows: the break holds until it runs out.
    const ticking = game({
      clock: "7:40",
      home: { team: team("UGA"), score: 31 },
      situation: ball(75, 1, 10, { lastPlay: "TD" })
    })
    assert.isTrue(afterScore.next(scored, ticking, ticking.eventsSince(scored), later(99)).lull)
    assert.isFalse(afterScore.next(scored, ticking, ticking.eventsSince(scored), later(101)).lull)
    const kickoff = game({
      clock: "7:52",
      home: { team: team("UGA"), score: 31 },
      situation: ball(75, 1, 10, { lastPlay: "Kickoff" })
    })
    assert.isFalse(afterScore.next(scored, kickoff, kickoff.eventsSince(scored), later(40)).lull)
  })

  it("keeps the break through the try after a touchdown", () => {
    const before = game({ clock: "8:00", situation: ball(3, 1, 3) })
    const touchdown = game({
      clock: "7:52",
      home: { team: team("UGA"), score: 30 },
      situation: ball(75, 1, 10, { lastPlay: "K. Bowen 3 Yd Run" })
    })
    const afterScore = Watchability.initial(before, now).next(
      before,
      touchdown,
      touchdown.eventsSince(before),
      later(10)
    )
    for (const lastPlay of ["(B. Baird KICK)", "(Two-Point Conversion failed)"]) {
      const tried = game({
        clock: "7:52",
        home: { team: team("UGA"), score: 30 },
        situation: ball(75, 1, 10, { lastPlay })
      })
      assert.isTrue(afterScore.next(touchdown, tried, tried.eventsSince(touchdown), later(30)).lull, lastPlay)
    }
  })

  it("takes a 90-second break at the end of a quarter and after a timeout shown as the last play", () => {
    const before = game({ period: 3, clock: "0:04", situation: ball(60, 2, 7) })
    const ended = game({
      period: 3,
      clock: "15:00",
      situation: ball(60, 2, 7, { lastPlay: "End of 3rd quarter" })
    })
    const quarterBreak = Watchability.initial(before, now).next(
      before,
      ended,
      ended.eventsSince(before),
      later(10)
    )
    assert.isTrue(quarterBreak.lull)
    // The next quarter's clock runs before a new play shows: the break holds until it runs out.
    const ticking = game({
      period: 4,
      clock: "14:52",
      situation: ball(60, 2, 7, { lastPlay: "End of 3rd quarter" })
    })
    assert.isTrue(quarterBreak.next(ended, ticking, ticking.eventsSince(ended), later(99)).lull)
    assert.isFalse(quarterBreak.next(ended, ticking, ticking.eventsSince(ended), later(101)).lull)

    const playing = game({ clock: "8:00", situation: ball(60, 2, 7, { lastPlay: "Pass complete" }) })
    const called = game({
      clock: "7:51",
      situation: ball(60, 3, 2, { lastPlay: "Timeout Georgia, clock 07:51" })
    })
    assert.isTrue(
      Watchability.initial(playing, now).next(playing, called, called.eventsSince(playing), later(10)).lull
    )

    const late = game({ clock: "1:30", situation: ball(30, 2, 7, { lastPlay: "Pass complete" }) })
    const lateTimeout = game({
      clock: "1:24",
      situation: ball(30, 3, 2, { lastPlay: "Timeout Georgia, clock 01:24" })
    })
    assert.isFalse(
      Watchability.initial(late, now).next(late, lateTimeout, lateTimeout.eventsSince(late), later(10)).lull
    )
  })

  it("takes no break for a timeout in the two-minute drill", () => {
    const before = game({ clock: "1:30", situation: ball(30) })
    const timeout = game({ clock: "1:24", situation: ball(26, 2, 6, { homeTimeouts: 2 }) })
    assert.isFalse(
      Watchability.initial(before, now).next(before, timeout, timeout.eventsSince(before), later(10)).lull
    )
  })

  it("boosts a game for a minute after a turnover, without a break", () => {
    const before = game({
      clock: "9:00",
      situation: new Situation({ ...ball(45), possession: team("ALA").id })
    })
    const picked = game({ clock: "8:51", situation: ball(70, 1, 10, { lastPlay: "INTERCEPTED" }) })
    const first = Watchability.initial(before, now)
    const turned = first.next(before, picked, picked.eventsSince(before), later(10))
    assert.isFalse(turned.lull)
    assert.isAbove(turned.score, Watchability.initial(picked, now).score)
    assert.strictEqual(
      turned.next(picked, picked, picked.eventsSince(picked), later(71)).score,
      Watchability.initial(picked, now).score
    )
  })
})

describe("Watchability#next with a played event", () => {
  it("moves activeAt for a Played event though the snapshot is unchanged", () => {
    const g = game({ clock: "8:00", situation: ball(60) })
    const first = Watchability.initial(g, now)
    const quiet = first.next(g, g, [], later(50))
    assert.deepStrictEqual(quiet.activeAt, now)
    const shown = first.next(g, g, [GameEvent.Played({ play: play() })], later(50))
    assert.deepStrictEqual(shown.activeAt, later(50))
    assert.isFalse(shown.at(g, later(100)).lull)
  })
})

describe("Watchability#at", () => {
  const g = game({ clock: "8:00", situation: ball(60) })
  const scoredGame = game({
    clock: "7:52",
    home: { team: team("UGA"), score: 31 },
    situation: ball(75, 1, 10, { lastPlay: "TD" })
  })
  const broken = Watchability.initial(g, now).next(g, scoredGame, scoredGame.eventsSince(g), later(10))

  it("ends a break's lull once breakUntil has passed, and not before", () => {
    // Play shows (a Played event) at 95 s, so only the break is left to end.
    const shown = broken.next(scoredGame, scoredGame, [GameEvent.Played({ play: play() })], later(95))
    assert.isTrue(shown.at(scoredGame, later(99)).lull)
    assert.isFalse(shown.at(scoredGame, later(101)).lull)
  })

  it("is a lull 60 s after the last activity", () => {
    const first = Watchability.initial(g, now)
    assert.isFalse(first.at(g, later(59)).lull)
    assert.isTrue(first.at(g, later(60)).lull)
  })

  it("drops the boost once it has run out", () => {
    assert.isAbove(broken.boostUntil === undefined ? 0 : 1, 0)
    assert.isUndefined(broken.at(scoredGame, later(71)).boostUntil)
  })
})

describe("Watchability#wakeAt", () => {
  const g = game({ clock: "8:00", situation: ball(60) })
  const scoredGame = game({
    clock: "7:52",
    home: { team: team("UGA"), score: 31 },
    situation: ball(75, 1, 10, { lastPlay: "TD" })
  })

  it("gives the earliest of the break's end, the boost's end, and play counting as stopped", () => {
    const broken = Watchability.initial(g, now).next(g, scoredGame, scoredGame.eventsSince(g), later(10))
    // boost to 70 s, break to 100 s, stopped at 10 + 60 = 70 s
    assert.deepStrictEqual(broken.wakeAt(later(10)), Option.some(later(70)))
    assert.deepStrictEqual(broken.wakeAt(later(70)), Option.some(later(100)))
  })

  it("leaves out an instant already past, and is none for a game in no timed state", () => {
    const first = Watchability.initial(g, now)
    assert.deepStrictEqual(first.wakeAt(later(0)), Option.some(later(60)))
    assert.deepStrictEqual(first.wakeAt(later(60)), Option.none())
    assert.deepStrictEqual(
      Watchability.initial(game({ status: "final" }), now).wakeAt(later(60)),
      Option.none()
    )
  })
})
