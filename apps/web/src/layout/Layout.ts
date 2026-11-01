import { Schema } from "effect"
import { LayoutName, Screen, Split } from "../screen/Screen.ts"

/** A layout with its dividers: the slots it arranges, main tile first, as fractions of the Screen area. */
export class Layout extends Schema.Class<Layout>("sportal/web/Layout")({ name: LayoutName, split: Split }) {
  /** The Screen's current layout at its split. */
  static of(screen: Screen): Layout {
    return new Layout({ name: screen.layout, split: screen.splits[screen.layout] })
  }

  /** A layout at the split a new Screen gives it. */
  static ofDefault(name: LayoutName): Layout {
    return new Layout({ name, split: Screen.initial.splits[name] })
  }

  /** The axes of the dividers a layout uses. */
  static dividers(name: LayoutName): ReadonlyArray<"x" | "y"> {
    return dividers[name]
  }

  static next(name: LayoutName): LayoutName {
    const names = LayoutName.literals
    return names[(names.indexOf(name) + 1) % names.length] ?? "Single"
  }

  /** A layout's name as people read it. */
  static label(name: LayoutName): string {
    return labels[name]
  }

  /** The split with each divider brought into the Screen's split bounds. */
  static clamp(split: Split): Split {
    return { x: within(split.x), y: within(split.y) }
  }

  slots(): ReadonlyArray<Slot> {
    return slotsOf[this.name](this.split)
  }

  /**
   * The slot that way from slot `from`: of the slots whose centre lies that way, those overlapping it across the axis
   * first, then the nearest along it, then the nearest across it. None at an edge.
   */
  neighbour(from: number, direction: "up" | "down" | "left" | "right"): number | undefined {
    const slots = this.slots()
    const origin = slots[from]
    if (origin === undefined) return undefined

    const [along, across] =
      direction === "left" || direction === "right" ? (["x", "y"] as const) : (["y", "x"] as const)
    const sign = direction === "right" || direction === "down" ? 1 : -1
    const ahead = slots
      .map((slot, index) => ({
        index,
        distance: (middle(slot, along) - middle(origin, along)) * sign,
        offset: Math.abs(middle(slot, across) - middle(origin, across)),
        overlaps: overlap(slot, origin, across) > 0
      }))
      .filter((candidate) => candidate.distance > 0)
      .toSorted(
        (a, b) => Number(b.overlaps) - Number(a.overlaps) || a.distance - b.distance || a.offset - b.offset
      )
    return ahead[0]?.index
  }
}

/** A place in a layout: a rectangle as fractions of the Screen area. */
export interface Slot {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The axes each layout's dividers move on. */
const dividers = {
  Single: [],
  Pair: ["x"],
  Quad: ["x", "y"],
  MainThree: ["x"],
  MainFive: ["x", "y"]
} as const satisfies Record<LayoutName, ReadonlyArray<"x" | "y">>

/** A layout's name as people read it. */
const labels: Record<LayoutName, string> = {
  Single: "Single",
  Pair: "Side by side",
  Quad: "Quad",
  MainThree: "Main + 3",
  MainFive: "Main + 5"
}

/** Each layout's slots at a split, main slot first. */
const slotsOf: Record<LayoutName, (split: Split) => ReadonlyArray<Slot>> = {
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
  return Math.min(Screen.splitBounds.max, Math.max(Screen.splitBounds.min, at))
}

/** The rectangle between two corners. */
function rect(left: number, top: number, right: number, bottom: number): Slot {
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The middle of a slot on one axis. */
function middle(slot: Slot, axis: "x" | "y"): number {
  return axis === "x" ? slot.x + slot.width / 2 : slot.y + slot.height / 2
}

/** How far two slots overlap on one axis: zero or less when they only touch or are apart. */
function overlap(a: Slot, b: Slot, axis: "x" | "y"): number {
  const [start, size] = axis === "x" ? (["x", "width"] as const) : (["y", "height"] as const)
  return Math.min(a[start] + a[size], b[start] + b[size]) - Math.max(a[start], b[start])
}
