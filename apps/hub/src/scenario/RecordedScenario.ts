import { Data, DateTime } from "effect"
import type { FeedFrame } from "../Frame.ts"

/** A scenario kept as the raw frames of a recorded window, in order of receipt. */
export class RecordedScenario extends Data.Class<{
  readonly name: string
  readonly frames: ReadonlyArray<FeedFrame>
}> {
  /** When it starts: its first frame's receipt. */
  origin(): DateTime.Utc {
    return this.frames[0]?.receivedAt ?? DateTime.makeUnsafe(0)
  }
}
