import { ChannelAvailability } from "@sportal/domain/Channel"
import { Game } from "@sportal/domain/Game"
import { Screen } from "@sportal/domain/Screen"
import { Schema } from "effect"

/** A message on the live stream at GET /api/live, sent as one JSON object per server-sent event. */
export const LiveMessage = Schema.TaggedUnion({
  /** Every listed game, each beside every source's answer for where it can be streamed. */
  SlateChanged: {
    games: Schema.Array(Schema.Struct({ game: Game, availability: Schema.Array(ChannelAvailability) }))
  },
  ScreenChanged: { screen: Screen }
})
export type LiveMessage = typeof LiveMessage.Type

export type SlateChanged = typeof LiveMessage.cases.SlateChanged.Type

export const LiveMessageJson = Schema.fromJsonString(LiveMessage)
