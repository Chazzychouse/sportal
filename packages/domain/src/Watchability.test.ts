import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration } from "effect"
import type { GameSnapshot } from "./Game.ts"
import { Situation } from "./Situation.ts"
import { snapshot, team } from "./TestGame.ts"
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
  new Situation({
    possession: team("UGA").id,
    yardLine,
    down,
    distance,
    isRedZone: yardLine <= 20,
    homeTimeouts: 3,
    awayTimeouts: 3,
    ...rest
  })
const score = (g: GameSnapshot) => Watchability.initial(g, now).score

describe("Watchability.initial", () => {
  it("scores a game that is not live 0", () => {
    assert.strictEqual(score(game({ status: "scheduled" })), 0)
    assert.strictEqual(score(game({ status: "final" })), 0)
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
})

describe("Watchability#next", () => {
  it("falls into a lull once neither the clock nor the last play has changed for 60 seconds", () => {
    const g = game({ clock: "8:00", situation: ball(60) })
    const first = Watchability.initial(g, now)
    assert.isFalse(first.next(g, g, later(59)).lull)
    assert.isTrue(first.next(g, g, later(60)).lull)
    const moved = game({ clock: "7:40", situation: ball(55) })
    assert.isFalse(first.next(g, g, later(60)).next(g, moved, later(70)).lull)
  })

  it("takes a 90-second break after a score, ended early by a new last play", () => {
    const before = game({ clock: "8:00", situation: ball(3, 1, 3) })
    const scored = game({
      clock: "7:52",
      home: { team: team("UGA"), score: 31 },
      situation: ball(75, 1, 10, { lastPlay: "TD" })
    })
    const afterScore = Watchability.initial(before, now).next(before, scored, later(10))
    assert.isTrue(afterScore.lull)
    // The clock moves but no new play shows: the break holds until it runs out.
    const ticking = game({
      clock: "7:40",
      home: { team: team("UGA"), score: 31 },
      situation: ball(75, 1, 10, { lastPlay: "TD" })
    })
    assert.isTrue(afterScore.next(scored, ticking, later(99)).lull)
    assert.isFalse(afterScore.next(scored, ticking, later(101)).lull)
    const kickoff = game({
      clock: "7:52",
      home: { team: team("UGA"), score: 31 },
      situation: ball(75, 1, 10, { lastPlay: "Kickoff" })
    })
    assert.isFalse(afterScore.next(scored, kickoff, later(40)).lull)
  })

  it("takes no break for a timeout in the two-minute drill", () => {
    const before = game({ clock: "1:30", situation: ball(30) })
    const timeout = game({ clock: "1:24", situation: ball(26, 2, 6, { homeTimeouts: 2 }) })
    assert.isFalse(Watchability.initial(before, now).next(before, timeout, later(10)).lull)
  })

  it("boosts a game for a minute after a turnover, without a break", () => {
    const before = game({
      clock: "9:00",
      situation: new Situation({ ...ball(45), possession: team("ALA").id })
    })
    const picked = game({ clock: "8:51", situation: ball(70, 1, 10, { lastPlay: "INTERCEPTED" }) })
    const first = Watchability.initial(before, now)
    const turned = first.next(before, picked, later(10))
    assert.isFalse(turned.lull)
    assert.isAbove(turned.score, Watchability.initial(picked, now).score)
    assert.strictEqual(turned.next(picked, picked, later(71)).score, Watchability.initial(picked, now).score)
  })
})
