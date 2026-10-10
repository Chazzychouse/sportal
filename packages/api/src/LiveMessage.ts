import { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId } from "@sportal/domain/Game"
import { Slate } from "@sportal/domain/Slate"
import { Schema } from "effect"

/** A message on the live stream at GET /api/live, sent as one JSON object per server-sent event. */
export const LiveMessage = Schema.TaggedUnion({
  /** The slate, each game with its recent plays, and each listed game's availability from every source, by its id. */
  SlateChanged: {
    slate: Slate,
    availability: Schema.Record(GameId, Schema.Array(ChannelAvailability))
  }
})
export type LiveMessage = typeof LiveMessage.Type

export type SlateChanged = typeof LiveMessage.cases.SlateChanged.Type

export const LiveMessageJson = Schema.fromJsonString(LiveMessage)
