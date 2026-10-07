import { Effect } from "effect"
import { FeedLog } from "./FeedLog.ts"
import type { FeedFrame } from "./Frame.ts"

/** `frames` appended through a feed log of their own, closed before the test goes on, so every one is written. */
export function logged(frames: ReadonlyArray<FeedFrame>) {
  return FeedLog.use((log) => Effect.forEach(frames, log.append, { discard: true })).pipe(
    Effect.provide(FeedLog.layer),
    Effect.scoped
  )
}
