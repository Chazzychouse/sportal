import { assert, describe, it } from "@effect/vitest"
import { Order, Schema } from "effect"
import { Play } from "./Play.ts"

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
