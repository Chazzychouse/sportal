import { Effect, Layer, Schema, Stream } from "effect"
import { Decoder } from "../Decoder.ts"
import { Decoded } from "../Provider.ts"
import { SnapshotPayload } from "./SnapshotPayload.ts"

/**
 * The snapshot feed's decode as the `Decoder`: each frame is its one delivery, or a resync of its channel, one
 * `Decoded` per frame. A body that does not decode is noted `FrameUndecoded` and says nothing.
 */
export const layer = Layer.succeed(
  Decoder,
  Decoder.of({
    decode: (frames) =>
      frames.pipe(
        Stream.mapEffect((frame) =>
          decodePayload(frame.body).pipe(
            Effect.map((payload) =>
              payload._tag === "Resync"
                ? Decoded.of(frame, { resyncs: [frame.channel] })
                : Decoded.of(frame, { deliveries: [payload] })
            ),
            Effect.catch((cause) => Effect.succeed(Decoded.undecodable(frame, cause)))
          )
        )
      )
  })
)

const decodePayload = Schema.decodeUnknownEffect(SnapshotPayload)
