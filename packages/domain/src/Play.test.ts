import { assert, describe, it } from "@effect/vitest"
import { Order, Schema } from "effect"
import { GameEventKind } from "./GameEvent.ts"
import { Play, PlayId } from "./Play.ts"
import { play, team } from "./TestGame.ts"

const wire = (id: string, sequence: number) => ({
  id,
  sequence,
  period: 1,
  clock: "12:34",
  team: "99",
  kind: "rush" as const,
  text: "R.Smith run for 4 yds",
  yards: 4,
  scoring: false,
  homeScore: 0,
  awayScore: 0,
  start: { down: 1, distance: 10, yardsToEndzone: 75, team: "99" },
  end: { down: 2, distance: 6, yardsToEndzone: 71 },
  homeWinProbability: 0.52
})

describe("Play", () => {
  it("round-trips through its wire form", () => {
    const play = Schema.decodeSync(Play)(wire("4018729692165", 1))
    assert.deepStrictEqual(Schema.encodeSync(Play)(play), wire("4018729692165", 1))
  })

  it("orders by sequence, not by id", () => {
    const first = Schema.decodeSync(Play)(wire("4018729692165", 1))
    const second = Schema.decodeSync(Play)(wire("40187296940", 2))
    assert.deepStrictEqual([second, first].sort(Play.order), [first, second])
    assert.strictEqual(Order.max(Play.order)(first, second), second)
  })
})

const home = team("HOME").id
const away = team("AWAY").id
const next = (overrides: Partial<Play>) => play({ id: PlayId.make("2"), sequence: 2, ...overrides })
const since = (before: ReadonlyArray<Play>, after: ReadonlyArray<Play>) => Play.eventsSince(before, after)
const tags = (events: ReadonlyArray<GameEventKind>) => events.map((event) => event._tag)

describe("Play.eventsSince", () => {
  it("reports nothing without new plays, for a repeated list, or for a revised text", () => {
    const first = play()
    assert.deepStrictEqual(since([first], [first]), [])
    assert.deepStrictEqual(since([], []), [])
    assert.deepStrictEqual(since([first], [new Play({ ...first, text: "Rush for 1 yard (revised)" })]), [])
  })

  it("reports a touchdown pass as played and big, and leaves the score to the snapshot", () => {
    const touchdown = next({ kind: "pass", yards: 25, scoring: true, homeScore: 6 })
    const events = since([play()], [play(), touchdown])
    assert.deepStrictEqual(events, [
      GameEventKind.Played({ play: touchdown }),
      GameEventKind.BigPlay({ team: home, yards: 25 })
    ])
  })

  it("reports a defensive score as played only", () => {
    const pickSix = next({ kind: "interception", scoring: true, awayScore: 6, end: { team: away } })
    assert.deepStrictEqual(tags(since([], [play(), pickSix])), ["Played", "Played"])
  })

  it("reports an interception, a lost fumble, a punt, and a kept fumble as played only", () => {
    for (const kind of ["interception", "fumbleLost", "punt", "fumble"] as const) {
      const turned = next({ kind, end: { team: away } })
      assert.deepStrictEqual(since([play()], [play(), turned]), [GameEventKind.Played({ play: turned })])
    }
  })

  it("reports a long punt or penalty as played, not a big play", () => {
    const punt = next({ kind: "punt", yards: 45 })
    const penalty = next({ kind: "penalty", yards: 25 })
    assert.deepStrictEqual(tags(since([play()], [play(), punt])), ["Played"])
    assert.deepStrictEqual(tags(since([play()], [play(), penalty])), ["Played"])
  })

  it("reports a timeout, an end of period, and a fourth-down play as played only", () => {
    const called = next({ kind: "timeout", team: away })
    const ended = next({ kind: "endPeriod", period: 2 })
    const stopped = next({ end: { down: 4, distance: 3, yardsToEndzone: 40, team: home } })
    for (const one of [called, ended, stopped]) {
      assert.deepStrictEqual(since([play()], [play(), one]), [GameEventKind.Played({ play: one })])
    }
  })

  it("reports a sack for the team sacked", () => {
    const sack = next({ kind: "sack", yards: -7 })
    assert.deepStrictEqual(since([play()], [play(), sack]).slice(1), [GameEventKind.Sack({ team: home })])
  })

  it("reports two new plays at once in sequence order", () => {
    const late = play({ id: PlayId.make("3"), sequence: 3, kind: "sack" })
    const early = next({ kind: "punt", end: { team: away } })
    assert.deepStrictEqual(tags(since([play()], [late, play(), early])), ["Played", "Played", "Sack"])
  })
})
