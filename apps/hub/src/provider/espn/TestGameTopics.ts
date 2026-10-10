import { Effect, Stream } from "effect"
import type { Frame } from "./Frame.ts"
import { GameTopics } from "./GameTopics.ts"

/** What GameTopics gives for each frame, one delivery array per frame. */
export const framesReplayed = Effect.fn("TestGameTopics.framesReplayed")(function* (
  frames: ReadonlyArray<Frame>
) {
  return yield* Stream.fromIterable(frames).pipe(
    Stream.mapAccumEffect(
      () => GameTopics.empty,
      (topics, frame) => Effect.map(topics.take(frame), ([next, deliveries]) => [next, [deliveries]] as const)
    ),
    Stream.runCollect
  )
})

/** The game topics after frames, from none. */
export const topicsAfter = Effect.fn("TestGameTopics.topicsAfter")(function* (frames: ReadonlyArray<Frame>) {
  return yield* Effect.reduce(
    frames,
    () => GameTopics.empty,
    (topics, frame) => Effect.map(topics.take(frame), ([next]) => next)
  )
})
