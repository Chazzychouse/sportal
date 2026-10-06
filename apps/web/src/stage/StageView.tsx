import type { StageTransition } from "@sportal/api/ShellBridge"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { Split } from "@sportal/domain/Layout"
import type { Stage } from "@sportal/domain/Stage"
import { Option } from "effect"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { dispatch, forgetChannel, learnChannel, markNotCarried, sendGuide } from "../hub/HubClient.ts"
import { useVideoAreas } from "../OverlayHost.tsx"
import { Dividers } from "./Dividers.tsx"
import { TileBody } from "./TileBody.tsx"
import { TileChrome } from "./TileChrome.tsx"
import { placements, tileRects } from "./TileRects.ts"

/**
 * The Stage: each on-stage tile positioned from the layout, with the shell's provider views laid over their
 * wells at the same pixels. When tiles move, the chrome and the video move together along one transition.
 */
export function StageView(props: {
  stage: Stage
  slate: ReadonlyArray<GameSnapshot>
  connected: boolean
  selected: number
  interacting: GameId | undefined
  onSelect: (tile: number) => void
}) {
  const areaRef = useRef<HTMLDivElement | null>(null)
  const area = useArea(areaRef)
  // The split being dragged, shown in place of the Stage's until the drag is committed.
  const [dragged, setDragged] = useState<Split | undefined>(undefined)
  // What went wrong with the last channel command on a tile, until the Stage next changes.
  const [notices, setNotices] = useState<ReadonlyMap<number, string>>(new Map())

  const shown = dragged === undefined ? props.stage : props.stage.withSplit(dragged)
  const rects = tileRects(shown, area)
  const placed = placements(shown, rects, area, window.location.origin, props.interacting)
  useVideoAreas(placed)

  // The shell hears only placements that changed, so a re-render never cuts a transition short. A change of
  // arrangement moves the views along the transition; a resize or a drag moves them at once.
  const synced = useRef({ placements: "", arrangement: "" })
  useLayoutEffect(() => {
    if (area.width === 0) return
    const key = JSON.stringify(placed)
    if (key === synced.current.placements) return
    const arrangement = arrangementOf(props.stage)
    const moved =
      synced.current.arrangement !== "" && synced.current.arrangement !== arrangement && dragged === undefined
    synced.current = { placements: key, arrangement }
    window.sportalShell?.syncTiles(placed, moved ? stageTransition : undefined)
  })

  useEffect(() => {
    setNotices(new Map())
    // A channel picked in a picking tile's guide teaches the Hub that network's channel.
    return window.sportalShell?.onChannelPicked((pick) => {
      const index = props.stage.tiles.findIndex(
        (tile) => tile._tag === "PickingChannel" && tile.game === pick.game
      )
      const tile = props.stage.tiles[index]
      if (tile?._tag === "PickingChannel")
        void learnChannel(tile.network, pick.url).then((failure) => setNotices(noticed(index, failure)))
    })
  }, [props.stage])

  // A click on a video reaches the shell, not this page: the shell reports which game's view it was.
  useEffect(
    () =>
      window.sportalShell?.onTilePressed((game) => {
        const slot = props.stage.slotOf(game)
        if (slot !== undefined) props.onSelect(slot)
      }),
    [props.stage, props.onSelect]
  )

  // Listening first, then asking: the shell's first read waits for the web UI to ask.
  useEffect(() => window.sportalShell?.onGuideRead(sendGuide), [])

  useEffect(() => {
    // Asked again whenever the Hub comes back, since a guide read while it was away was lost.
    if (props.connected) window.sportalShell?.readGuide()
  }, [props.connected])

  return (
    <main ref={areaRef} className="relative min-h-0 overflow-hidden bg-background">
      {shown.onStage().map((tile, index) => {
        const rect = rects[index]
        if (rect === undefined) return null
        const game = tile._tag === "Empty" ? undefined : props.slate.find((g) => g.id === tile.game)
        const notice = notices.get(index)
        const hidden = rect.width === 0
        return (
          <section
            key={tile._tag === "Empty" ? `slot-${index}` : tile.game}
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
              stage={props.stage}
              slot={index}
              tile={tile}
              game={game}
              selected={props.selected === index}
              onSelect={() => props.onSelect(index)}
            >
              {/* In the header, on its one line: the provider view always draws over the well. */}
              {notice === undefined ? null : (
                <p className="min-w-0 max-w-[40%] truncate text-warn" title={notice}>
                  {notice}
                </p>
              )}
              {tile._tag === "PickingChannel" ? (
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    void markNotCarried(tile.network).then((failure) => setNotices(noticed(index, failure)))
                  }
                >
                  Not on {tile.source}
                </button>
              ) : null}
              {tile._tag === "StreamTile" && tile.learnedFor !== undefined ? (
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    const network = tile.learnedFor
                    if (network !== undefined)
                      void forgetChannel(network).then((failure) => setNotices(noticed(index, failure)))
                  }}
                >
                  wrong channel
                </button>
              ) : null}
            </TileChrome>
            <div className="flex min-h-0 flex-1 items-center justify-center bg-well">
              <TileBody tile={tile} game={game} />
            </div>
          </section>
        )
      })}
      {shown.solo === undefined && (
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

/** How tiles move when the Stage's arrangement changes; the shell moves the video along the same curve. */
const stageTransition: StageTransition = { durationMs: 280, easing: [0.2, 0, 0, 1] }

const cssTransition = ["left", "top", "width", "height", "opacity"]
  .map(
    (property) =>
      `${property} ${stageTransition.durationMs}ms cubic-bezier(${stageTransition.easing.join(",")})`
  )
  .join(", ")

/** The Stage area's size and its position in the window, kept current as it resizes. */
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
function arrangementOf(stage: Stage) {
  return JSON.stringify([
    stage.layout,
    stage.splits[stage.layout],
    stage.solo,
    stage.onStage().map((tile) => (tile._tag === "Empty" ? null : tile.game))
  ])
}

/** The notices with `failure`, if there was one, shown on `tile`. */
function noticed(tile: number, failure: Option.Option<string>) {
  return (notices: ReadonlyMap<number, string>) =>
    Option.isSome(failure) ? new Map(notices).set(tile, failure.value) : notices
}
