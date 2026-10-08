import { Effect, Layer } from "effect"
import { Board } from "./slate/Board.ts"
import type { Delivery } from "./slate/Delivery.ts"
import { SnapshotFeed } from "./TestSnapshotFeed.ts"

/** The board taking the snapshot feed, which is provided too, for a test to deliver to. */
export const boardOver: Layer.Layer<Board | SnapshotFeed> = Board.layer.pipe(
  Layer.provideMerge(SnapshotFeed.layer)
)

/** Delivers one frame that says only `delivery`, and gives the board's latest once it has taken it. */
export const delivered = Effect.fnUntraced(function* (delivery: Delivery) {
  const feed = yield* SnapshotFeed
  const board = yield* Board

  yield* feed.deliver([delivery])
  return yield* board.latest
})
