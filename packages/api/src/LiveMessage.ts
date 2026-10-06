import { GameSnapshot } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { Watchability } from "@sportal/domain/Watchability"
import { Schema, Struct } from "effect"

/** A message on the live stream at GET /api/live, sent as one JSON object per server-sent event. */
export const LiveMessage = Schema.Union([
  Schema.TaggedStruct("SlateChanged", {
    slate: Schema.Array(
      Schema.Struct({
        game: GameSnapshot,
        watchability: Schema.Struct(Struct.pick(Watchability.fields, ["score", "lull", "reasons"]))
      })
    )
  }),
  Schema.TaggedStruct("StageChanged", { stage: Stage })
])
export type LiveMessage = typeof LiveMessage.Type

export const LiveMessageJson = Schema.fromJsonString(LiveMessage)
