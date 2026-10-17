import type { Channel } from "@sportal/domain/Channel"
import type { GameId } from "@sportal/domain/Game"
import type { HighlightId } from "@sportal/domain/Highlight"
import { Schema } from "effect"

/**
 * What a tile shows, as one string the Screen, the shell and a Remote all name it by: a game's stream or data tile is
 * the game's id itself; a custom tile is `custom:` and its stream's id; a stats tile is `stats:` and its game's id; a
 * clip tile is `clip:` and its highlight's id; a channel tile is `channel:`, its source and its live address.
 * Audio focus, solo, the interacting tile and each provider view follow a tile's key, so what a tile shows keeps them
 * when it moves. With `game`, `custom`, `stats`, `clip` and `channel`, which build those keys.
 */
export const TileKey = Object.assign(Schema.String.pipe(Schema.brand("TileKey")), {
  game,
  custom,
  stats,
  clip,
  channel
})
export type TileKey = typeof TileKey.Type

/** A game's tile: the game's id. */
function game(id: GameId): TileKey {
  return TileKey.make(id)
}

/** A custom stream's tile: `custom:` and the stream's id. It takes the id as a string: the id's brand is the web's. */
function custom(id: string): TileKey {
  return TileKey.make(`custom:${id}`)
}

/** The key of game `game`'s stats tile. */
function stats(game: GameId): TileKey {
  return TileKey.make(`stats:${game}`)
}

/** The key of highlight `id`'s clip tile. */
function clip(id: HighlightId): TileKey {
  return TileKey.make(`clip:${id}`)
}

/** A channel's tile: `channel:`, its source, and its live address (a source may list several channels by one name). */
function channel({ source, locator }: Pick<Channel, "source" | "locator">): TileKey {
  return TileKey.make(`channel:${source}:${locator.url}`)
}
