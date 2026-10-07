import { assert, describe, it } from "@effect/vitest"
import { Transition } from "./Transition.ts"

describe("Transition.progress", () => {
  it("should start at 0", () => {
    const progress = Transition.progress(standard, 0)

    assert.strictEqual(progress, 0)
  })

  it("should end at 1", () => {
    const progress = Transition.progress(standard, 1)

    assert.strictEqual(progress, 1)
  })

  it("should follow a linear curve as the identity", () => {
    const progress = Transition.progress([0, 0, 1, 1], 0.3)

    assert.closeTo(progress, 0.3, 1e-6)
  })

  it("should run an ease-out ahead of linear", () => {
    const progress = Transition.progress(standard, 0.5)

    assert.isAbove(progress, 0.5)
  })

  it("should match CSS ease at its midpoint", () => {
    const progress = Transition.progress([0.25, 0.1, 0.25, 1], 0.5)

    // cubic-bezier(0.25, 0.1, 0.25, 1) at x = 0.5 is about 0.8024.
    assert.closeTo(progress, 0.8024, 1e-3)
  })

  it.each([
    { at: 1.5, clamped: 1 },
    { at: -1, clamped: 0 }
  ])("should clamp outside 0–1: $at to $clamped", ({ at, clamped }) => {
    const progress = Transition.progress(standard, at)

    assert.strictEqual(progress, clamped)
  })
})

describe("Transition.between", () => {
  it("should land exactly on the target", () => {
    const to = { x: 641, y: 33, width: 637, height: 359 }

    const landed = Transition.between({ x: 0, y: 0, width: 10, height: 10 }, to, 1)

    assert.deepStrictEqual(landed, to)
  })

  it("should be whole pixels on the way", () => {
    const from = { x: 0, y: 0, width: 10, height: 10 }

    const halfway = Transition.between(from, { x: 5, y: 5, width: 15, height: 15 }, 0.5)

    assert.deepStrictEqual(halfway, { x: 3, y: 3, width: 13, height: 13 })
  })
})

/** An ease-out curve. */
const standard = [0.2, 0, 0, 1] as const
