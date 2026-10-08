import { LayoutName, Split, Stage } from "@sportal/domain/Stage"
import { Schema } from "effect"

/** A layout with its dividers: the slots it arranges, main tile first, as fractions of the Stage area. */
export class Layout extends Schema.Class<Layout>("sportal/web/Layout")({ name: LayoutName, split: Split }) {
  /** The Stage's current layout at its split. */
  static of(stage: Stage): Layout {
    return new Layout({ name: stage.layout, split: stage.splits[stage.layout] })
  }

  /** A layout at the split a new Stage gives it. */
  static ofDefault(name: LayoutName): Layout {
    return new Layout({ name, split: Stage.initial.splits[name] })
  }

  /** The axes of the dividers a layout uses. */
  static dividers(name: LayoutName): ReadonlyArray<"x" | "y"> {
    return dividers[name]
  }

  static next(name: LayoutName): LayoutName {
    const names = LayoutName.literals
    return names[(names.indexOf(name) + 1) % names.length] ?? "Single"
  }

  /** The split with each divider brought into the Stage's split bounds. */
  static clamp(split: Split): Split {
    return { x: within(split.x), y: within(split.y) }
  }

  slots(): ReadonlyArray<{ x: number; y: number; width: number; height: number }> {
    return slotsOf[this.name](this.split)
  }
}

/** The axes each layout's dividers move on. */
const dividers = {
  Single: [],
  Pair: ["x"],
  Quad: ["x", "y"],
  MainThree: ["x"],
  MainFive: ["x", "y"]
} as const satisfies Record<LayoutName, ReadonlyArray<"x" | "y">>

/** Each layout's slots at a split, main slot first. */
const slotsOf: Record<LayoutName, (split: Split) => ReadonlyArray<ReturnType<typeof rect>>> = {
  Single: () => [rect(0, 0, 1, 1)],
  Pair: ({ x }) => [rect(0, 0, x, 1), rect(x, 0, 1, 1)],
  Quad: ({ x, y }) => [rect(0, 0, x, y), rect(x, 0, 1, y), rect(0, y, x, 1), rect(x, y, 1, 1)],
  MainThree: ({ x }) => [
    rect(0, 0, x, 1),
    rect(x, 0, 1, 1 / 3),
    rect(x, 1 / 3, 1, 2 / 3),
    rect(x, 2 / 3, 1, 1)
  ],
  MainFive: ({ x, y }) => [
    rect(0, 0, x, y),
    rect(x, 0, 1, y / 2),
    rect(x, y / 2, 1, y),
    rect(0, y, x / 2, 1),
    rect(x / 2, y, x, 1),
    rect(x, y, 1, 1)
  ]
}

function within(at: number): number {
  return Math.min(Stage.splitBounds.max, Math.max(Stage.splitBounds.min, at))
}

/** The rectangle between two corners. */
function rect(left: number, top: number, right: number, bottom: number) {
  return { x: left, y: top, width: right - left, height: bottom - top }
}
