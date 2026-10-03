import type { TilePlacement } from "@sportal/api/ShellBridge"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { Stage, Tile } from "@sportal/domain/Stage"
import { Option } from "effect"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { dispatch, forgetChannel, learnChannel, markNotCarried, sendGuide } from "../hub/HubClient.ts"
import { localTime } from "../LocalTime.ts"

export function StageView(props: {
  stage: Stage
  slate: ReadonlyArray<GameSnapshot>
  connected: boolean
  selected: number
  onSelect: (tile: number) => void
}) {
  // One element per tile marking where its video goes; the shell lays a provider view over each.
  const videoAreas = useRef<Array<HTMLDivElement | null>>([])
  // What went wrong with the last channel command on a tile, until the Stage next changes.
  const [notices, setNotices] = useState<ReadonlyMap<number, string>>(new Map())

  useLayoutEffect(() => {
    const sync = () => window.sportalShell?.syncTiles(placements(props.stage, videoAreas.current))
    sync()
    window.addEventListener("resize", sync)
    return () => window.removeEventListener("resize", sync)
  }, [props.stage])

  useEffect(() => {
    setNotices(new Map())
    // A channel picked in a picking tile's guide teaches the Hub that network's channel.
    return window.sportalShell?.onChannelPicked((pick) => {
      const tile = props.stage.tiles[pick.tile]
      if (tile?._tag === "PickingChannel")
        void learnChannel(tile.network, pick.url).then((failure) => setNotices(noticed(pick.tile, failure)))
    })
  }, [props.stage])

  // Listening first, then asking: the shell's first read waits for the web UI to ask.
  useEffect(() => window.sportalShell?.onGuideRead(sendGuide), [])

  useEffect(() => {
    // Asked again whenever the Hub comes back, since a guide read while it was away was lost.
    if (props.connected) window.sportalShell?.readGuide()
  }, [props.connected])

  return (
    <main className="grid min-h-0 grid-cols-2 grid-rows-2 gap-1 p-1">
      {props.stage.tiles.map((tile, index) => {
        const game = tile._tag === "Empty" ? undefined : props.slate.find((g) => g.id === tile.game)
        const hasAudio = props.stage.audioFocus === index
        const notice = notices.get(index)
        return (
          <section
            // biome-ignore lint/suspicious/noArrayIndexKey: a tile is identified by its slot.
            key={index}
            className={`flex min-h-0 flex-col rounded border ${
              props.selected === index ? "border-sky-500" : "border-neutral-800"
            }`}
          >
            <div
              ref={(element) => {
                videoAreas.current[index] = element
              }}
              className="flex min-h-0 flex-1 items-center justify-center bg-black text-neutral-500"
            >
              <TileBody tile={tile} />
            </div>
            <footer className="flex items-center gap-2 px-2 py-1 text-sm tabular-nums">
              <button type="button" className="flex-1 text-left" onClick={() => props.onSelect(index)}>
                {tile._tag === "PickingChannel"
                  ? `Pick the ${tile.network} channel`
                  : game === undefined
                    ? `Tile ${index + 1}`
                    : `${game.away.team.abbreviation} ${game.away.score} – ${game.home.score} ${game.home.team.abbreviation}`}
              </button>
              {/* In the footer, on the row's one line: the provider view always draws over the video area, and a
                  notice that changed the area's height would leave the view the wrong size. */}
              {notice === undefined ? null : (
                <p className="min-w-0 flex-1 truncate text-amber-400" title={notice}>
                  {notice}
                </p>
              )}
              {tile._tag === "PickingChannel" ? (
                <button
                  type="button"
                  className="text-neutral-500"
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
                  className="text-neutral-500"
                  onClick={() => {
                    const network = tile.learnedFor
                    if (network !== undefined)
                      void forgetChannel(network).then((failure) => setNotices(noticed(index, failure)))
                  }}
                >
                  wrong channel
                </button>
              ) : null}
              <button
                type="button"
                className={hasAudio ? "text-emerald-400" : "text-neutral-500"}
                onClick={() => dispatch({ _tag: "FocusAudio", tile: index })}
              >
                {hasAudio ? "audio on" : "audio"}
              </button>
              <button
                type="button"
                className="text-neutral-500"
                onClick={() => dispatch({ _tag: "Clear", tile: index })}
              >
                clear
              </button>
            </footer>
          </section>
        )
      })}
    </main>
  )
}

function TileBody(props: { tile: Tile }) {
  switch (props.tile._tag) {
    case "Empty":
      return <span>Pick a game from the slate</span>
    case "DataTile":
      return <span>{noStream(props.tile.why)}</span>
    case "PickingChannel":
      // Inside the shell the guide covers this. In a plain browser there is no view to watch for the pick.
      return (
        <span className="flex flex-col items-center gap-1">
          <a className="underline" href={props.tile.guide.url} target="_blank" rel="noreferrer">
            Open the guide
          </a>
          <span>Picking a channel works in the desktop app</span>
        </span>
      )
    case "StreamTile":
      // Inside the shell this is covered by the provider view. In a plain browser it is the way to watch.
      return (
        <a className="underline" href={props.tile.channel.locator.url} target="_blank" rel="noreferrer">
          Open in {props.tile.channel.source}
        </a>
      )
  }
}

function noStream(why: Extract<Tile, { _tag: "DataTile" }>["why"]): string {
  switch (why._tag) {
    case "NoStream":
      return "No stream for this game on your sources"
    case "StreamingOnly":
      return "Streaming only: not on YouTube TV"
    case "NotInGuide":
      return "Not in your YouTube TV guide"
    case "NotYet":
      return why.channel === undefined
        ? "Not in your YouTube TV guide yet"
        : `On ${why.channel}${why.begin === undefined ? "" : ` at ${localTime(why.begin)}`}`
  }
}

function placements(stage: Stage, videoAreas: ReadonlyArray<HTMLDivElement | null>): Array<TilePlacement> {
  return stage.tiles.flatMap((tile, index) => {
    const area = videoAreas[index]
    if (area === null || area === undefined) return []
    const view =
      tile._tag === "StreamTile"
        ? { url: tile.channel.locator.url, role: "stream" as const, muted: stage.audioFocus !== index }
        : tile._tag === "PickingChannel"
          ? // A guide can preview what is on; it never takes the sound.
            { url: tile.guide.url, role: "guide" as const, muted: true }
          : undefined
    if (view === undefined) return []
    const rect = area.getBoundingClientRect()
    return [
      {
        tile: index,
        ...view,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      }
    ]
  })
}

/** The notices with `failure`, if there was one, shown on `tile`. */
function noticed(tile: number, failure: Option.Option<string>) {
  return (notices: ReadonlyMap<number, string>) =>
    Option.isSome(failure) ? new Map(notices).set(tile, failure.value) : notices
}
