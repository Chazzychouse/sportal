import { type GameSnapshot, isLive } from "@sportal/domain/Game"
import { DateTime, Duration } from "effect"

/** How long to wait before the next poll, given what the last one saw. */
export function interval(slate: ReadonlyArray<GameSnapshot>, now: DateTime.Utc): Duration.Duration {
  if (slate.some(isLive)) return Duration.seconds(10)
  const soon = DateTime.add(now, { minutes: 30 })
  const kickoffSoon = slate.some(
    (game) => game.status === "scheduled" && DateTime.isLessThanOrEqualTo(game.kickoff, soon)
  )
  return kickoffSoon ? Duration.minutes(1) : Duration.minutes(15)
}
