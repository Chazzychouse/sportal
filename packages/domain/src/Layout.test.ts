import { assert, describe, it } from "@effect/vitest"
import { Layout, LayoutName } from "./Layout.ts"

describe("Layout#slots", () => {
  it("gives Single one slot filling the area", () => {
    assert.deepStrictEqual(layout("Single").slots(), [{ x: 0, y: 0, width: 1, height: 1 }])
  })

  it("splits Pair at x", () => {
    const [left, right] = layout("Pair", { x: 0.6, y: 0.5 }).slots()
    assert.deepStrictEqual(left, { x: 0, y: 0, width: 0.6, height: 1 })
    assert.strictEqual(right?.x, 0.6)
    assert.closeTo(right?.width ?? 0, 0.4, 1e-9)
  })

  it("splits Quad at x and y, main tile top left", () => {
    const [main, right, bottom, corner] = layout("Quad", { x: 0.25, y: 0.75 }).slots()
    assert.deepStrictEqual(main, { x: 0, y: 0, width: 0.25, height: 0.75 })
    assert.deepStrictEqual(right, { x: 0.25, y: 0, width: 0.75, height: 0.75 })
    assert.deepStrictEqual(bottom, { x: 0, y: 0.75, width: 0.25, height: 0.25 })
    assert.deepStrictEqual(corner, { x: 0.25, y: 0.75, width: 0.75, height: 0.25 })
  })

  it("puts MainThree's main tile left of three stacked tiles", () => {
    const slots = layout("MainThree", { x: 0.75, y: 0.5 }).slots()
    assert.deepStrictEqual(slots[0], { x: 0, y: 0, width: 0.75, height: 1 })
    assert.deepStrictEqual(
      slots.slice(1).map((slot) => slot.y),
      [0, 1 / 3, 2 / 3]
    )
    for (const slot of slots.slice(1)) assert.strictEqual(slot.width, 0.25)
  })

  it("puts MainFive's main tile top left, two beside it and three along the bottom", () => {
    const slots = layout("MainFive").slots()
    assert.strictEqual(slots.length, 6)
    assert.deepStrictEqual(slots[0], { x: 0, y: 0, width: 2 / 3, height: 2 / 3 })
    assert.deepStrictEqual(
      slots.slice(3).map((slot) => slot.y),
      [2 / 3, 2 / 3, 2 / 3]
    )
  })

  for (const name of LayoutName.literals)
    for (const split of [Layout.defaultSplit(name), { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }])
      it(`tiles the whole area without overlap: ${name} at ${split.x},${split.y}`, () => {
        const slots = layout(name, split).slots()
        assert.strictEqual(slots.length, Layout.slotCount(name))
        const area = slots.reduce((sum, slot) => sum + slot.width * slot.height, 0)
        assert.closeTo(area, 1, 1e-9)
        for (const [i, a] of slots.entries())
          for (const b of slots.slice(i + 1)) assert.isFalse(overlaps(a, b), `${name}: slot ${i} overlaps`)
      })
})

describe("Layout statics", () => {
  it("cycles through the layouts in order and wraps", () => {
    assert.strictEqual(Layout.next("Single"), "Pair")
    assert.strictEqual(Layout.next("MainFive"), "Single")
  })

  it("holds dividers between 0.2 and 0.8", () => {
    assert.isTrue(Layout.holds({ x: 0.2, y: 0.8 }))
    assert.isFalse(Layout.holds({ x: 0.19, y: 0.5 }))
    assert.isFalse(Layout.holds({ x: 0.5, y: 0.81 }))
  })
})

function layout(name: LayoutName, split = Layout.defaultSplit(name)) {
  return new Layout({ name, split })
}

function overlaps(a: Rect, b: Rect) {
  const e = 1e-9
  return (
    a.x + a.width > b.x + e && b.x + b.width > a.x + e && a.y + a.height > b.y + e && b.y + b.height > a.y + e
  )
}

type Rect = ReturnType<Layout["slots"]>[number]
