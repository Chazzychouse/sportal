import { GameSnapshot } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { Schema } from "effect"

/** A message on the live stream at GET /api/live, sent as one JSON object per server-sent event. */
export const LiveMessage = Schema.Union([
  Schema.TaggedStruct("SlateChanged", { slate: Schema.Array(GameSnapshot) }),
  Schema.TaggedStruct("StageChanged", { stage: Stage })
])
export type LiveMessage = typeof LiveMessage.Type

export const LiveMessageJson = Schema.fromJsonString(LiveMessage)
