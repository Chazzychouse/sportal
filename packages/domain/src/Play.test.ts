import { assert, describe, it } from "@effect/vitest"
import { Order, Schema } from "effect"
import {
  Completion,
  ExtraPoint,
  FieldGoal,
  Fumble,
  Incompletion,
  Interception,
  Kickoff,
  Other,
  Penalty,
  PeriodEnd,
  Play,
  PlayId,
  Punt,
  Rush,
  Sack,
  Safety,
  Stoppage,
  Timeout,
  TwoPointTry
} from "./Play.ts"
import { team } from "./TestGame.ts"

const home = team("HOME").id
const away = team("AWAY").id

// What every play carries, as the play-by-play lists a game's second play.
const fields = {
  id: PlayId.make("2"),
  sequence: 2,
  period: 1,
  clock: "14:30",
  text: "A play",
  scoring: false,
  homeScore: 0,
  awayScore: 0,
  start: { down: 1, distance: 10, yardsToEndzone: 75, team: home },
  end: { down: 2, distance: 6, yardsToEndzone: 71, team: home }
}
const gained = { ...fields, team: home, yards: 4 }

const encode = Schema.encodeSync(Play)
const decode = Schema.decodeUnknownSync(Play)

describe("FootballPlay", () => {
  it.each([
    new Rush({ ...gained, touchdown: false }),
    new Completion({ ...gained, touchdown: true }),
    new Incompletion({ ...gained, yards: 0 }),
    new Interception({ ...gained, return: "returned" }),
    new Sack({ ...gained, yards: -7, fumbleLost: true }),
    new Fumble({ ...gained, recovery: "own" }),
    new TwoPointTry({ ...gained, by: "pass" }),
    new Kickoff({ ...gained, returnTouchdown: false }),
    new Punt({ ...gained, return: "none" }),
    new FieldGoal({ ...gained, result: "blocked" }),
    new ExtraPoint({ ...gained, good: true }),
    new Safety({ ...gained }),
    new Penalty({ ...gained }),
    new Timeout({ ...fields, team: away }),
    new Stoppage({ ...fields, kind: "twoMinuteWarning" }),
    new PeriodEnd({ ...fields, ends: "half" }),
    new Other({ ...fields, type: { id: "999", text: "Something New" } })
  ])("should round-trip a $_tag through its wire form", (one) => {
    const wire = encode(one)

    assert.deepStrictEqual(decode(wire), one)
  })

  it("should decode a play whose _tag it does not know as a failure", () => {
    const wire = { ...encode(new Rush({ ...gained, touchdown: false })), _tag: "Scramble" }

    assert.throws(() => decode(wire))
  })

  it("should order plays by sequence, not by id", () => {
    const first = new Rush({ ...gained, id: PlayId.make("4018729692165"), sequence: 1, touchdown: false })
    const second = new Rush({ ...gained, id: PlayId.make("40187296940"), sequence: 2, touchdown: false })

    const sorted = [second, first].sort(Play.order)

    assert.deepStrictEqual(sorted, [first, second])
    assert.strictEqual(Order.max(Play.order)(first, second), second)
  })
})

describe("FootballPlay.offense", () => {
  it("should be the team a play that gains yards names", () => {
    const rush = new Rush({ ...gained, team: away, touchdown: false })

    assert.strictEqual(Play.offense(rush), away)
  })

  it("should fall back to the start spot's team", () => {
    const { team: _, ...unattributed } = gained
    const rush = new Rush({ ...unattributed, touchdown: false })

    assert.strictEqual(Play.offense(rush), home)
  })

  it("should be the start spot's team, not the caller, for a timeout", () => {
    const timeout = new Timeout({ ...fields, team: away })

    assert.strictEqual(Play.offense(timeout), home)
  })
})

describe("FootballPlay.lostYards", () => {
  it("should be true for a sack", () => {
    const sack = new Sack({ ...gained, yards: 0, fumbleLost: false })

    assert.isTrue(Play.lostYards(sack))
  })

  it("should be true below zero yards", () => {
    const rush = new Rush({ ...gained, yards: -2, touchdown: false })

    assert.isTrue(Play.lostYards(rush))
  })

  it("should be false at zero", () => {
    const rush = new Rush({ ...gained, yards: 0, touchdown: false })

    assert.isFalse(Play.lostYards(rush))
  })

  it("should be false for a play that gains no yards", () => {
    const stoppage = new Stoppage({ ...fields, kind: "officialTimeout" })

    assert.isFalse(Play.lostYards(stoppage))
  })
})
