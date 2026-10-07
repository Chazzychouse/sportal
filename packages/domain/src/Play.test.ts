import { assert, describe, it } from "@effect/vitest"
import { Order, Schema } from "effect"
import { GameEventKind } from "./GameEvent.ts"
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
import { play, tags, team } from "./TestGame.ts"

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
const since = (before: ReadonlyArray<Play>, after: ReadonlyArray<Play>) => Play.eventsSince(before, after)

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

describe("FootballPlay.eventsSince", () => {
  it("should report nothing when there are no new plays", () => {
    assert.deepStrictEqual(since([], []), [])
  })

  it("should report nothing for a repeated list", () => {
    const first = play()

    assert.deepStrictEqual(since([first], [first]), [])
  })

  it("should report nothing for a play whose text was revised", () => {
    const first = play()
    const revised = play({ text: "Rush for 1 yard (revised)" })

    assert.deepStrictEqual(since([first], [revised]), [])
  })

  it("should report a touchdown completion as played and big", () => {
    const touchdown = new Completion({ ...gained, yards: 25, touchdown: true, scoring: true, homeScore: 6 })

    const events = since([play()], [play(), touchdown])

    assert.deepStrictEqual(events, [
      GameEventKind.Played({ play: touchdown }),
      GameEventKind.BigPlay({ team: home, yards: 25 })
    ])
  })

  it("should leave the score of a touchdown to the snapshot", () => {
    const touchdown = new Completion({ ...gained, yards: 25, touchdown: true, scoring: true, homeScore: 6 })

    const events = since([play()], [play(), touchdown])

    assert.isFalse(events.some((event) => event._tag === "ScoreChanged"))
  })

  it("should report a defensive touchdown as played only", () => {
    const pickSix = new Interception({
      ...gained,
      return: "touchdown",
      scoring: true,
      awayScore: 6,
      end: { team: away }
    })

    assert.deepStrictEqual(tags(since([], [play(), pickSix])), ["Played", "Played"])
  })

  it("should report an interception as played only", () => {
    const picked = new Interception({ ...gained, return: "none", end: { team: away } })

    assert.deepStrictEqual(since([play()], [play(), picked]), [GameEventKind.Played({ play: picked })])
  })

  it("should report a lost fumble as played only", () => {
    const lost = new Fumble({ ...gained, recovery: "opponent", end: { team: away } })

    assert.deepStrictEqual(since([play()], [play(), lost]), [GameEventKind.Played({ play: lost })])
  })

  it("should report a punt as played only", () => {
    const punt = new Punt({ ...gained, return: "none", end: { team: away } })

    assert.deepStrictEqual(since([play()], [play(), punt]), [GameEventKind.Played({ play: punt })])
  })

  it("should report a kept fumble as played only", () => {
    const kept = new Fumble({ ...gained, recovery: "own", end: { team: away } })

    assert.deepStrictEqual(since([play()], [play(), kept]), [GameEventKind.Played({ play: kept })])
  })

  it("should report a long punt as played, not big", () => {
    const punt = new Punt({ ...gained, yards: 45, return: "none" })

    assert.deepStrictEqual(tags(since([play()], [play(), punt])), ["Played"])
  })

  it("should report a long penalty as played, not big", () => {
    const penalty = new Penalty({ ...gained, yards: 25 })

    assert.deepStrictEqual(tags(since([play()], [play(), penalty])), ["Played"])
  })

  it("should report a timeout as played only", () => {
    const called = new Timeout({ ...fields, team: away })

    assert.deepStrictEqual(since([play()], [play(), called]), [GameEventKind.Played({ play: called })])
  })

  it("should report a period end as played only", () => {
    const ended = new PeriodEnd({ ...fields, period: 2, ends: "half" })

    assert.deepStrictEqual(since([play()], [play(), ended]), [GameEventKind.Played({ play: ended })])
  })

  it("should report a fourth-down play as played only", () => {
    const stopped = new Rush({
      ...gained,
      touchdown: false,
      end: { down: 4, distance: 3, yardsToEndzone: 40, team: home }
    })

    assert.deepStrictEqual(since([play()], [play(), stopped]), [GameEventKind.Played({ play: stopped })])
  })

  it("should report a sack for the offense", () => {
    const sack = new Sack({ ...gained, yards: -7, fumbleLost: false })

    assert.deepStrictEqual(since([play()], [play(), sack]).slice(1), [GameEventKind.Sack({ team: home })])
  })

  it("should report two new plays in sequence order", () => {
    const late = new Sack({ ...gained, id: PlayId.make("3"), sequence: 3, fumbleLost: false })
    const early = new Punt({ ...gained, return: "none", end: { team: away } })

    assert.deepStrictEqual(tags(since([play()], [late, play(), early])), ["Played", "Played", "Sack"])
  })
})

describe("Rush#offense", () => {
  it("should be the play's team", () => {
    const rush = new Rush({ ...gained, team: away, touchdown: false })

    assert.strictEqual(rush.offense(), away)
  })

  it("should fall back to the start spot's team", () => {
    const { team: _, ...unattributed } = gained
    const rush = new Rush({ ...unattributed, touchdown: false })

    assert.strictEqual(rush.offense(), home)
  })
})

describe("Sack#lostYards", () => {
  it("should be true", () => {
    const sack = new Sack({ ...gained, yards: 0, fumbleLost: false })

    assert.isTrue(sack.lostYards())
  })
})

describe("Rush#lostYards", () => {
  it("should be true below zero yards", () => {
    const rush = new Rush({ ...gained, yards: -2, touchdown: false })

    assert.isTrue(rush.lostYards())
  })

  it("should be false at zero", () => {
    const rush = new Rush({ ...gained, yards: 0, touchdown: false })

    assert.isFalse(rush.lostYards())
  })
})
