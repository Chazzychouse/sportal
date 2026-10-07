import { NodeCrypto } from "@effect/platform-node"
import type { Delivery } from "@sportal/domain/Delivery"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect, Layer, Schedule, Schema, Stream } from "effect"
import * as Database from "./Database.ts"
import { FeedLog } from "./FeedLog.ts"
import { FeedFrame, Frame } from "./Frame.ts"
import { LiveGames } from "./LiveGames.ts"
import { Decoder } from "./provider/Decoder.ts"
import * as EspnScript from "./provider/espn/EspnScript.ts"
import { type Polling, Provider, type ProviderError } from "./provider/Provider.ts"
import { Scenario } from "./scenario/Scenario.ts"
import { scripts } from "./scenario/written/Scripts.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"

/**
 * The snapshot feed as a test's provider: a poll of a league is the games `games` answers. It pushes `options.push`'s
 * frames, none by default, reconnected on `options.reconnect` or the snapshot feed's own, and is polled every 10 seconds
 * unless `options.polling` says otherwise. Tests read its frames with `TestSnapshotFeed.decoder`.
 */
export function polled(
  games: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>,
  options: {
    readonly polling?: Polling
    readonly push?: Stream.Stream<FeedFrame, ProviderError>
    readonly reconnect?: Schedule.Schedule<unknown, ProviderError>
  } = {}
): Layer.Layer<Provider> {
  return TestSnapshotFeed.provider({
    games,
    polling: options.polling ?? Schedule.spaced("10 seconds"),
    ...(options.push === undefined ? {} : { push: options.push }),
    ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect })
  })
}

/**
 * The live games following a feed log in memory, which is provided too, for a test to append to. `frames` are logged
 * before the live games start, so they are replayed. Frames are read by the snapshot feed's decode unless
 * `options.decoder` is given, and the game day is read in `options.zone`, the local one unless given.
 */
export function liveGames(
  frames: ReadonlyArray<FeedFrame> = [],
  options: { readonly decoder?: Layer.Layer<Decoder>; readonly zone?: DateTime.TimeZone } = {}
): Layer.Layer<LiveGames | FeedLog> {
  // Appended through a log of their own, closed before the live games' log opens, so every one is written.
  const logged = Layer.effectDiscard(
    FeedLog.use((log) => Effect.forEach(frames, log.append, { discard: true })).pipe(
      Effect.provide(FeedLog.layer),
      Effect.scoped
    )
  )
  return LiveGames.layer.pipe(
    Layer.provideMerge(FeedLog.layer.pipe(Layer.provide(logged))),
    Layer.provide([
      options.decoder ?? TestSnapshotFeed.decoder,
      options.zone === undefined ? DateTime.layerCurrentZoneLocal : DateTime.layerCurrentZone(options.zone)
    ]),
    Layer.provide([Database.at(":memory:"), NodeCrypto.layer]),
    Layer.orDie
  )
}

/** The snapshot feed's decode, which dies at a frame whose body is `body`. */
export function dyingAt(body: string): Layer.Layer<Decoder> {
  return Layer.effect(
    Decoder,
    Effect.map(Decoder, (decoder) =>
      Decoder.of({
        decode: (frames) =>
          decoder.decode(
            frames.pipe(
              Stream.tap((frame) => (frame.body === body ? Effect.die("decode died") : Effect.void))
            )
          )
      })
    )
  ).pipe(Layer.provide(TestSnapshotFeed.decoder))
}

/**
 * Appends a snapshot feed frame that says only `delivery`, received at `at` (the clock's now, unless given), and gives
 * the live games once they have taken it.
 */
export function delivered(delivery: Delivery, at?: DateTime.Utc) {
  return Effect.gen(function* () {
    const frame = yield* (yield* FeedLog).append(framed(delivery, at ?? (yield* DateTime.now)))
    return yield* (yield* LiveGames).through(frame.seq)
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
export function pushed(payload: typeof TestSnapshotFeed.SnapshotPayload.Type, channel: string) {
  return Effect.map(DateTime.now, (at) => snapshotFrame(payload, channel, "message", at))
}

function snapshotFrame(
  payload: typeof TestSnapshotFeed.SnapshotPayload.Type,
  channel: string,
  kind: FeedFrame["kind"],
  receivedAt: DateTime.Utc
): FeedFrame {
  return new FeedFrame({
    receivedAt,
    feed: "snapshot",
    channel,
    kind,
    body: Schema.encodeSync(TestSnapshotFeed.SnapshotPayload)(payload)
  })
}

/** The games one poll of `league` lists, as the provided `Decoder` reads it. */
export function listedBy(league: LeagueId) {
  return Effect.gen(function* () {
    const said = yield* decodedFrames([yield* (yield* Provider).poll(league)])
    return said.flatMap((one) =>
      one.deliveries.flatMap((delivery) => (delivery._tag === "Listing" ? delivery.games : []))
    )
  })
}

/** What the provided `Decoder` says each of `frames` said, numbered from 1. */
export function decodedFrames(frames: ReadonlyArray<FeedFrame>) {
  return Decoder.use((decoder) =>
    decoder
      .decode(Stream.fromIterable(frames.map((frame, index) => new Frame({ ...frame, seq: index + 1 }))))
      .pipe(Stream.runCollect)
  )
}

/** The written scenarios as `HubMode` plays them: each script written as ESPN's frames. */
export const writtenScenarios = [...scripts.values()].map(
  (script) => new Scenario({ name: script.name, frames: EspnScript.framesOf(script) })
)
