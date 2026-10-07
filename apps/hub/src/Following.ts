import { Data } from "effect"

/**
 * Where the live slate is in following the feed log: catching up on the day before the Hub serves, live, or halted by a
 * decode defect, when no new frame is taken but the timer still runs and is told.
 */
export type Following = Data.TaggedEnum<{ Replaying: object; Live: object; Halted: object }>
export const Following = Data.taggedEnum<Following>()
