import type { GameSnapshot } from "@sportal/domain/Game"
import { DateTime, Duration } from "effect"

/**
 * How long to wait before the next poll, given what the last one saw. When any provider call in that
 * poll failed (`anyFailed`), the wait is capped at 30 seconds so a missing or stale slate is retried
 * soon, whatever the slate looks like; a live slate still polls every 10 seconds.
 */
export function interval(
  slate: ReadonlyArray<GameSnapshot>,
  now: DateTime.Utc,
  anyFailed: boolean
): Duration.Duration {
  const normal = normalInterval(slate, now)
  return anyFailed ? Duration.min(normal, Duration.seconds(30)) : normal
}

function normalInterval(slate: ReadonlyArray<GameSnapshot>, now: DateTime.Utc): Duration.Duration {
  if (slate.some((game) => game.isLive())) return Duration.seconds(10)
  const soon = DateTime.add(now, { minutes: 30 })
  const kickoffSoon = slate.some(
    (game) => game.status === "scheduled" && DateTime.isLessThanOrEqualTo(game.kickoff, soon)
  )
  return kickoffSoon ? Duration.minutes(1) : Duration.minutes(15)
}
