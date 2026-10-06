import { assert, describe, it } from "@effect/vitest"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { scoreline } from "./Score.tsx"

describe("scoreline", () => {
  it("reads the away side first, the abbreviations around the scores", () => {
    const game = liveSnapshot({
      away: { ...snapshot().away, score: 21 },
      home: { ...snapshot().home, score: 14 }
    })
    assert.strictEqual(scoreline(game), "AWAY 21–14 HOME")
  })
})
