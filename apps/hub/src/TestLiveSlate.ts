import { NodeCrypto } from "@effect/platform-node"
import type { GameEvent } from "@sportal/domain/GameEvent"
import { DateTime, Effect, Layer } from "effect"
import * as Database from "./Database.ts"
import type { Frame } from "./Frame.ts"
import { FeedLog } from "./feed-log/FeedLog.ts"
import { LiveSlate } from "./LiveSlate.ts"
import type { Decoder } from "./provider/Decoder.ts"
import { decodedFrames } from "./provider/TestDecoder.ts"
import type { Delivery } from "./slate/Delivery.ts"
import { Slate } from "./slate/Slate.ts"
import type { SlateObservation } from "./slate/SlateObservation.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"

/**
 * The slate following a feed log in memory, which is provided too, for a test to append to. `frames` are logged
 * before the slate starts, so they are replayed. Frames are read by the snapshot feed's decode unless
 * `options.decoder` is given, and the game day is read in `options.zone`, the local one unless given.
 */
export function slateFollowing(
  frames: ReadonlyArray<Frame> = [],
  options: { readonly decoder?: Layer.Layer<Decoder>; readonly zone?: DateTime.TimeZone } = {}
): Layer.Layer<LiveSlate | FeedLog> {
  return LiveSlate.layer.pipe(
    Layer.provideMerge(FeedLog.layerTest(frames)),
    Layer.provide([
      options.decoder ?? TestSnapshotFeed.layerDecoder,
      options.zone === undefined ? DateTime.layerCurrentZoneLocal : DateTime.layerCurrentZone(options.zone)
    ]),
    Layer.provide([Database.layerMemory, NodeCrypto.layer]),
    Layer.orDie
  )
}

/** The slate's latest once `layer` is built. */
export function latestOf<E, R>(layer: Layer.Layer<LiveSlate, E, R>) {
  return LiveSlate.use((slate) => slate.latest).pipe(Effect.provide(layer))
}

/** Appends `frame` to the feed log and gives the slate once it has taken it. */
export const appended = Effect.fnUntraced(function* (frame: Frame) {
  const feedLog = yield* FeedLog
  const liveSlate = yield* LiveSlate
  const logged = yield* feedLog.append(frame)
  return yield* liveSlate.through(logged.seq)
})

/**
 * Appends a snapshot feed frame that says only `delivery`, received at `at` (the clock's now, unless given), and gives
 * the slate once it has taken it.
 */
export const delivered = Effect.fnUntraced(function* (delivery: Delivery, at?: DateTime.Utc) {
  const now = yield* DateTime.now
  return yield* appended(TestSnapshotFeed.framed(delivery, at ?? now))
})

/** Every game event and observation the domain slate makes taking `frames` whole, in order, as the provided `Decoder` reads them. */
export const takenOf = Effect.fnUntraced(function* (frames: ReadonlyArray<Frame>) {
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
