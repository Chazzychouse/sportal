import { Effect, Layer } from "effect"
import { Director } from "./Director.ts"
import type { Delivery } from "./slate/Delivery.ts"
import type { Source } from "./source/Source.ts"
import { SnapshotFeed } from "./TestSnapshotFeed.ts"

/** The Director taking the snapshot feed, which is provided too, for a test to deliver to; the test gives the source. */
export const directorOver: Layer.Layer<Director | SnapshotFeed, never, Source> = Director.layer.pipe(
  Layer.provideMerge(SnapshotFeed.layer)
)

/** Delivers one frame that says only `delivery`, and gives the Director's slate once it has taken it. */
export const delivered = Effect.fnUntraced(function* (delivery: Delivery) {
  const feed = yield* SnapshotFeed
  const director = yield* Director

  yield* feed.deliver([delivery])
  return yield* director.slate
})
