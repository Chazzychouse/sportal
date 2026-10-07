import { Delivery } from "@sportal/domain/Delivery"
import { Schema } from "effect"

/** The body of a snapshot feed frame, as JSON: one `Delivery`, or a `Resync` of the frame's channel. */
export const SnapshotPayload = Schema.fromJsonString(
  Schema.Union([Delivery, Schema.TaggedStruct("Resync", {})])
)
