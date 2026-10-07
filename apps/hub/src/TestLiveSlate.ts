import { NodeCrypto } from "@effect/platform-node"
import type { Delivery } from "@sportal/domain/Delivery"
import type { GameEvent } from "@sportal/domain/GameEvent"
import { Slate } from "@sportal/domain/Slate"
import type { SlateObservation } from "@sportal/domain/SlateObservation"
import { DateTime, Effect, Layer } from "effect"
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

/**
 * Appends a snapshot feed frame that says only `delivery`, received at `at` (the clock's now, unless given), and gives
 * the slate once it has taken it.
 */
export function delivered(delivery: Delivery, at?: DateTime.Utc) {
  return Effect.gen(function* () {
    const feedLog = yield* FeedLog
    const liveSlate = yield* LiveSlate
    const received = yield* at === undefined ? DateTime.now : Effect.succeed(at)
    const frame = yield* feedLog.append(TestSnapshotFeed.framed(delivery, received))
    return yield* liveSlate.through(frame.seq)
  })
}

/** Every game event and observation the domain slate makes taking `frames` whole, in order, as the provided `Decoder` reads them. */
export function takenOf(frames: ReadonlyArray<FeedFrame>) {
  return Effect.gen(function* () {
    const empty: {
      readonly slate: Slate
      readonly events: ReadonlyArray<GameEvent>
      readonly observations: ReadonlyArray<SlateObservation>
    } = { slate: Slate.empty, events: [], observations: [] }
    const { events, observations } = yield* Effect.reduce(
      yield* decodedFrames(frames),
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
