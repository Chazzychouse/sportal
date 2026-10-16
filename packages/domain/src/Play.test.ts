import { assert, describe, it } from "@effect/vitest"
import { Option, Order } from "effect"
import { Play, PlayId } from "./Play.ts"
import * as TestGame from "./TestGame.ts"

describe("Play.order", () => {
  it("should order plays by sequence, not by id", () => {
    const first = TestGame.play({ id: PlayId.make("4018729692165"), sequence: 1 })
    const second = TestGame.play({ id: PlayId.make("40187296940"), sequence: 2 })

    const sorted = [second, first].sort(Play.order)

    assert.deepStrictEqual(sorted, [first, second])
    assert.strictEqual(Order.max(Play.order)(first, second), second)
  })
})

describe("Play#offense", () => {
  it("should be the play's own team when it has one", () => {
    const play = TestGame.play({ team: TestGame.team("AWAY").id })

    const offense = play.offense()

    assert.deepStrictEqual(offense, Option.some(TestGame.team("AWAY").id))
  })

  it("should be a football play's start spot team when the play has none", () => {
    const play = TestGame.play({ team: undefined })

    const offense = play.offense()

    assert.deepStrictEqual(offense, Option.some(TestGame.team("HOME").id))
  })
})

describe("FootballDetail#lostYards", () => {
  it("should hold of a sack for no loss", () => {
    const detail = TestGame.footballDetail({ kind: "sack", yards: 0 })

    assert.isTrue(detail.lostYards())
  })

  it("should hold of a run for negative yards", () => {
    const detail = TestGame.footballDetail({ kind: "run", yards: -2 })

    assert.isTrue(detail.lostYards())
  })

  it("should not hold of a run for a gain", () => {
    const detail = TestGame.footballDetail({ kind: "run", yards: 3 })

    assert.isFalse(detail.lostYards())
  })

  it("should not hold of a run for no yards", () => {
    const detail = TestGame.footballDetail({ kind: "run", yards: 0 })

    assert.isFalse(detail.lostYards())
  })
})
