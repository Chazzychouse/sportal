import { assert, describe, it } from "@effect/vitest"
import { Order, Schema } from "effect"
import { GameEvent } from "./GameEvent.ts"
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
const teams = { home, away }
const next = (overrides: Partial<Play>) => play({ id: PlayId.make("2"), sequence: 2, ...overrides })
const since = (before: ReadonlyArray<Play>, after: ReadonlyArray<Play>) =>
  Play.eventsSince(before, after, teams)
const tags = (events: ReadonlyArray<GameEvent>) => events.map((event) => event._tag)

describe("Play.eventsSince", () => {
  it("reports nothing without new plays, for a repeated list, or for a revised text", () => {
    const first = play()
    assert.deepStrictEqual(since([first], [first]), [])
    assert.deepStrictEqual(since([], []), [])
    assert.deepStrictEqual(since([first], [new Play({ ...first, text: "Rush for 1 yard (revised)" })]), [])
  })

  it("reports a touchdown pass as played, scored, and big", () => {
    const touchdown = next({ kind: "pass", yards: 25, scoring: true, homeScore: 6 })
    const events = since([play()], [play(), touchdown])
    assert.deepStrictEqual(events, [
      GameEvent.Played({ play: touchdown }),
      GameEvent.ScoreChanged({ team: home, points: 6 }),
      GameEvent.BigPlay({ team: home, yards: 25 })
    ])
  })

  it("credits a defensive score to the side whose score rose", () => {
    const pickSix = next({
      kind: "interception",
      scoring: true,
      awayScore: 6,
      end: { team: away }
    })
    const events = since([], [play(), pickSix])
    assert.deepStrictEqual(
      events.filter((event) => event._tag === "ScoreChanged"),
      [GameEvent.ScoreChanged({ team: away, points: 6 })]
    )
  })

  it("reports an interception as a turnover for the team that took the ball, not a change of possession", () => {
    const picked = next({ kind: "interception", end: { team: away } })
    assert.deepStrictEqual(tags(since([play()], [play(), picked])), ["Played", "Turnover"])
    assert.deepStrictEqual(since([play()], [play(), picked])[1], GameEvent.Turnover({ team: away }))
  })

  it("reports a lost fumble as a turnover", () => {
    const lost = next({ kind: "fumbleLost", end: { team: away } })
    assert.deepStrictEqual(tags(since([play()], [play(), lost])), ["Played", "Turnover"])
  })

  it("reports a punt as a change of possession, and a fumble the offense kept as nothing but played", () => {
    const punt = next({ kind: "punt", end: { team: away } })
    assert.deepStrictEqual(since([play()], [play(), punt]).slice(1), [
      GameEvent.PossessionChanged({ team: away })
    ])
    const kept = next({ kind: "fumble" })
    assert.deepStrictEqual(tags(since([play()], [play(), kept])), ["Played"])
  })

  it("reports a team timeout, and an official timeout as nothing but played", () => {
    const called = next({ kind: "timeout", team: away })
    assert.deepStrictEqual(since([play()], [play(), called]).slice(1), [
      GameEvent.TimeoutTaken({ team: away })
    ])
    const official = next({ kind: "timeout", team: undefined })
    assert.deepStrictEqual(tags(since([play()], [play(), official])), ["Played"])
  })

  it("reports the end of a period with its period, and fourth down", () => {
    const ended = next({ kind: "endPeriod", period: 2 })
    assert.deepStrictEqual(since([play()], [play(), ended]).slice(1), [GameEvent.PeriodEnded({ period: 2 })])
    const stopped = next({ end: { down: 4, distance: 3, yardsToEndzone: 40, team: home } })
    assert.deepStrictEqual(since([play()], [play(), stopped]).slice(1), [
      GameEvent.FourthDown({ team: home })
    ])
  })

  it("reports a sack for the team sacked", () => {
    const sack = next({ kind: "sack", yards: -7 })
    assert.deepStrictEqual(since([play()], [play(), sack]).slice(1), [GameEvent.Sack({ team: home })])
  })

  it("reports two new plays at once in sequence order", () => {
    const late = play({ id: PlayId.make("3"), sequence: 3, kind: "sack" })
    const early = next({ kind: "punt", end: { team: away } })
    assert.deepStrictEqual(tags(since([play()], [late, play(), early])), [
      "Played",
      "PossessionChanged",
      "Played",
      "Sack"
    ])
  })
})
