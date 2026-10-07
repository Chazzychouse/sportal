import { NodeCrypto } from "@effect/platform-node"
import type { Delivery } from "@sportal/domain/Delivery"
import type { GameEvent } from "@sportal/domain/GameEvent"
import { Slate } from "@sportal/domain/Slate"
import type { SlateObservation } from "@sportal/domain/SlateObservation"
import { type Crypto, DateTime, Effect, Layer } from "effect"
import type { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import { FeedLog } from "./FeedLog.ts"
import type { FeedFrame } from "./Frame.ts"
import { LiveSlate } from "./LiveSlate.ts"
import type { Decoder } from "./provider/Decoder.ts"
import { decodedFrames } from "./provider/TestDecoder.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"

/**
 * The slate following a feed log in memory, which is provided too, for a test to append to. `frames` are logged
 * before the slate starts, so they are replayed. Frames are read by the snapshot feed's decode unless
 * `options.decoder` is given, and the game day is read in `options.zone`, the local one unless given.
 */
export function slateFollowing(
  frames: ReadonlyArray<FeedFrame> = [],
  options: { readonly decoder?: Layer.Layer<Decoder>; readonly zone?: DateTime.TimeZone } = {}
): Layer.Layer<LiveSlate | FeedLog> {
  // Appended through a log of their own, closed before the slate's log opens, so every one is written.
  const logged = Layer.effectDiscard(
    FeedLog.use((log) => Effect.forEach(frames, log.append, { discard: true })).pipe(
      Effect.provide(FeedLog.layer),
      Effect.scoped
    )
  )
  return LiveSlate.layer.pipe(
    Layer.provideMerge(FeedLog.layer.pipe(Layer.provide(logged))),
    Layer.provide([
      options.decoder ?? TestSnapshotFeed.decoder,
      options.zone === undefined ? DateTime.layerCurrentZoneLocal : DateTime.layerCurrentZone(options.zone)
    ]),
    Layer.provide([Database.at(":memory:"), NodeCrypto.layer]),
    Layer.orDie
  )
}

/** `slateFollowing` the frames `frames` makes when the layer is built, received at the clock's now if they are made so. */
export function slateFollowingMade<E>(
  frames: Effect.Effect<ReadonlyArray<FeedFrame>, E>,
  options: { readonly decoder?: Layer.Layer<Decoder>; readonly zone?: DateTime.TimeZone } = {}
) {
  return Layer.unwrap(Effect.map(frames, (made) => slateFollowing(made, options)))
}

/** The slate following `feedLog`, which is provided too, read by `decoder`, in the local zone. */
export function slateOn(
  feedLog: Layer.Layer<FeedLog, never, SqlClient.SqlClient | Crypto.Crypto>,
  decoder: Layer.Layer<Decoder>
) {
  return LiveSlate.layer.pipe(
    Layer.provideMerge(feedLog),
    Layer.provide([decoder, DateTime.layerCurrentZoneLocal])
  )
}

/** The slate's latest once `layer` is built. */
export function latestOf<E, R>(layer: Layer.Layer<LiveSlate, E, R>) {
  return LiveSlate.use((slate) => slate.latest).pipe(Effect.provide(layer))
}

/** Appends `frame` to the feed log and gives the slate once it has taken it. */
export function appended(frame: FeedFrame) {
  return Effect.gen(function* () {
    const feedLog = yield* FeedLog
    const liveSlate = yield* LiveSlate
    const logged = yield* feedLog.append(frame)
    return yield* liveSlate.through(logged.seq)
  })
}

/**
 * Appends a snapshot feed frame that says only `delivery`, received at `at` (the clock's now, unless given), and gives
 * the slate once it has taken it.
 */
export function delivered(delivery: Delivery, at?: DateTime.Utc) {
  return Effect.gen(function* () {
    const received = yield* at === undefined ? DateTime.now : Effect.succeed(at)
    return yield* appended(TestSnapshotFeed.framed(delivery, received))
  })
}

/**
 * Appends each of `frames` once the test clock reaches it and waits for the slate to take it, so the timer runs
 * between them as it would live.
 */
export function takenInTime(frames: ReadonlyArray<FeedFrame>) {
  return Effect.forEach(
    frames,
    (frame) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* TestClock.adjust(DateTime.distance(now, frame.receivedAt))
        yield* appended(frame)
      }),
    { discard: true }
  )
}

/** Every game event and observation the domain slate makes taking `frames` whole, in order, as the provided `Decoder` reads them. */
export function takenOf(frames: ReadonlyArray<FeedFrame>) {
  return Effect.gen(function* () {
    const empty: {
      readonly slate: Slate
      readonly events: ReadonlyArray<GameEvent>
      readonly observations: ReadonlyArray<SlateObservation>
    } = { slate: Slate.empty, events: [], observations: [] }
    const decoded = yield* decodedFrames(frames)
    const { events, observations } = yield* Effect.reduce(
      decoded,
      () => empty,
      ({ slate, events, observations }, said) =>
        Effect.map(slate.take(said), (taken) => ({
          slate: taken.next,
          events: [...events, ...taken.events],
          observations: [...observations, ...taken.observations]
        }))
    )
    return { events, observations }
  })
}
