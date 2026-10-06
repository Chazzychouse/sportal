import type { TilePlacement } from "@sportal/api/ShellBridge"
import type { GameId } from "@sportal/domain/Game"
import type { Stage } from "@sportal/domain/Stage"

/**
 * Each on-stage tile's rectangle in the Stage area, in whole pixels, main tile first. Slot edges are rounded
 * once, so neighbours share an edge and every gap is the same width. A soloed game gets the whole area; the
 * other tiles keep their place with no size, so they can grow back from it.
 */
export function tileRects(
  stage: Stage,
  area: { width: number; height: number }
): ReadonlyArray<{ x: number; y: number; width: number; height: number }> {
  const whole = inset({ x: 0, y: 0, width: area.width, height: area.height })
  const solo = stage.solo === undefined ? undefined : stage.slotOf(stage.solo)
  return stage
    .currentLayout()
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

/** The part of a tile below its header, where its video goes. */
function videoBounds(rect: { x: number; y: number; width: number; height: number }) {
  return { x: rect.x, y: rect.y + header, width: rect.width, height: Math.max(0, rect.height - header) }
}

/**
 * What the shell must show for each stream and picking tile with a size: its game's view, in window pixels.
 * `origin` is where the Stage area sits in the window; `page` is the web UI's own address, which a source's path
 * (a scenario's synthetic stream) is resolved against. Only `interacting`'s stream gets the mouse.
 */
export function placements(
  stage: Stage,
  rects: ReturnType<typeof tileRects>,
  origin: { x: number; y: number },
  page: string,
  interacting: GameId | undefined
): Array<TilePlacement> {
  return stage.onStage().flatMap((tile, index) => {
    const rect = rects[index]
    if (rect === undefined || rect.width === 0 || tile._tag === "Empty") return []
    const view =
      tile._tag === "StreamTile"
        ? {
            url: tile.channel.locator.url.startsWith("/")
              ? new URL(tile.channel.locator.url, page).href
              : tile.channel.locator.url,
            role: "stream" as const,
            muted: !stage.hears(tile.game),
            interactive: tile.game === interacting
          }
        : tile._tag === "PickingChannel"
          ? // A guide can preview what is on; it never takes the sound.
            { url: tile.guide.url, role: "guide" as const, muted: true, interactive: false }
          : undefined
    if (view === undefined) return []
    const video = videoBounds(rect)
    return [{ game: tile.game, ...view, bounds: { ...video, x: video.x + origin.x, y: video.y + origin.y } }]
  })
}

/** Pixels between tiles, and the height of a tile's header strip. */
export const gap = 6
const header = 28

function inset(rect: { x: number; y: number; width: number; height: number }) {
  const half = gap / 2
  return { x: rect.x + half, y: rect.y + half, width: rect.width - gap, height: rect.height - gap }
}
