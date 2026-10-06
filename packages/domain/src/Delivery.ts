import { Data, Schema } from "effect"
import type { GameId, GameSnapshot } from "./Game.ts"
import type { LeagueId } from "./League.ts"
import type { Play } from "./Play.ts"

/** What a frame said: a league's listing, one game's snapshot, or one game's whole list of plays. */
export type Delivery = Data.TaggedEnum<{
  Listing: { readonly league: LeagueId; readonly games: ReadonlyArray<GameSnapshot> }
  Snapshot: { readonly snapshot: GameSnapshot; readonly from: DeliverySource }
  Plays: { readonly game: GameId; readonly plays: ReadonlyArray<Play> }
}>
export const Delivery = Data.taggedEnum<Delivery>()

/** Which feed a snapshot came from. */
export const DeliverySource = Schema.Literals(["push", "poll"])
export type DeliverySource = typeof DeliverySource.Type
