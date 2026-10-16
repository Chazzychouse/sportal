import { Schema } from "effect"
import { GameId } from "./Game.ts"

export const HighlightId = Schema.String.pipe(Schema.brand("HighlightId"))
export type HighlightId = typeof HighlightId.Type

/** A video clip of a game, as its provider publishes it: its headline, its length in seconds, and where it plays. */
export class Highlight extends Schema.Class<Highlight>("sportal/Highlight")({
  id: HighlightId,
  game: GameId,
  headline: Schema.String,
  /** Seconds. */
  duration: Schema.Int,
  /** The clip's mp4: the HD one when the provider has it. */
  video: Schema.String,
  thumbnail: Schema.optionalKey(Schema.String)
}) {
  /** Its length as a person reads it: "1:09". */
  durationText(): string {
    const seconds = this.duration % 60
    return `${Math.floor(this.duration / 60)}:${String(seconds).padStart(2, "0")}`
  }
}
