import type { Game, GameSnapshot } from "@sportal/domain/Game"
import { Tile } from "@sportal/domain/Screen"
import { Option } from "effect"
import { Field } from "../game/Field.tsx"
import { GameStatus, localTime } from "../game/GameStatus.tsx"
import { Score } from "../game/Score.tsx"

/**
 * What a tile's well shows from the web UI. In the shell a provider view covers a stream tile's
 * well; in a plain browser this is what is seen, with a link to watch. A data tile of a live game (halftime and a
 * delay during it included) shows the field in place of why it has no stream; the field dims itself out of play.
 */
export function TileBody(props: { tile: Tile; game: Game | undefined }) {
  const { tile, game } = props
  return Tile.match(tile, {
    Empty: () => <p className="label-caps text-muted-foreground/60 text-sm tracking-[0.2em]">No signal</p>,
    DataTile: ({ why }) =>
      game?.snapshot.progress() === "live" ? (
        <div className="flex max-h-full min-h-0 w-full flex-col items-center gap-3 p-3">
          <Scoreboard game={game.snapshot} />
          <Field
            key={game.snapshot.id}
            game={game.snapshot}
            plays={game.plays}
            className="min-h-0 w-full max-w-xl"
          />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          {game !== undefined && <Scoreboard game={game.snapshot} />}
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
    )
  })
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
    StreamingOnly: () => "Streaming only: not on YouTube TV",
    NotInGuide: () => "Not in your YouTube TV guide",
    NoGuide: () => "Waiting for the YouTube TV guide",
    NotYet: ({ channel, begin }) =>
      Option.match(channel, {
        onNone: () => "Not in your YouTube TV guide yet",
        onSome: (channel) =>
          `On ${channel}${Option.match(begin, { onNone: () => "", onSome: (begin) => ` at ${localTime(begin)}` })}`
      })
  })
}

/** Why a data tile has no stream. */
const NoStreamWhy = Tile.cases.DataTile.fields.why
