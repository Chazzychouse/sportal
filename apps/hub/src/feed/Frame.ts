import { Schema } from "effect"

/** One thing a feed delivered, as received, before the log numbers it. */
export class Frame extends Schema.Class<Frame>("sportal/hub/Frame")({
  seq: Schema.Int,
  receivedAt: Schema.DateTimeUtcFromMillis,
  sentAt: Schema.optional(Schema.DateTimeUtcFromMillis),
  sourceId: Schema.optional(Schema.Int),
  feed: Schema.Literals(["poll", "fastcast"]),
  /** The league for a poll; the topic, or `socket`, for FastCast. */
  channel: Schema.String,
  kind: Schema.Literals(["response", "message", "checkpoint"]),
  body: Schema.String
}) {}
