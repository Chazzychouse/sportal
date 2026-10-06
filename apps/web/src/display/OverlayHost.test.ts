import { assert, describe, it } from "@effect/vitest"
import { overlaps } from "./OverlayHost.tsx"

describe("overlaps", () => {
  const video = { x: 100, y: 100, width: 200, height: 100 }

  it("is true for rectangles sharing area", () => {
    assert.isTrue(overlaps({ x: 250, y: 150, width: 200, height: 200 }, video))
    assert.isTrue(overlaps({ x: 0, y: 0, width: 1000, height: 1000 }, video))
  })

  it("is false for rectangles that only touch, or are apart", () => {
    assert.isFalse(overlaps({ x: 300, y: 100, width: 50, height: 50 }, video))
    assert.isFalse(overlaps({ x: 0, y: 0, width: 50, height: 50 }, video))
  })
})
