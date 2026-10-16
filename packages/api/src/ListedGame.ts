import { ChannelAvailability } from "@sportal/domain/Channel"
import { GameSnapshot } from "@sportal/domain/Game"
import { Schema } from "effect"

/** A game as a list or a tile shows it: its snapshot and its availability from every source. Never its plays. */
export const ListedGame = Schema.Struct({
  snapshot: GameSnapshot,
  availability: Schema.Array(ChannelAvailability)
})
export type ListedGame = typeof ListedGame.Type

export const ListedGameJson = Schema.fromJsonString(ListedGame)
