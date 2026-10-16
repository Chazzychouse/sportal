import type { GameId } from "@sportal/domain/Game"
import { Schema } from "effect"

/**
 * What a tile shows, as one string the Screen, the shell and a Remote all name it by: a game's stream or data tile is
 * the game's id itself. Audio focus, solo, the interacting tile and each provider view follow a tile's key, so what a
 * tile shows keeps them when it moves. With `game`, which builds a game's key.
 */
export const TileKey = Object.assign(Schema.String.pipe(Schema.brand("TileKey")), { game })
export type TileKey = typeof TileKey.Type

/** A game's tile: the game's id. */
function game(id: GameId): TileKey {
  return TileKey.make(id)
}
