import type { SlateChanged } from "@sportal/api/LiveMessage"
import type { Classification } from "@sportal/domain/Classification"
import { Array as Arr, DateTime, Duration, type Option } from "effect"
import { type LayoutName, Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"

/**
 * The commands that fit `screen` to the games worth showing, never past `ceiling`: the `Swap`s that bring games worth
 * showing from beyond the layout's slots into its slots from 1 that hold none, then the `SetLayout`. None when it
 * fits. Slot 0 is the main tile's and never moves. Pure.
 */
export function fit(
  screen: Screen,
  ceiling: LayoutName,
  classifications: SlateChanged["classifications"],
  now: DateTime.Utc
): ReadonlyArray<ScreenCommand> {
  const showing = (tile: Tile | undefined) =>
    tile !== undefined && !Tile.guards.Empty(tile) && worthShowing(classifications[tile.game], now)
  const others = screen.tiles.slice(1).filter(showing).length
  const layout = showing(screen.tiles[0]) || others > 0 ? smallest(ceiling, 1 + others) : ceiling
  const slots = Screen.slotCount(layout)
  const open = Array.from({ length: slots - 1 }, (_, index) => index + 1).filter(
    (slot) => !showing(screen.tiles[slot])
  )
  const waiting = screen.tiles.flatMap((tile, index) => (index >= slots && showing(tile) ? [index] : []))
  const swaps = Arr.zip(open, waiting).map(([a, b]): ScreenCommand => ({ _tag: "Swap", a, b }))
  return layout === screen.layout ? swaps : [...swaps, { _tag: "SetLayout", layout }]
}

/** When the earliest hold of a game over on a tile of `screen` runs out, of those still running at `now`. */
export function nextFit(
  screen: Screen,
  classifications: SlateChanged["classifications"],
  now: DateTime.Utc
): Option.Option<DateTime.Utc> {
  const ends = screen.tiles.flatMap((tile) => {
    const classification = Tile.guards.Empty(tile) ? undefined : classifications[tile.game]
    return classification?.moment._tag === "Final" ? [holdEnd(classification)] : []
  })
  return Arr.head(ends.filter((end) => DateTime.isGreaterThan(end, now)).toSorted(DateTime.Order))
}

/** How long a game that is over stays worth showing, so you see the end. */
const finalHold = Duration.minutes(2)

/** The layouts each home layout shrinks through, smallest first. */
const ladders: Record<LayoutName, ReadonlyArray<LayoutName>> = {
  Single: ["Single"],
  Pair: ["Single", "Pair"],
  Quad: ["Single", "Pair", "Quad"],
  MainThree: ["Single", "Pair", "MainThree"],
  MainFive: ["Single", "Pair", "MainThree", "MainFive"]
}

/** Whether a game is in progress, or over less than `finalHold` ago. A game with no classification is. */
function worthShowing(classification: Classification | undefined, now: DateTime.Utc): boolean {
  if (classification === undefined) return true
  switch (classification.moment._tag) {
    case "Upcoming":
      return false
    case "Final":
      return DateTime.isLessThan(now, holdEnd(classification))
    default:
      return true
  }
}

function holdEnd({ since }: Classification): DateTime.Utc {
  return DateTime.addDuration(since, finalHold)
}

/** The smallest layout on `ceiling`'s ladder with a slot for each of `games`. */
function smallest(ceiling: LayoutName, games: number): LayoutName {
  return ladders[ceiling].find((layout) => Screen.slotCount(layout) >= games) ?? ceiling
}
