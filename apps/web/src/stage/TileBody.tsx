import type { GameSnapshot } from "@sportal/domain/Game"
import type { Tile } from "@sportal/domain/Stage"
import { Option } from "effect"
import { Field } from "../game/Field.tsx"
import { GameStatus, localTime } from "../game/GameStatus.tsx"
import { Score } from "../game/Score.tsx"
import { usePlays } from "../hub/HubRuntime.ts"

/**
 * What a tile's well shows from the web UI. In the shell a provider view covers a stream tile's
 * well; in a plain browser this is what is seen, with a link to watch. A data tile of a live game (halftime and a
 * delay during it included) shows the field in place of why it has no stream; the field dims itself out of play.
 */
export function TileBody(props: { tile: Tile; game: GameSnapshot | undefined }) {
  const { tile, game } = props
  switch (tile._tag) {
    case "Empty":
      return <p className="label-caps text-muted-foreground/60 text-sm tracking-[0.2em]">No signal</p>
    case "DataTile":
      return game?.progress() === "live" ? (
        <div className="flex max-h-full min-h-0 w-full flex-col items-center gap-3 p-3">
          <Scoreboard game={game} />
          <GameField key={game.id} game={game} />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          {game !== undefined && <Scoreboard game={game} />}
          <p className="text-muted-foreground text-sm">{noStream(tile.why)}</p>
        </div>
      )
    case "StreamTile":
      return (
        <a
          className="text-muted-foreground text-sm underline underline-offset-4"
          href={tile.channel.locator.url}
          target="_blank"
          rel="noreferrer"
        >
          Open in {tile.channel.source}
        </a>
      )
  }
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

/** A game's field with its recent plays, under a data tile's scoreboard. */
function GameField(props: { game: GameSnapshot }) {
  return <Field game={props.game} plays={usePlays(props.game.id)} className="min-h-0 w-full max-w-xl" />
}

function noStream(why: Extract<Tile, { _tag: "DataTile" }>["why"]): string {
  switch (why._tag) {
    case "NoStream":
      return "No stream for this game on your sources"
    case "StreamingOnly":
      return "Streaming only: not on YouTube TV"
    case "NotInGuide":
      return "Not in your YouTube TV guide"
    case "NoGuide":
      return "Waiting for the YouTube TV guide"
    case "NotYet":
      return Option.match(why.channel, {
        onNone: () => "Not in your YouTube TV guide yet",
        onSome: (channel) =>
          `On ${channel}${Option.match(why.begin, { onNone: () => "", onSome: (begin) => ` at ${localTime(begin)}` })}`
      })
  }
}
