import { DateTime, Schema } from "effect"
import { DeliverySource } from "./slate/Delivery.ts"

/** One thing a provider delivered, as received, before the log numbers it. */
export class Frame extends Schema.Class<Frame>("sportal/hub/Frame")({
  receivedAt: Schema.DateTimeUtcFromMillis,
  sentAt: Schema.optional(Schema.DateTimeUtcFromMillis),
  source: DeliverySource,
  /** The league for a poll; the topic, or `socket`, for a push. */
  channel: Schema.String,
  kind: Schema.Literals(["whole", "change"]),
  number: Schema.optional(Schema.Int),
  body: Schema.String
}) {
  /** `frame` received at `at` instead, the instant it was sent moved with it. */
  static movedTo(frame: Frame, at: DateTime.Utc): Frame {
    const moved = DateTime.distance(frame.receivedAt, at)
    return new Frame({
      ...frame,
      receivedAt: at,
      ...(frame.sentAt === undefined ? {} : { sentAt: DateTime.addDuration(frame.sentAt, moved) })
    })
  }
}

/** A frame as the feed log numbered it. */
export class LoggedFrame extends Frame.extend<LoggedFrame>("sportal/hub/LoggedFrame")({
  seq: Schema.Int
}) {}
