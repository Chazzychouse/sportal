import { assert, describe, it } from "@effect/vitest"
import { LayoutName, Screen, type Split } from "@sportal/domain/Screen"
import { Layout } from "./Layout.ts"

describe("Layout#slots", () => {
  it("should give Single one slot filling the area", () => {
    const slots = Layout.ofDefault("Single").slots()

    assert.deepStrictEqual(slots, [{ x: 0, y: 0, width: 1, height: 1 }])
  })

  it("should split Pair at x", () => {
    const layout = new Layout({ name: "Pair", split: { x: 0.6, y: 0.5 } })

    const [left, right] = layout.slots()

    assert.deepStrictEqual(left, { x: 0, y: 0, width: 0.6, height: 1 })
    assert.strictEqual(right?.x, 0.6)
    assert.closeTo(right?.width ?? 0, 0.4, 1e-9)
  })

  it("should split Quad at x and y with the main tile top left", () => {
    const layout = new Layout({ name: "Quad", split: { x: 0.25, y: 0.75 } })

    const [main, right, bottom, corner] = layout.slots()

    assert.deepStrictEqual(main, { x: 0, y: 0, width: 0.25, height: 0.75 })
    assert.deepStrictEqual(right, { x: 0.25, y: 0, width: 0.75, height: 0.75 })
    assert.deepStrictEqual(bottom, { x: 0, y: 0.75, width: 0.25, height: 0.25 })
    assert.deepStrictEqual(corner, { x: 0.25, y: 0.75, width: 0.75, height: 0.25 })
  })

  it("should put MainThree's main tile left of three stacked tiles", () => {
    const layout = new Layout({ name: "MainThree", split: { x: 0.75, y: 0.5 } })

    const [main, ...stacked] = layout.slots()

    assert.deepStrictEqual(main, { x: 0, y: 0, width: 0.75, height: 1 })
    assert.deepStrictEqual(
      stacked.map((slot) => slot.y),
      [0, 1 / 3, 2 / 3]
    )
    assert.deepStrictEqual(
      stacked.map((slot) => slot.width),
      [0.25, 0.25, 0.25]
    )
  })

  it("should put MainFive's main tile top left, two beside it and three along the bottom", () => {
    const slots = Layout.ofDefault("MainFive").slots()

    assert.strictEqual(slots.length, 6)
    assert.deepStrictEqual(slots[0], { x: 0, y: 0, width: 2 / 3, height: 2 / 3 })
    assert.deepStrictEqual(
      slots.slice(3).map((slot) => slot.y),
      [2 / 3, 2 / 3, 2 / 3]
    )
  })

  it.each(layoutsAtSplits())(
    "should tile the whole area without overlap: $name at $split.x,$split.y",
    (layout) => {
      const slots = layout.slots()

      const area = slots.reduce((sum, slot) => sum + slot.width * slot.height, 0)
      assert.closeTo(area, 1, 1e-9)
      for (const [i, a] of slots.entries())
        for (const b of slots.slice(i + 1))
          assert.isFalse(overlaps(a, b), `${layout.name}: slot ${i} overlaps`)
    }
  )

  it.each(layoutsAtSplits())(
    "should give as many slots as Screen.slotCount: $name at $split.x,$split.y",
    (layout) => {
      const slots = layout.slots()

      assert.strictEqual(slots.length, Screen.slotCount(layout.name))
    }
  )
})

describe("Layout.next", () => {
  it("should go to the next layout", () => {
    const next = Layout.next("Single")

    assert.strictEqual(next, "Pair")
  })

  it("should wrap from the last to the first", () => {
    const next = Layout.next("MainFive")

    assert.strictEqual(next, "Single")
  })
})

describe("Layout.dividers", () => {
  it.each<[LayoutName, ReadonlyArray<"x" | "y">]>([
    ["Single", []],
    ["Pair", ["x"]],
    ["Quad", ["x", "y"]],
    ["MainThree", ["x"]],
    ["MainFive", ["x", "y"]]
  ])("should give %s the dividers %j", (name, axes) => {
    const dividers = Layout.dividers(name)

    assert.deepStrictEqual(dividers, axes)
  })
})

describe("Layout.clamp", () => {
  it.each<{ below: Split; raised: Split }>([
    { below: { x: 0.1, y: 0.5 }, raised: { x: 0.2, y: 0.5 } },
    { below: { x: 0.19, y: 0.5 }, raised: { x: 0.2, y: 0.5 } }
  ])("should raise an axis below the bounds: $below.x,$below.y", ({ below, raised }) => {
    const split = Layout.clamp(below)

    assert.deepStrictEqual(split, raised)
  })

  it.each<Split>([
    { x: 0.5, y: 0.3 },
    { x: 0.2, y: 0.8 },
    { x: 0.8, y: 0.5 }
  ])("should keep an axis inside them: $x,$y", (inside) => {
    const split = Layout.clamp(inside)

    assert.deepStrictEqual(split, inside)
  })

  it.each<{ above: Split; lowered: Split }>([
    { above: { x: 0.5, y: 0.95 }, lowered: { x: 0.5, y: 0.8 } },
    { above: { x: 0.81, y: 0.5 }, lowered: { x: 0.8, y: 0.5 } }
  ])("should lower an axis above them: $above.x,$above.y", ({ above, lowered }) => {
    const split = Layout.clamp(above)

    assert.deepStrictEqual(split, lowered)
  })

  it("should clamp each axis on its own", () => {
    const split = Layout.clamp({ x: 0.1, y: 0.95 })

    assert.deepStrictEqual(split, { x: 0.2, y: 0.8 })
  })
})

/** Every layout at its default split and at each end of the bounds. */
function layoutsAtSplits(): ReadonlyArray<Layout> {
  return LayoutName.literals.flatMap((name) =>
    [Screen.initial.splits[name], { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }].map(
      (split) => new Layout({ name, split })
    )
  )
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
) {
  const e = 1e-9
  return (
    a.x + a.width > b.x + e && b.x + b.width > a.x + e && a.y + a.height > b.y + e && b.y + b.height > a.y + e
  )
}
