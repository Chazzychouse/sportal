import { Array as Arr } from "effect"

/**
 * The sections a tile shows, in priority order: the first always, then each next one while every one so far fits in
 * `available` pixels together. The first that does not fit ends the list, so a smaller later one never shows
 * in its place.
 */
export function sectionsThatFit<S>(
  available: number,
  heights: ReadonlyArray<{ readonly section: S; readonly height: number }>
): ReadonlyArray<S> {
  const totals = Arr.scan(heights, 0, (sum, { height }) => sum + height)
  const fitting = Arr.takeWhile(
    heights,
    (_, index) => index === 0 || (totals[index + 1] ?? Infinity) <= available
  )
  return fitting.map(({ section }) => section)
}
