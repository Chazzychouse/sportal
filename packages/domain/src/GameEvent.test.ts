import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "./Game.ts"
import { Situation } from "./Situation.ts"
import { snapshot, team } from "./TestGame.ts"

const live = (overrides: Partial<GameSnapshot> = {}) =>
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
) =>
  new Situation({
    possession: team(side).id,
    yardLine,
    down,
    distance,
    isRedZone: yardLine <= 20,
    homeTimeouts: 3,
    awayTimeouts: 3,
    ...rest
  })
const tags = (before: GameSnapshot, after: GameSnapshot) =>
  after.eventsSince(before).map((event) => event._tag)

describe("GameSnapshot#eventsSince", () => {
  it("reports each side's points", () => {
    const events = live({ home: { team: team("UGA"), score: 28 } }).eventsSince(live())
    assert.deepStrictEqual(
      events.map((e) => (e._tag === "ScoreChanged" ? { team: e.team, points: e.points } : e._tag)),
      [{ team: team("UGA").id, points: 7 }]
    )
  })

  it("reports a drive reaching the 40, then the red zone, then goal to go, once each", () => {
    const at = (yardLine: number, distance = 10) => live({ situation: ball("ALA", yardLine, 1, distance) })
    assert.deepStrictEqual(tags(at(55), at(38)), ["ReachedScoringRange"])
    assert.deepStrictEqual(tags(at(38), at(30)), [])
    assert.deepStrictEqual(tags(at(30), at(18)), ["EnteredRedZone"])
    assert.deepStrictEqual(tags(at(18), at(6, 6)), ["GoalToGo"])
  })

  it("reports fourth down once per spot", () => {
    const fourth = live({ situation: ball("ALA", 33, 4, 2) })
    assert.deepStrictEqual(tags(live({ situation: ball("ALA", 34, 3, 3) }), fourth), ["FourthDown"])
    assert.deepStrictEqual(tags(fourth, fourth), [])
  })

  it("calls a change of possession a turnover only when the last play says interception or fumble", () => {
    const before = live({ situation: ball("ALA", 45) })
    const picked = live({ situation: ball("UGA", 70, 1, 10, { lastPlay: "Pass INTERCEPTED by K.Smith" }) })
    const punted = live({ situation: ball("UGA", 80, 1, 10, { lastPlay: "J.Doe punt 40 yards" }) })
    const unclear = live({ situation: ball("UGA", 80) })
    assert.deepStrictEqual(tags(before, picked), ["Turnover"])
    assert.deepStrictEqual(tags(before, punted), ["PossessionChanged"])
    assert.deepStrictEqual(tags(before, unclear), ["PossessionChanged"])
  })

  it("does not call the ball changing hands after a score a turnover", () => {
    const before = live({ situation: ball("ALA", 3, 1, 3) })
    const after = live({
      away: { team: team("ALA"), score: 24 },
      situation: ball("UGA", 75, 1, 10, { lastPlay: "Fumble recovered in the end zone, touchdown" })
    })
    assert.deepStrictEqual(tags(before, after), ["ScoreChanged", "PossessionChanged"])
  })

  it("reports a timeout from a drop in either side's count", () => {
    const before = live({ situation: ball("ALA", 45) })
    const after = live({ situation: ball("ALA", 45, 1, 10, { awayTimeouts: 2 }) })
    assert.deepStrictEqual(tags(before, after), ["TimeoutTaken"])
  })

  it("reports a timeout only as one fewer within the same period", () => {
    const at = (period: number, home: number, away: number) =>
      live({ period, situation: ball("ALA", 45, 1, 10, { homeTimeouts: home, awayTimeouts: away }) })
    assert.deepStrictEqual(tags(at(4, 3, 3), at(5, 1, 1)), ["Overtime", "PeriodEnded"])
    assert.deepStrictEqual(tags(at(4, 3, 3), at(4, 0, 0)), [])
    assert.deepStrictEqual(tags(at(4, 3, 3), at(4, 3, 2)), ["TimeoutTaken"])
  })

  it("reports a new drive starting inside the 40 as reaching scoring range", () => {
    const before = live({ situation: ball("ALA", 45) })
    const picked = live({ situation: ball("UGA", 30, 1, 10, { lastPlay: "Pass INTERCEPTED by K.Smith" }) })
    assert.deepStrictEqual(tags(before, picked), ["Turnover", "ReachedScoringRange"])
  })

  it("reports the clock and status: two-minute drill, end of a period, halftime, overtime, final", () => {
    assert.deepStrictEqual(tags(live({ clock: "2:05" }), live({ clock: "1:58" })), ["TwoMinuteDrill"])
    assert.deepStrictEqual(tags(live({ period: 1, clock: "0:00" }), live({ period: 2, clock: "15:00" })), [
      "PeriodEnded"
    ])
    assert.deepStrictEqual(
      tags(live({ period: 2, clock: "0:00" }), live({ period: 2, status: "halftime" })),
      ["WentToHalftime"]
    )
    assert.deepStrictEqual(tags(live({ clock: "0:00" }), live({ period: 5, clock: "" })), [
      "Overtime",
      "PeriodEnded"
    ])
    assert.deepStrictEqual(tags(live(), live({ status: "final" })), ["WentFinal"])
  })
})

describe("GameSnapshot#secondsLeft", () => {
  it("reads the clock, and an unreadable one as a full quarter", () => {
    assert.strictEqual(live({ clock: "2:10" }).secondsLeft(), 130)
    assert.strictEqual(live({ clock: "0:00" }).secondsLeft(), 0)
    assert.strictEqual(live({ clock: "" }).secondsLeft(), 900)
  })
})

describe("GameSnapshot#quarterLeft", () => {
  it("is the share of the quarter left on the clock", () => {
    assert.strictEqual(live({ clock: "7:30" }).quarterLeft(), 0.5)
    assert.strictEqual(live({ clock: "0:00" }).quarterLeft(), 0)
    assert.strictEqual(live({ clock: "" }).quarterLeft(), 1)
  })
})
