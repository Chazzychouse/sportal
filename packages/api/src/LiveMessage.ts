import { GameSnapshot } from "@sportal/domain/Game"
import { RecentPlays } from "@sportal/domain/RecentPlays"
import { Stage } from "@sportal/domain/Stage"
import { Schema } from "effect"

/** A message on the live stream at GET /api/live, sent as one JSON object per server-sent event. */
export const LiveMessage = Schema.TaggedUnion({
  SlateChanged: { games: Schema.Array(GameSnapshot), recentPlays: RecentPlays },
  StageChanged: { stage: Stage }
})
export type LiveMessage = typeof LiveMessage.Type

export type SlateChanged = typeof LiveMessage.cases.SlateChanged.Type

export const LiveMessageJson = Schema.fromJsonString(LiveMessage)
