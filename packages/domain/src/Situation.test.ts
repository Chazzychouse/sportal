import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { GameSnapshot } from "./Game.ts"
import { liveSnapshot, situation } from "./TestGame.ts"

describe("Situation#inRedZone", () => {
  it("is in the red zone at the 20 and inside it, not at the 21", () => {
    assert.isTrue(situation({ yardLine: 20 }).inRedZone())
    assert.isTrue(situation({ yardLine: 3 }).inRedZone())
    assert.isFalse(situation({ yardLine: 21 }).inRedZone())
  })

  it("is not in the red zone with no yard line", () => {
    assert.isFalse(situation({ yardLine: undefined }).inRedZone())
  })

  it("a snapshot stored with isRedZone still decodes, and its red zone is its yard line's", () => {
    const stored = Schema.encodeSync(GameSnapshot)(liveSnapshot({ situation: situation({ yardLine: 35 }) }))
    const decoded = Schema.decodeUnknownSync(GameSnapshot)({
      ...stored,
      situation: { ...stored.situation, isRedZone: true }
    })

    assert.strictEqual(decoded.situation?.yardLine, 35)
    assert.isFalse(decoded.situation?.inRedZone())
  })
})
