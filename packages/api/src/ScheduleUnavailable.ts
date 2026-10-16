import { Schema } from "effect"

/** The provider could not be reached for a day, or a game's plays, the Hub does not hold. */
export class ScheduleUnavailable extends Schema.TaggedError<ScheduleUnavailable>()(
  "ScheduleUnavailable",
  {},
  { httpApiStatus: 503 }
) {}
