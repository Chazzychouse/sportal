import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { Frame, type LoggedFrame } from "./Frame.ts"
import { Decoded, Provider } from "./provider/Provider.ts"
import { Delivery } from "./slate/Delivery.ts"

/** The snapshot feed, which tests drive, as a provider that delivers no frame: a decode of our own deliveries. */
export const layer: Layer.Layer<Provider> = layerFrom(Stream.never)

/** The snapshot feed as the provider, delivering `frames`, read by `decode`. */
export function layerFrom(frames: Stream.Stream<Frame>): Layer.Layer<Provider> {
  return Layer.succeed(Provider, Provider.of({ frames, decode }))
}

/**
 * The snapshot feed's decode: each frame is its one delivery, or nothing, one `Decoded` per frame. A body that does not
 * decode is noted `FrameUndecoded` and says nothing.
 */
export function decode(frames: Stream.Stream<LoggedFrame>): Stream.Stream<Decoded> {
  return frames.pipe(
    Stream.mapEffect((frame) =>
      decodePayload(frame.body).pipe(
        Effect.map((payload) =>
          isNothing(payload) ? Decoded.of(frame) : Decoded.of(frame, { deliveries: [payload] })
        ),
        Effect.catch((cause) => Effect.succeed(Decoded.undecodable(frame, cause)))
      )
    )
  )
}

/** The body of a snapshot feed frame, as JSON: one `Delivery`, or `Nothing`, a frame that says nothing. */
const Nothing = Schema.TaggedStruct("Nothing", {})
export const SnapshotPayload = Schema.fromJsonString(Schema.Union([Delivery, Nothing]))
export type SnapshotPayload = typeof SnapshotPayload.Type

/**
 * A snapshot feed frame, received at `at`, that says only `delivery`: a listing as its league's poll response, anything
 * else pushed.
 */
export function framed(delivery: Delivery, at: DateTime.Utc): Frame {
  return Delivery.guards.Listing(delivery)
    ? snapshotFrame(delivery, { source: "poll", channel: delivery.league, kind: "whole" }, at)
    : snapshotFrame(delivery, { source: "push", channel: "snapshot", kind: "change" }, at)
}

/** A snapshot feed frame pushed on `channel`, received at the clock's now, that says `payload`. */
export function pushed(payload: SnapshotPayload, channel: string) {
  return Effect.map(DateTime.now, (at) =>
    snapshotFrame(payload, { source: "push", channel, kind: "change" }, at)
  )
}

function snapshotFrame(
  payload: SnapshotPayload,
  where: Pick<Frame, "source" | "channel" | "kind">,
  receivedAt: DateTime.Utc
): Frame {
  return new Frame({ receivedAt, ...where, body: Schema.encodeSync(SnapshotPayload)(payload) })
}

const isNothing = Schema.is(Nothing)

const decodePayload = Schema.decodeUnknownEffect(SnapshotPayload)
