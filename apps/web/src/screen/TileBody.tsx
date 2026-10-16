import { useAtomValue } from "@effect/atom-react"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { Highlight } from "@sportal/domain/Highlight"
import { Option, Result } from "effect"
import { useEffect, useMemo, useRef } from "react"
import { CustomStream } from "../custom/CustomStream.ts"
import { Field } from "../game/Field.tsx"
import { GameStatus, localTime } from "../game/GameStatus.tsx"
import { Score } from "../game/Score.tsx"
import * as Games from "../hub/Games.ts"
import { GameStatsView } from "../stats/GameStats.tsx"
import { Tile } from "./Screen.ts"
import * as TilePlacements from "./TilePlacements.ts"

/**
 * What a tile's well shows from the web UI. In the shell a provider view covers a stream tile's
 * well; in a plain browser this is what is seen, with a link to watch. A data tile of a live game (halftime and a
 * delay during it included) shows the field in place of why it has no stream; the field dims itself out of play. A
 * custom tile, in a plain browser, plays YouTube's embedded player. A stats tile fills its well with as many of its
 * game's stats as fit. A clip tile plays its highlight in a page video, with sound only while `heard`.
 */
export function TileBody(props: { tile: Tile; snapshot: GameSnapshot | undefined; heard: boolean }) {
  const { tile, snapshot } = props
  return Tile.match(tile, {
    Empty: () => <p className="label-caps text-muted-foreground/60 text-sm tracking-[0.2em]">No signal</p>,
    DataTile: ({ why }) =>
      snapshot?.progress() === "live" ? (
        <div className="flex max-h-full min-h-0 w-full flex-col items-center gap-3 p-3">
          <Scoreboard game={snapshot} />
          <LiveField key={snapshot.id} game={snapshot} />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          {snapshot !== undefined && <Scoreboard game={snapshot} />}
          <p className="text-muted-foreground text-sm">{noStream(why)}</p>
        </div>
      ),
    StreamTile: ({ channel }) => (
      <a
        className="text-muted-foreground text-sm underline underline-offset-4"
        href={channel.locator.url}
        target="_blank"
        rel="noreferrer"
      >
        Open in {channel.source}
      </a>
    ),
    CustomTile: (custom) => <CustomPlayer tile={custom} />,
    StatsTile: ({ game }) => <GameStatsView game={game} fit="tile" />,
    ClipTile: ({ highlight }) => <ClipVideo highlight={highlight} heard={props.heard} />
  })
}

/** A highlight in a page video: it plays at once, muted unless its tile has audio focus, and rests on its last frame. */
function ClipVideo(props: { highlight: Highlight; heard: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  // React sets `muted` only when the element is made; audio focus moving later sets it here.
  useEffect(() => {
    if (ref.current !== null) ref.current.muted = !props.heard
  }, [props.heard])
  return (
    <div className="relative flex size-full items-center justify-center">
      <video
        ref={ref}
        src={props.highlight.video}
        poster={props.highlight.thumbnail}
        autoPlay
        controls
        playsInline
        muted={!props.heard}
        className="max-h-full max-w-full"
      />
      <span className="label-caps absolute top-2 left-2 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
        Replay
      </span>
    </div>
  )
}

/**
 * A custom tile's well. In the shell its provider view plays the watch page over it, so it only names the stream; in a
 * plain browser it is YouTube's embedded player.
 */
function CustomPlayer(props: { tile: typeof Tile.cases.CustomTile.Type }) {
  const providerViews = useAtomValue(TilePlacements.providerViews)
  const { stream, name, locator } = props.tile
  // The tile keeps the watch page the shell loads; the embedded player's address is read back from it.
  const embed = Result.match(CustomStream.parse(locator.url, name), {
    onSuccess: (custom) => custom.embedUrl(),
    onFailure: () => undefined
  })
  if (providerViews || embed === undefined) return <p className="text-muted-foreground text-sm">{name}</p>
  return (
    <iframe
      key={stream}
      title={name}
      src={embed}
      className="h-full w-full border-0"
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
    />
  )
}

/** A live game's field, its plays read from the game's own live stream. */
function LiveField(props: { game: GameSnapshot }) {
  const { value } = useAtomValue(Games.plays(props.game.id))
  // The stream sends plays newest first; the field draws them in play order.
  const plays = useMemo(() => value.toReversed(), [value])
  return <Field game={props.game} plays={plays} className="min-h-0 w-full max-w-xl" />
}

/** A game's score, large, for a tile with no video. */
function Scoreboard(props: { game: GameSnapshot }) {
  const { game } = props
  return (
    <div className="grid grid-cols-[auto_auto_auto_auto] items-center gap-x-5 gap-y-1">
      <Score game={game} side="away" size="board" />
      <Score game={game} side="home" size="board" />
      <GameStatus game={game} className="col-span-4 text-center text-xs" />
    </div>
  )
}

function noStream(why: typeof NoStreamWhy.Type): string {
  return NoStreamWhy.match(why, {
    NoStream: () => "No stream for this game on your sources",
    StreamingOnly: () => "Streaming only: not on your sources",
    NotInGuide: () => "Not on your sources' channels",
    NoGuide: ({ source }) => `Waiting for the ${source} guide`,
    NotYet: ({ channel, begin }) =>
      Option.match(channel, {
        onNone: () => "Not in your sources' guides yet",
        onSome: (channel) =>
          `On ${channel}${Option.match(begin, { onNone: () => "", onSome: (begin) => ` at ${localTime(begin)}` })}`
      })
  })
}

/** Why a data tile has no stream. */
const NoStreamWhy = Tile.cases.DataTile.fields.why
