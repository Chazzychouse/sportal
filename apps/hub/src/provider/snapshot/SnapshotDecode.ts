import { Effect, Layer, Schema, Stream } from "effect"
import type { Frame } from "../../Frame.ts"
import { Decoder } from "../Decoder.ts"
import { Decoded, Notice } from "../Provider.ts"
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
                ? said(frame, { resyncs: [frame.channel] })
                : said(frame, { deliveries: [payload] })
            ),
            Effect.catch((cause) =>
              Effect.succeed(
                said(frame, {
                  notices: [
                    Notice.FrameUndecoded({
                      feed: frame.feed,
                      channel: frame.channel,
                      kind: frame.kind,
                      cause
                    })
                  ]
                })
              )
            )
          )
        )
      )
  })
)

const decodePayload = Schema.decodeUnknownEffect(SnapshotPayload)

function said(frame: Frame, of: Partial<Pick<Decoded, "deliveries" | "resyncs" | "notices">>): Decoded {
  return new Decoded({
    seq: frame.seq,
    at: frame.receivedAt,
    deliveries: of.deliveries ?? [],
    resyncs: of.resyncs ?? [],
    notices: of.notices ?? []
  })
}
