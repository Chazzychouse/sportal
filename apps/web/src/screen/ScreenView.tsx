import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { Option } from "effect"
import { useCallback } from "react"
import * as DisplayState from "../display/DisplayState.ts"
import * as Games from "../hub/Games.ts"
import * as DisplayScreen from "./DisplayScreen.ts"
import { Dividers } from "./Dividers.tsx"
import { type Screen, Tile } from "./Screen.ts"
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
  const selected = display.selectedOn(screen)
  const areaRef = useArea()

  return (
    <main ref={areaRef} className="relative min-h-0 overflow-hidden bg-background">
      {shown.onScreen().map((tile, index) => {
        const rect = rects[index]
        if (rect === undefined) return null
        const hidden = rect.width === 0
        const game = Tile.game(tile)

        return (
          <section
            key={Tile.key(tile) ?? `slot-${index}`}
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
            {game === undefined ? (
              <TileFace
                screen={screen}
                slot={index}
                tile={tile}
                snapshot={undefined}
                selected={selected === index}
              />
            ) : (
              <TileGame screen={screen} slot={index} tile={tile} game={game} selected={selected === index} />
            )}
          </section>
        )
      })}
      {Option.isNone(shown.solo) && <Dividers layout={shown.layout} split={shown.splits[shown.layout]} />}
    </main>
  )
}

/** A tile's game, read from its own live stream: the header always, the field only for a data tile of a live game. */
function TileGame(props: { screen: Screen; slot: number; tile: Tile; game: GameId; selected: boolean }) {
  const { value } = useAtomValue(Games.game(props.game))
  const snapshot = Option.getOrUndefined(Option.map(value, ({ snapshot }) => snapshot))
  return <TileFace {...props} snapshot={snapshot} />
}

/** A tile's chrome over its well. */
function TileFace(props: {
  screen: Screen
  slot: number
  tile: Tile
  snapshot: GameSnapshot | undefined
  selected: boolean
}) {
  return (
    <>
      <TileChrome
        screen={props.screen}
        slot={props.slot}
        tile={props.tile}
        game={props.snapshot}
        selected={props.selected}
      />
      <div className="flex min-h-0 flex-1 items-center justify-center bg-well">
        <TileBody tile={props.tile} snapshot={props.snapshot} />
      </div>
    </>
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
