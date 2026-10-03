import { type ChannelCarriage, ChannelLineup, ChannelUrlRefused } from "@sportal/domain/Source"
import { Effect, Layer, Schema, SchemaTransformation, Stream, SubscriptionRef } from "effect"
import { ChannelStore } from "./ChannelStore.ts"
import { Source } from "./Source.ts"

/** YouTube TV as a source. Its channels are learned from the live guide and kept in the channel store. */
export const layer = Layer.effect(
  Source,
  Effect.gen(function* () {
    const store = yield* ChannelStore
    const lineup = yield* SubscriptionRef.make(
      new ChannelLineup({ source: "YouTube TV", guide, carriages: yield* store.carriages })
    )

    // Store first, then memory, one write at a time: a failed write changes nothing.
    const record = (carriage: ChannelCarriage) =>
      SubscriptionRef.updateEffect(lineup, (current) =>
        store.record(carriage).pipe(Effect.as(current.record(carriage)))
      )

    return Source.of({
      lineup: SubscriptionRef.get(lineup),
      // The ref's current value comes first on every subscription; only later values are changes.
      changes: SubscriptionRef.changes(lineup).pipe(Stream.drop(1), Stream.as(undefined)),
      learn: (network, url) =>
        decodeLiveChannelUrl(url).pipe(
          Effect.mapError(() => new ChannelUrlRefused()),
          Effect.flatMap((live) =>
            record({
              _tag: "Carried",
              network,
              channel: { name: network, source: "YouTube TV", locator: { _tag: "WebView", url: live } }
            })
          )
        ),
      markNotCarried: (network) => record({ _tag: "NotCarried", network, source: "YouTube TV" }),
      forget: (network) =>
        SubscriptionRef.updateEffect(lineup, (current) =>
          store.forget(network, "YouTube TV").pipe(Effect.as(current.forget(network)))
        )
    })
  })
)

/**
 * A YouTube TV channel address, decoded to the address that plays the channel live. A guide pick can
 * carry a start point ("from the beginning"); keeping it would replay every later game on the channel
 * from that moment, so decoding keeps only the channel's id and the live flag.
 */
export const LiveChannelUrl = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^https:\/\/tv\.youtube\.com\/watch\/[A-Za-z0-9_-]+(\?.*)?$/)),
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (url) => `https://tv.youtube.com${new URL(url).pathname}?vp=${live}`,
      encode: (url) => url
    })
  )
)

const decodeLiveChannelUrl = Schema.decodeEffect(LiveChannelUrl)

const live = "0gEEEgIwAQ%3D%3D"

const guide = { _tag: "WebView", url: "https://tv.youtube.com/live" } as const
