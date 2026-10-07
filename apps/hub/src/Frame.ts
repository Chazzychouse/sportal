import { Schema } from "effect"

/** One thing a feed delivered, as received, before the log numbers it. */
export class FeedFrame extends Schema.Class<FeedFrame>("sportal/hub/FeedFrame")({
  receivedAt: Schema.DateTimeUtcFromMillis,
  sentAt: Schema.optional(Schema.DateTimeUtcFromMillis),
  sourceId: Schema.optional(Schema.Int),
  feed: Schema.Literals(["poll", "fastcast", "snapshot"]),
  /** The league for a poll; the topic, or `socket`, for FastCast. */
  channel: Schema.String,
  kind: Schema.Literals(["response", "message", "checkpoint"]),
  body: Schema.String
}) {}

/** A feed frame as the log numbered it. */
export class Frame extends FeedFrame.extend<Frame>("sportal/hub/Frame")({
  seq: Schema.Int
}) {
  /** Whether `frame` is a poll's response, the only kind the log stores without a body when it repeats. */
  static isPollResponse(frame: Pick<FeedFrame, "feed" | "kind">): boolean {
    return frame.feed === "poll" && frame.kind === "response"
  }
}
