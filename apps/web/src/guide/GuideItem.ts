import type { GameId } from "@sportal/domain/Game"
import { Data } from "effect"

/** One thing on a shelf of the Display's guide: a game, for now. */
export type GuideItem = Data.TaggedEnum<{
  Game: { readonly game: GameId }
}>
export const GuideItem = Data.taggedEnum<GuideItem>()
