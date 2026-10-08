import { Game } from "@sportal/domain/Game"
import { Screen } from "@sportal/domain/Screen"
import { Schema } from "effect"

/** A message on the live stream at GET /api/live, sent as one JSON object per server-sent event. */
export const LiveMessage = Schema.TaggedUnion({
  SlateChanged: { games: Schema.Array(Game) },
  ScreenChanged: { screen: Screen }
})
export type LiveMessage = typeof LiveMessage.Type

export type SlateChanged = typeof LiveMessage.cases.SlateChanged.Type

export const LiveMessageJson = Schema.fromJsonString(LiveMessage)
