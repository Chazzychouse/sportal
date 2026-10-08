import { Schema } from "effect"

/** One thing a provider delivered, as received, before its decode reads it. */
export class Frame extends Schema.Class<Frame>("sportal/hub/provider/espn/Frame")({
  receivedAt: Schema.DateTimeUtcFromMillis,
  /** Which way the provider delivered it: pushed on its live feed, or polled. */
  source: Schema.Literals(["push", "poll"]),
  /** The league for a poll; the topic, or `socket`, for a push. */
  channel: Schema.String,
  kind: Schema.Literals(["whole", "change"]),
  number: Schema.optional(Schema.Int),
  body: Schema.String
}) {}
