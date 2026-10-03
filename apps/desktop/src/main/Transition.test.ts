import { assert, describe, it } from "@effect/vitest"
import { Transition } from "./Transition.ts"

const standard = [0.2, 0, 0, 1] as const

describe("Transition.progress", () => {
  it("starts at 0 and ends at 1", () => {
    assert.strictEqual(Transition.progress(standard, 0), 0)
    assert.strictEqual(Transition.progress(standard, 1), 1)
  })

  it("follows the CSS curve: linear is the identity, and this ease-out runs ahead of it", () => {
    assert.closeTo(Transition.progress([0, 0, 1, 1], 0.3), 0.3, 1e-6)
    assert.isAbove(Transition.progress(standard, 0.5), 0.5)
  })

  it("matches CSS ease at its midpoint", () => {
    // cubic-bezier(0.25, 0.1, 0.25, 1) at x = 0.5 is about 0.8024.
    assert.closeTo(Transition.progress([0.25, 0.1, 0.25, 1], 0.5), 0.8024, 1e-3)
  })

  it("clamps outside 0–1", () => {
    assert.strictEqual(Transition.progress(standard, 1.5), 1)
    assert.strictEqual(Transition.progress(standard, -1), 0)
  })
})

describe("Transition.between", () => {
  it("lands exactly on the target", () => {
    const to = { x: 641, y: 33, width: 637, height: 359 }
    assert.deepStrictEqual(Transition.between({ x: 0, y: 0, width: 10, height: 10 }, to, 1), to)
  })

  it("is whole pixels on the way", () => {
    const from = { x: 0, y: 0, width: 10, height: 10 }
    const halfway = Transition.between(from, { x: 5, y: 5, width: 15, height: 15 }, 0.5)
    assert.deepStrictEqual(halfway, { x: 3, y: 3, width: 13, height: 13 })
  })
})
