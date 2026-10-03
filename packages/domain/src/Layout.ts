import { Schema } from "effect"

/** The layouts a Stage can take, in the order the next-layout hotkey cycles through them. */
export const LayoutName = Schema.Literals(["Single", "Pair", "Quad", "MainThree", "MainFive"])
export type LayoutName = typeof LayoutName.Type

/** Where a layout's dividers sit, as fractions of the Stage area. A layout uses none, `x`, or both. */
export const Split = Schema.Struct({ x: Schema.Finite, y: Schema.Finite })
export type Split = typeof Split.Type

/** A layout with its dividers: the slots it arranges, main tile first, as fractions of the Stage area. */
export class Layout extends Schema.Class<Layout>("sportal/Layout")({ name: LayoutName, split: Split }) {
  static slotCount(name: LayoutName): number {
    return { Single: 1, Pair: 2, Quad: 4, MainThree: 4, MainFive: 6 }[name]
  }

  static defaultSplit(name: LayoutName): Split {
    switch (name) {
      case "MainThree":
        return { x: 0.75, y: 0.5 }
      case "MainFive":
        return { x: 2 / 3, y: 2 / 3 }
      default:
        return { x: 0.5, y: 0.5 }
    }
  }

  static next(name: LayoutName): LayoutName {
    const names = LayoutName.literals
    return names[(names.indexOf(name) + 1) % names.length] ?? "Single"
  }

  /** Whether both dividers are where every tile stays watchable: 0.2–0.8. */
  static holds(split: Split): boolean {
    return [split.x, split.y].every((at) => at >= 0.2 && at <= 0.8)
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

/** The rectangle between two corners. */
function rect(left: number, top: number, right: number, bottom: number) {
  return { x: left, y: top, width: right - left, height: bottom - top }
}
