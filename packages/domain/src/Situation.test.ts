import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { GameSnapshot } from "./Game.ts"
import { liveSnapshot, situation } from "./TestGame.ts"

describe("Situation#inRedZone", () => {
  it("should be in the red zone at the 20", () => {
    const atTwenty = situation({ yardLine: 20 })

    assert.isTrue(atTwenty.inRedZone())
  })

  it("should be in the red zone inside the 20", () => {
    const atThree = situation({ yardLine: 3 })

    assert.isTrue(atThree.inRedZone())
  })

  it("should not be in the red zone at the 21", () => {
    const atTwentyOne = situation({ yardLine: 21 })

    assert.isFalse(atTwentyOne.inRedZone())
  })

  it("should not be in the red zone with no yard line", () => {
    const noYardLine = situation({ yardLine: undefined })

    assert.isFalse(noYardLine.inRedZone())
  })

  it("should decode a snapshot stored with isRedZone", () => {
    const stored = Schema.encodeSync(GameSnapshot)(liveSnapshot({ situation: situation({ yardLine: 35 }) }))

    const decoded = Schema.decodeUnknownSync(GameSnapshot)({
      ...stored,
      situation: { ...stored.situation, isRedZone: true }
    })

    assert.strictEqual(decoded.situation?.yardLine, 35)
  })

  it("should take a decoded snapshot's red zone from its yard line, not its stored isRedZone", () => {
    const stored = Schema.encodeSync(GameSnapshot)(liveSnapshot({ situation: situation({ yardLine: 35 }) }))

    const decoded = Schema.decodeUnknownSync(GameSnapshot)({
      ...stored,
      situation: { ...stored.situation, isRedZone: true }
    })

    assert.isFalse(decoded.situation?.inRedZone())
  })
})
