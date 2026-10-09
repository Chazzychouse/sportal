import { useAtomSet } from "@effect/atom-react"
import type { ScreenTransition } from "@sportal/api/ShellBridge"
import type { Game, GameId } from "@sportal/domain/Game"
import { Effect, Option } from "effect"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useVideoAreas } from "../display/OverlayHost.tsx"
import { sendGuide } from "../hub/HubClient.ts"
import { runtime } from "../hub/HubRuntime.ts"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "./DisplayScreen.ts"
import { Dividers } from "./Dividers.tsx"
import { type Screen, type Split, Tile } from "./Screen.ts"
import { TileBody } from "./TileBody.tsx"
import { TileChrome } from "./TileChrome.tsx"
import { placements, tileRects } from "./TileRects.ts"

/**
 * The Screen: each on-screen tile positioned from the layout, with the shell's provider views laid over their
 * wells at the same pixels. When tiles move, the chrome and the video move together along one transition.
 */
export function ScreenView(props: {
  screen: Screen
  slate: ReadonlyArray<Game>
  connection: LiveStream.Connection
  selected: number
  interacting: GameId | undefined
  onSelect: (tile: number) => void
}) {
  const dispatch = useAtomSet(DisplayScreen.screen)
  const areaRef = useRef<HTMLDivElement | null>(null)
  const area = useArea(areaRef)
  // The split being dragged, shown in place of the Screen's until the drag is committed.
  const [dragged, setDragged] = useState<Split | undefined>(undefined)

  const shown = dragged === undefined ? props.screen : props.screen.withSplit(dragged)
  const rects = tileRects(shown, area)
  const placed = placements(shown, rects, area, props.interacting)
  useVideoAreas(placed)

  // The shell hears only placements that changed, so a re-render never cuts a transition short. A change of
  // arrangement moves the views along the transition; a resize or a drag moves them at once.
  const synced = useRef({ placements: "", arrangement: "" })
  useLayoutEffect(() => {
    if (area.width === 0) return
    const key = JSON.stringify(placed)
    if (key === synced.current.placements) return
    const arrangement = arrangementOf(props.screen)
    const moved =
      synced.current.arrangement !== "" && synced.current.arrangement !== arrangement && dragged === undefined
    synced.current = { placements: key, arrangement }
    window.sportalShell?.syncTiles(placed, moved ? screenTransition : undefined)
  })

  // A click on a video reaches the shell, not this page: the shell reports which game's view it was.
  useEffect(
    () =>
      window.sportalShell?.onTilePressed((game) => {
        const slot = props.screen.slotOf(game)
        if (slot !== undefined) props.onSelect(slot)
      }),
    [props.screen, props.onSelect]
  )

  const connected = LiveStream.Connection.$is("Connected")(props.connection)
  // Listening first, then asking: the shell's first read waits for the web UI to ask.
  useEffect(
    () =>
      window.sportalShell?.onGuideRead((guide) => {
        runtime.runFork(
          sendGuide(guide).pipe(
            Effect.catch((failure) => Effect.logWarning("The Hub did not take a guide", failure))
          )
        )
      }),
    []
  )

  useEffect(() => {
    // Asked again whenever the Hub comes back, since a guide read while it was away was lost.
    if (connected) window.sportalShell?.readGuide()
  }, [connected])

  return (
    <main ref={areaRef} className="relative min-h-0 overflow-hidden bg-background">
      {shown.onScreen().map((tile, index) => {
        const rect = rects[index]
        if (rect === undefined) return null
        const game = Tile.guards.Empty(tile)
          ? undefined
          : props.slate.find(({ snapshot }) => snapshot.id === tile.game)
        const hidden = rect.width === 0

        return (
          <section
            key={Tile.guards.Empty(tile) ? `slot-${index}` : tile.game}
            aria-hidden={hidden}
            className={`absolute flex flex-col overflow-hidden rounded-sm border ${
              props.selected === index ? "border-foreground/60" : "border-border"
            } ${hidden ? "pointer-events-none opacity-0" : ""}`}
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              transition: dragged === undefined ? cssTransition : undefined
            }}
          >
            <TileChrome
              screen={props.screen}
              slot={index}
              tile={tile}
              game={game?.snapshot}
              selected={props.selected === index}
              onSelect={() => props.onSelect(index)}
            />
            <div className="flex min-h-0 flex-1 items-center justify-center bg-well">
              <TileBody tile={tile} game={game} />
            </div>
          </section>
        )
      })}
      {Option.isNone(shown.solo) && (
        <Dividers
          layout={shown.layout}
          split={shown.splits[shown.layout]}
          area={area}
          onDrag={setDragged}
          onDrop={(split) => {
            setDragged(undefined)
            dispatch({ _tag: "SetSplit", split })
          }}
        />
      )}
    </main>
  )
}

/** How tiles move when the Screen's arrangement changes; the shell moves the video along the same curve. */
const screenTransition: ScreenTransition = { durationMs: 280, easing: [0.2, 0, 0, 1] }

const cssTransition = ["left", "top", "width", "height", "opacity"]
  .map(
    (property) =>
      `${property} ${screenTransition.durationMs}ms cubic-bezier(${screenTransition.easing.join(",")})`
  )
  .join(", ")

/** The Screen area's size and its position in the window, kept current as it resizes. */
function useArea(ref: { current: HTMLElement | null }) {
  const [area, setArea] = useState({ x: 0, y: 0, width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
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
  }, [ref])
  return area
}

/** What decides where tiles are: the layout, its split, solo, and which game is in which slot. */
function arrangementOf(screen: Screen) {
  return JSON.stringify([
    screen.layout,
    screen.splits[screen.layout],
    screen.solo,
    screen.onScreen().map((tile) => (Tile.guards.Empty(tile) ? null : tile.game))
  ])
}
