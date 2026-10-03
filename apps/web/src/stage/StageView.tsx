import type { TilePlacement } from "@sportal/api/ShellBridge"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { Stage, Tile } from "@sportal/domain/Stage"
import { useLayoutEffect, useRef } from "react"
import { dispatch } from "../hub/HubClient.ts"

export function StageView(props: {
  stage: Stage
  slate: ReadonlyArray<GameSnapshot>
  selected: number
  onSelect: (tile: number) => void
}) {
  // One element per tile marking where its video goes; the shell lays a provider view over each.
  const videoAreas = useRef<Array<HTMLDivElement | null>>([])

  useLayoutEffect(() => {
    const sync = () => window.sportalShell?.syncTiles(placements(props.stage, videoAreas.current))
    sync()
    window.addEventListener("resize", sync)
    return () => window.removeEventListener("resize", sync)
  }, [props.stage])

  return (
    <main className="grid min-h-0 grid-cols-2 grid-rows-2 gap-1 p-1">
      {props.stage.tiles.map((tile, index) => {
        const game = tile._tag === "Empty" ? undefined : props.slate.find((g) => g.id === tile.game)
        const hasAudio = props.stage.audioFocus === index
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
                {game === undefined
                  ? `Tile ${index + 1}`
                  : `${game.away.team.abbreviation} ${game.away.score} – ${game.home.score} ${game.home.team.abbreviation}`}
              </button>
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
      return <span>No stream for this game on your sources</span>
    case "StreamTile":
      // Inside the shell this is covered by the provider view. In a plain browser it is the way to watch.
      return (
        <a className="underline" href={props.tile.locator.url} target="_blank" rel="noreferrer">
          Open in YouTube TV
        </a>
      )
  }
}

function placements(stage: Stage, videoAreas: ReadonlyArray<HTMLDivElement | null>): Array<TilePlacement> {
  return stage.tiles.flatMap((tile, index) => {
    const area = videoAreas[index]
    if (tile._tag !== "StreamTile" || area === null || area === undefined) return []
    const rect = area.getBoundingClientRect()
    return [
      {
        tile: index,
        url: tile.locator.url,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        muted: stage.audioFocus !== index
      }
    ]
  })
}
