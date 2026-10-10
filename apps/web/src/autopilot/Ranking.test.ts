import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { DateTime, Record } from "effect"
import * as TestWeb from "../TestWeb.ts"
import { byRank, isLive, outranks, rankOf } from "./Ranking.ts"

const timeout: Moment = {
  _tag: "Break",
  reason: "timeout",
  expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z")
}

describe("rankOf", () => {
  it("should rank a red zone first", () => {
    assert.strictEqual(rankOf(TestWeb.redZone), "redZone")
  })

  it("should rank a game with no classification as live", () => {
    assert.strictEqual(rankOf(undefined), "live")
  })

  it("should rank a break below every live rank", () => {
    assert.isFalse(isLive(rankOf(timeout)))
  })

  it("should rank a final game not live", () => {
    assert.strictEqual(rankOf({ _tag: "Final" }), "notLive")
  })
})

describe("outranks", () => {
  it("should hold of crunch time over a big play", () => {
    assert.isTrue(outranks("crunchTime", "bigPlay"))
  })

  it("should not hold within a rank", () => {
    assert.isFalse(outranks("redZone", "redZone"))
  })
})

describe("byRank", () => {
  it("should put a higher rank first, whatever the scores", () => {
    const [a, b] = [GameId.make("a"), GameId.make("b")]
    const classifications = Record.fromEntries([
      [a, TestWeb.classified({ _tag: "Live" }, 90)],
      [b, TestWeb.classified(TestWeb.redZone, 10)]
    ])

    const sorted = [
      { tile: 0, game: a },
      { tile: 1, game: b }
    ].toSorted(byRank(classifications))

    assert.deepStrictEqual(
      sorted.map(({ game }) => game),
      [b, a]
    )
  })

  it("should put the higher score first within a rank", () => {
    const [a, b] = [GameId.make("a"), GameId.make("b")]
    const classifications = Record.fromEntries([
      [a, TestWeb.classified({ _tag: "Live" }, 40)],
      [b, TestWeb.classified({ _tag: "Live" }, 60)]
    ])

    const sorted = [
      { tile: 0, game: a },
      { tile: 1, game: b }
    ].toSorted(byRank(classifications))

    assert.deepStrictEqual(
      sorted.map(({ game }) => game),
      [b, a]
    )
  })

  it("should put the lower tile first on a tie", () => {
    const [a, b] = [GameId.make("a"), GameId.make("b")]

    const sorted = [
      { tile: 3, game: a },
      { tile: 1, game: b }
    ].toSorted(byRank({}))

    assert.deepStrictEqual(
      sorted.map(({ game }) => game),
      [b, a]
    )
  })
})
