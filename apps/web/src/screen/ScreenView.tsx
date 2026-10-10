import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { useCallback } from "react"
import * as DisplayState from "../display/DisplayState.ts"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "./DisplayScreen.ts"
import { Dividers } from "./Dividers.tsx"
import { Tile } from "./Screen.ts"
import { TileBody } from "./TileBody.tsx"
import { TileChrome } from "./TileChrome.tsx"
import * as TilePlacements from "./TilePlacements.ts"

/**
 * The Screen: each on-screen tile positioned from the layout, with the shell's provider views laid over their
 * wells at the same pixels. When tiles move, the chrome and the video move together along one transition.
 */
export function ScreenView() {
  const screen = useAtomValue(DisplayScreen.screen)
  const shown = useAtomValue(TilePlacements.shown)
  const rects = useAtomValue(TilePlacements.rects)
  const dragging = Option.isSome(useAtomValue(TilePlacements.dragged))
  const display = useAtomValue(DisplayState.display)
  const { slate, classifications } = useAtomValue(LiveStream.live)
  const selected = display.selectedOn(screen)
  const areaRef = useArea()

  return (
    <main ref={areaRef} className="relative min-h-0 overflow-hidden bg-background">
      {shown.onScreen().map((tile, index) => {
        const rect = rects[index]
        if (rect === undefined) return null
        const game = Tile.guards.Empty(tile) ? undefined : Option.getOrUndefined(slate.gameOf(tile.game))
        const hidden = rect.width === 0

        return (
          <section
            key={Tile.guards.Empty(tile) ? `slot-${index}` : tile.game}
            aria-hidden={hidden}
            className={`absolute flex flex-col overflow-hidden rounded-sm border ${
              selected === index ? "border-foreground/60" : "border-border"
            } ${hidden ? "pointer-events-none opacity-0" : ""}`}
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              transition: dragging ? undefined : cssTransition
            }}
          >
            <TileChrome
              screen={screen}
              slot={index}
              tile={tile}
              game={game?.snapshot}
              selected={selected === index}
              classification={game === undefined ? undefined : classifications[game.snapshot.id]}
            />
            <div className="flex min-h-0 flex-1 items-center justify-center bg-well">
              <TileBody tile={tile} game={game} />
            </div>
          </section>
        )
      })}
      {Option.isNone(shown.solo) && <Dividers layout={shown.layout} split={shown.splits[shown.layout]} />}
    </main>
  )
}

const cssTransition = ["left", "top", "width", "height", "opacity"]
  .map(
    (property) =>
      `${property} ${TilePlacements.screenTransition.durationMs}ms cubic-bezier(${TilePlacements.screenTransition.easing.join(",")})`
  )
  .join(", ")

/** A ref for the Screen area's element: its size and place in the window go to `TilePlacements.area` as they change. */
function useArea() {
  const setArea = useAtomSet(TilePlacements.area)
  return useCallback(
    (element: HTMLElement | null) => {
      if (element === null) return undefined
      const measure = () => {
        const { x, y, width, height } = element.getBoundingClientRect()
        setArea((last) =>
          last.x === x && last.y === y && last.width === width && last.height === height
            ? last
            : { x, y, width, height }
        )
      }
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      window.addEventListener("resize", measure)
      return () => {
        observer.disconnect()
        window.removeEventListener("resize", measure)
      }
    },
    [setArea]
  )
}
