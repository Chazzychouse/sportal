import type { GameId } from "@sportal/domain/Game"
import { Data } from "effect"
import type { CustomStream } from "../custom/CustomStream.ts"

/** One thing on a shelf of the Display's guide: a game, a saved custom stream, or the card that adds one. */
export type GuideItem = Data.TaggedEnum<{
  Game: { readonly game: GameId }
  /** A saved custom stream's card, under the Custom entry. */
  Custom: { readonly stream: CustomStream }
  /** The last card under Custom: it opens the YouTube form. */
  AddCustom: object
}>
export const GuideItem = Data.taggedEnum<GuideItem>()
