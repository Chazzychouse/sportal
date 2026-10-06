import { Record as Rec, Schema } from "effect"

/** The layouts a Stage can take, in the order the next-layout hotkey cycles through them. */
export const LayoutName = Schema.Literals(["Single", "Pair", "Quad", "MainThree", "MainFive"])
export type LayoutName = typeof LayoutName.Type

/** Where a layout's dividers sit, as fractions of the Stage area. A layout uses none, `x`, or both. */
export const Split = Schema.Struct({ x: Schema.Finite, y: Schema.Finite })
export type Split = typeof Split.Type

/** A layout with its dividers: the slots it arranges, main tile first, as fractions of the Stage area. */
export class Layout extends Schema.Class<Layout>("sportal/Layout")({ name: LayoutName, split: Split }) {
  /** The range each divider stays within, so every tile stays watchable. */
  static readonly bounds = { min: 0.2, max: 0.8 } as const

  static slotCount(name: LayoutName): number {
    return layouts[name].slots
  }

  static defaultSplit(name: LayoutName): Split {
    return layouts[name].split
  }

  /** Every layout's default split: what a new Stage keeps for each. */
  static defaultSplits(): Record<LayoutName, Split> {
    return Rec.map(layouts, ({ split }) => split)
  }

  /** The axes of the dividers a layout uses. */
  static dividers(name: LayoutName): ReadonlyArray<"x" | "y"> {
    return layouts[name].dividers
  }

  static next(name: LayoutName): LayoutName {
    const names = LayoutName.literals
    return names[(names.indexOf(name) + 1) % names.length] ?? "Single"
  }

  /** The split with each divider brought into the bounds. */
  static clamp(split: Split): Split {
    return { x: within(split.x), y: within(split.y) }
  }

  /** Whether both dividers are where every tile stays watchable: within the bounds. */
  static holds(split: Split): boolean {
    return [split.x, split.y].every((at) => within(at) === at)
  }

  slots(): ReadonlyArray<{ x: number; y: number; width: number; height: number }> {
    const { x, y } = this.split
    switch (this.name) {
      case "Single":
        return [rect(0, 0, 1, 1)]
      case "Pair":
        return [rect(0, 0, x, 1), rect(x, 0, 1, 1)]
      case "Quad":
        return [rect(0, 0, x, y), rect(x, 0, 1, y), rect(0, y, x, 1), rect(x, y, 1, 1)]
      case "MainThree":
        return [rect(0, 0, x, 1), rect(x, 0, 1, 1 / 3), rect(x, 1 / 3, 1, 2 / 3), rect(x, 2 / 3, 1, 1)]
      case "MainFive":
        return [
          rect(0, 0, x, y),
          rect(x, 0, 1, y / 2),
          rect(x, y / 2, 1, y),
          rect(0, y, x / 2, 1),
          rect(x / 2, y, x, 1),
          rect(x, y, 1, 1)
        ]
    }
  }
}

/** What each layout is: its slot count, where its dividers start, and the axes they move on. */
const layouts = {
  Single: { slots: 1, split: { x: 0.5, y: 0.5 }, dividers: [] },
  Pair: { slots: 2, split: { x: 0.5, y: 0.5 }, dividers: ["x"] },
  Quad: { slots: 4, split: { x: 0.5, y: 0.5 }, dividers: ["x", "y"] },
  MainThree: { slots: 4, split: { x: 0.75, y: 0.5 }, dividers: ["x"] },
  MainFive: { slots: 6, split: { x: 2 / 3, y: 2 / 3 }, dividers: ["x", "y"] }
} as const satisfies Record<LayoutName, { slots: number; split: Split; dividers: ReadonlyArray<"x" | "y"> }>

function within(at: number): number {
  return Math.min(Layout.bounds.max, Math.max(Layout.bounds.min, at))
}

/** The rectangle between two corners. */
function rect(left: number, top: number, right: number, bottom: number) {
  return { x: left, y: top, width: right - left, height: bottom - top }
}
