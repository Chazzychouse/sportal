import { Schema } from "effect"

/** The provider could not give a game's stats: its summary went unanswered or did not decode. */
export class StatsUnavailable extends Schema.TaggedError<StatsUnavailable>()("StatsUnavailable", {}) {}
