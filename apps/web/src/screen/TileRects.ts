import type { TileBounds, TilePlacement } from "@sportal/api/ShellBridge"
import type { TileKey } from "@sportal/api/TileKey"
import { Option } from "effect"
import { Layout } from "../layout/Layout.ts"
import { type Screen, Tile } from "./Screen.ts"

/**
 * Each on-screen tile's rectangle in the Screen area, in whole pixels, main tile first. Slot edges are rounded
 * once, so neighbours share an edge and every gap is the same width. A soloed tile gets the whole area; the
 * other tiles keep their place with no size, so they can grow back from it.
 */
export function tileRects(
  screen: Screen,
  area: { width: number; height: number }
): ReadonlyArray<TileBounds> {
  const whole = inset({ x: 0, y: 0, width: area.width, height: area.height })
  const solo = Option.getOrUndefined(Option.map(screen.solo, (key) => screen.slotOf(key)))

  return Layout.of(screen)
    .slots()
    .map((slot, index) => {
      const left = Math.round(slot.x * area.width)
      const top = Math.round(slot.y * area.height)
      const rect = inset({
        x: left,
        y: top,
        width: Math.round((slot.x + slot.width) * area.width) - left,
        height: Math.round((slot.y + slot.height) * area.height) - top
      })
      if (solo === undefined) return rect
      return index === solo ? whole : { ...rect, width: 0, height: 0 }
    })
}

/**
 * What the shell must show for each tile with a video and a size: its view, by the tile's key, in window pixels.
 * `origin` is where the Screen area sits in the window. Only `interacting`'s view gets the mouse.
 */
export function placements(
  screen: Screen,
  rects: ReadonlyArray<TileBounds>,
  origin: { x: number; y: number },
  interacting: TileKey | undefined
): Array<TilePlacement> {
  return screen.onScreen().flatMap((tile, index) => {
    const rect = rects[index]
    const key = Tile.key(tile)
    const locator = Tile.locator(tile)
    if (rect === undefined || rect.width === 0 || key === undefined || locator === undefined) return []
    const view = { url: locator.url, muted: !screen.hears(key), interactive: key === interacting }
    const video = videoBounds(rect)
    return [{ key, ...view, bounds: { ...video, x: video.x + origin.x, y: video.y + origin.y } }]
  })
}

/**
 * The keys of the tiles whose video an open overlay covers, in the order of `videos`: those sharing any area with an
 * overlay. An overlay flush against a video, touching only its edge, leaves it shown.
 */
export function coveredTiles(
  overlays: ReadonlyArray<TileBounds>,
  videos: ReadonlyArray<{ key: TileKey; bounds: TileBounds }>
): ReadonlyArray<TileKey> {
  return videos
    .filter((video) => overlays.some((overlay) => overlaps(overlay, video.bounds)))
    .map((video) => video.key)
}

/** The part of a tile below its tileHeader, where its video goes. */
function videoBounds(rect: TileBounds) {
  return {
    x: rect.x,
    y: rect.y + tileHeader,
    width: rect.width,
    height: Math.max(0, rect.height - tileHeader)
  }
}

/** Whether two rectangles share any area; touching edges do not. */
function overlaps(a: TileBounds, b: TileBounds) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Pixels between tiles. */
export const gap = 6

/** The height of a tile's header strip, in pixels: the part of a tile above its video. */
export const tileHeader = 28

function inset(rect: TileBounds) {
  const half = gap / 2
  return { x: rect.x + half, y: rect.y + half, width: rect.width - gap, height: rect.height - gap }
}
