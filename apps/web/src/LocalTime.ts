import { DateTime } from "effect"

/** A time of day as this browser shows it ("1:00 PM"). */
export function localTime(at: DateTime.Utc): string {
  return DateTime.toDateUtc(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}
