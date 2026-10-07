import { Delivery } from "@sportal/domain/Delivery"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { FeedFrame } from "./Frame.ts"
import { Decoder } from "./provider/Decoder.ts"
import { Decoded, type Polling, Provider, type ProviderError } from "./provider/Provider.ts"

/**
 * The snapshot feed, which tests drive, as the provider: its frames are our own deliveries, read back by `decoder`. A
 * poll of a league is `games(league)` as a frame on that league's channel whose body is its `Listing`. It pushes
 * `push`'s frames, none by default, whatever the demand, subscribed to again on `reconnect` (every second by default),
 * and is polled on `polling`.
 */
export function provider(options: {
  readonly games: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>
  readonly push?: Stream.Stream<FeedFrame, ProviderError>
  readonly polling: Polling
  readonly reconnect?: Schedule.Schedule<unknown, ProviderError>
}): Layer.Layer<Provider> {
  return Layer.succeed(
    Provider,
    Provider.of({
      poll: (league) =>
        Effect.all({ games: options.games(league), receivedAt: DateTime.now }).pipe(
          Effect.flatMap(({ games, receivedAt }) =>
            encodePayload(Delivery.cases.Listing.make({ league, games })).pipe(
              // Our own listing always encodes.
              Effect.orDie,
              Effect.map(
                (body): FeedFrame => ({
                  receivedAt,
                  feed: "snapshot",
                  channel: league,
                  kind: "response",
                  body
                })
              )
            )
          )
        ),
      push: () => options.push ?? Stream.never,
      polling: options.polling,
      reconnect: options.reconnect ?? Schedule.spaced("1 second")
    })
  )
}

/**
 * The snapshot feed's decode as the `Decoder`: each frame is its one delivery, or a resync of its channel, one
 * `Decoded` per frame. A body that does not decode is noted `FrameUndecoded` and says nothing.
 */
export const decoder = Layer.succeed(
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

/** The body of a snapshot feed frame, as JSON: one `Delivery`, or a `Resync` of the frame's channel. */
export const SnapshotPayload = Schema.fromJsonString(
  Schema.Union([Delivery, Schema.TaggedStruct("Resync", {})])
)

/**
 * The snapshot feed as a test's provider: a poll of a league is the games `games` answers. It pushes `options.push`'s
 * frames, none by default, reconnected on `options.reconnect` or the snapshot feed's own, and is polled every 10 seconds
 * unless `options.polling` says otherwise. Tests read its frames with `decoder`.
 */
export function polled(
  games: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>,
  options: {
    readonly polling?: Polling
    readonly push?: Stream.Stream<FeedFrame, ProviderError>
    readonly reconnect?: Schedule.Schedule<unknown, ProviderError>
  } = {}
): Layer.Layer<Provider> {
  return provider({
    games,
    polling: options.polling ?? Schedule.spaced("10 seconds"),
    ...(options.push === undefined ? {} : { push: options.push }),
    ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect })
  })
}

/**
 * A snapshot feed frame, received at `at`, that says only `delivery`: a listing as its league's poll response, anything
 * else pushed.
 */
export function framed(delivery: Delivery, at: DateTime.Utc): FeedFrame {
  return delivery._tag === "Listing"
    ? snapshotFrame(delivery, delivery.league, "response", at)
    : snapshotFrame(delivery, "snapshot", "message", at)
}

/** A snapshot feed frame pushed on `channel`, received at the clock's now, that says `payload`. */
export function pushed(payload: typeof SnapshotPayload.Type, channel: string) {
  return Effect.map(DateTime.now, (at) => snapshotFrame(payload, channel, "message", at))
}

function snapshotFrame(
  payload: typeof SnapshotPayload.Type,
  channel: string,
  kind: FeedFrame["kind"],
  receivedAt: DateTime.Utc
): FeedFrame {
  return new FeedFrame({
    receivedAt,
    feed: "snapshot",
    channel,
    kind,
    body: Schema.encodeSync(SnapshotPayload)(payload)
  })
}

const encodePayload = Schema.encodeEffect(SnapshotPayload)

const decodePayload = Schema.decodeUnknownEffect(SnapshotPayload)
