import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Schema } from "effect"

/** What a frame said: a league's listing, one game's snapshot, or one game's whole list of plays. */
export const Delivery = Schema.TaggedUnion({
  Listing: { league: LeagueId, games: Schema.Array(GameSnapshot) },
  Snapshot: { snapshot: GameSnapshot },
  Plays: { game: GameId, plays: Schema.Array(Play) }
})
export type Delivery = typeof Delivery.Type
