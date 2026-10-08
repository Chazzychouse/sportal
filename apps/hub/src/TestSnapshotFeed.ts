import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { Frame } from "./Frame.ts"
import { Decoded, Decoder } from "./provider/Decoder.ts"
import { type Polling, Provider, type ProviderUnavailable } from "./provider/Provider.ts"
import { Delivery } from "./slate/Delivery.ts"

/**
 * The snapshot feed, which tests drive, as the provider: its frames are our own deliveries, read back by `layerDecoder`. A
 * poll of a league is `games(league)` as a frame on that league's channel whose body is its `Listing`. It is polled on
 * `polling` (every 10 seconds by default), pushes `push`'s frames, none by default, whatever the demand, and is
 * subscribed to again on `reconnect` (every second by default).
 */
export function layer(options: {
  readonly games: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderUnavailable>
  readonly polling?: Polling
  readonly push?: Stream.Stream<Frame, ProviderUnavailable>
  readonly reconnect?: Schedule.Schedule<unknown, ProviderUnavailable>
}): Layer.Layer<Provider> {
  return Layer.succeed(
    Provider,
    Provider.of({
      poll: Effect.fnUntraced(function* (league: LeagueId) {
        const games = yield* options.games(league)
        const receivedAt = yield* DateTime.now
        return framed(Delivery.cases.Listing.make({ league, games }), receivedAt)
      }),
      push: () => options.push ?? Stream.never,
      polling: options.polling ?? Schedule.spaced("10 seconds"),
      reconnect: options.reconnect ?? Schedule.spaced("1 second")
    })
  )
}

/**
 * The snapshot feed's decode as the `Decoder`: each frame is its one delivery, or a resync of its channel, one
 * `Decoded` per frame. A body that does not decode is noted `FrameUndecoded` and says nothing.
 */
export const layerDecoder = Layer.succeed(
  Decoder,
  Decoder.of({
    decode: (frames) =>
      frames.pipe(
        Stream.mapEffect((frame) =>
          decodePayload(frame.body).pipe(
            Effect.map((payload) =>
              isResync(payload)
                ? Decoded.of(frame, { resyncs: [frame.channel] })
                : Decoded.of(frame, { deliveries: [payload] })
            ),
            Effect.catch((cause) => Effect.succeed(Decoded.undecodable(frame, cause)))
          )
        )
      )
  })
)

/** The body of a snapshot feed frame, as JSON: one `Delivery`, or a `Resync` of the frame's channel. */
const Resync = Schema.TaggedStruct("Resync", {})
export const SnapshotPayload = Schema.fromJsonString(Schema.Union([Delivery, Resync]))
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

const isResync = Schema.is(Resync)

const decodePayload = Schema.decodeUnknownEffect(SnapshotPayload)
