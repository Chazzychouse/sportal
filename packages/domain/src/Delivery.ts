import { Schema } from "effect"
import { GameId, GameSnapshot } from "./Game.ts"
import { LeagueId } from "./League.ts"
import { Play } from "./Play.ts"

/** Which feed a snapshot came from. */
export const DeliverySource = Schema.Literals(["push", "poll"])
export type DeliverySource = typeof DeliverySource.Type

/** What a frame said: a league's listing, one game's snapshot, or one game's whole list of plays. */
export const Delivery = Schema.TaggedUnion({
  Listing: { league: LeagueId, games: Schema.Array(GameSnapshot) },
  Snapshot: { snapshot: GameSnapshot, from: DeliverySource },
  Plays: { game: GameId, plays: Schema.Array(Play) }
})
export type Delivery = typeof Delivery.Type
