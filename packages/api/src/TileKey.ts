import type { GameId } from "@sportal/domain/Game"
import { Schema } from "effect"

/**
 * What a tile shows, as one string the Screen, the shell and a Remote all name it by: a game's stream or data tile is
 * the game's id itself; a custom tile is `custom:` and its stream's id. Audio focus, solo, the interacting tile and
 * each provider view follow a tile's key, so what a tile shows keeps them when it moves. With `game` and `custom`,
 * which build those keys.
 */
export const TileKey = Object.assign(Schema.String.pipe(Schema.brand("TileKey")), { game, custom })
export type TileKey = typeof TileKey.Type

/** A game's tile: the game's id. */
function game(id: GameId): TileKey {
  return TileKey.make(id)
}

/** A custom stream's tile: `custom:` and the stream's id. It takes the id as a string: the id's brand is the web's. */
function custom(id: string): TileKey {
  return TileKey.make(`custom:${id}`)
}
