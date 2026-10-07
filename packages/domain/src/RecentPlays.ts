import { Schema } from "effect"
import { GameId } from "./Game.ts"
import { Play } from "./Play.ts"

/** Each game's last ten plays, in `Play.order`, sent with the slate. A game with no plays is not a key. */
export const RecentPlays = Schema.Record(GameId, Schema.Array(Play))
export type RecentPlays = typeof RecentPlays.Type
