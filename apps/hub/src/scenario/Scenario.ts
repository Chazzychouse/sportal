import { Data, DateTime } from "effect"
import type { FeedFrame } from "../Frame.ts"

/**
 * Games a Hub plays as its provider: a provider's raw frames, in order of receipt, recorded from a window of a game day
 * or written from a scenario script.
 */
export class Scenario extends Data.Class<{
  readonly name: string
  readonly frames: ReadonlyArray<FeedFrame>
}> {
  /** When it starts: its first frame's receipt. */
  origin(): DateTime.Utc {
    return this.frames[0]?.receivedAt ?? DateTime.makeUnsafe(0)
  }
}
