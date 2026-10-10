import { assert, describe, it } from "@effect/vitest"
import { Option, Order, Schema } from "effect"
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
import { completion, play, playFields, team } from "./TestGame.ts"

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
  end: { down: 2, distance: 6, yardsToEndzone: 71, team: home },
  homeWinProbability: 0.52
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

describe("FootballPlay.bigPlay", () => {
  it("should call a touchdown run a touchdown", () => {
    const run = play({ yards: 3, touchdown: true, scoring: true })

    assert.deepStrictEqual(Play.bigPlay(run), Option.some("touchdown"))
  })

  it("should call a 25-yard catch a long gain", () => {
    const catch25 = completion({ yards: 25 })

    assert.deepStrictEqual(Play.bigPlay(catch25), Option.some("longGain"))
  })

  it("should not call a 24-yard catch a big play", () => {
    const catch24 = completion({ yards: 24 })

    assert.deepStrictEqual(Play.bigPlay(catch24), Option.none())
  })

  it("should call any sack a sack", () => {
    const sack = new Sack({ ...playFields, team: playFields.start.team, yards: -2, fumbleLost: false })

    assert.deepStrictEqual(Play.bigPlay(sack), Option.some("sack"))
  })

  it("should call a strip sack a turnover", () => {
    const sack = new Sack({ ...playFields, team: playFields.start.team, yards: -8, fumbleLost: true })

    assert.deepStrictEqual(Play.bigPlay(sack), Option.some("turnover"))
  })

  it("should call an interception a turnover", () => {
    const pick = new Interception({
      ...playFields,
      team: playFields.start.team,
      yards: 0,
      return: "returned"
    })

    assert.deepStrictEqual(Play.bigPlay(pick), Option.some("turnover"))
  })

  it("should call a pick-six a touchdown", () => {
    const pick = new Interception({
      ...playFields,
      team: playFields.start.team,
      yards: 0,
      return: "touchdown"
    })

    assert.deepStrictEqual(Play.bigPlay(pick), Option.some("touchdown"))
  })

  it("should call a fumble the defense recovers a turnover", () => {
    const fumble = new Fumble({ ...playFields, team: playFields.start.team, yards: 2, recovery: "opponent" })

    assert.deepStrictEqual(Play.bigPlay(fumble), Option.some("turnover"))
  })

  it("should not call a fumble the offense recovers a big play", () => {
    const fumble = new Fumble({ ...playFields, team: playFields.start.team, yards: 2, recovery: "own" })

    assert.deepStrictEqual(Play.bigPlay(fumble), Option.none())
  })

  it("should call a kickoff returned past the receiving team's 45 a return", () => {
    const kick = new Kickoff({
      ...playFields,
      yards: 60,
      returnTouchdown: false,
      end: { yardsToEndzone: 52, team: playFields.start.team }
    })

    assert.deepStrictEqual(Play.bigPlay(kick), Option.some("return"))
  })

  it("should not call a touchback a big play", () => {
    const kick = new Kickoff({
      ...playFields,
      yards: 65,
      returnTouchdown: false,
      end: { yardsToEndzone: 75, team: playFields.start.team }
    })

    assert.deepStrictEqual(Play.bigPlay(kick), Option.none())
  })

  it("should call a punt returned for a touchdown a touchdown", () => {
    const punt = new Punt({ ...playFields, yards: 45, return: "touchdown" })

    assert.deepStrictEqual(Play.bigPlay(punt), Option.some("touchdown"))
  })

  it("should not call a punt nobody returned a big play, wherever it ended", () => {
    const punt = new Punt({
      ...playFields,
      yards: 30,
      return: "none",
      end: { yardsToEndzone: 50, team: playFields.start.team }
    })

    assert.deepStrictEqual(Play.bigPlay(punt), Option.none())
  })
})
