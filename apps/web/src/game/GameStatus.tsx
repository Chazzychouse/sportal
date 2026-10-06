import type { GameSnapshot } from "@sportal/domain/Game"
import { DateTime } from "effect"
import { cn } from "@/design/ClassName"

/** A game's status as a small-caps label, in the live colour while the game is on. `className` sizes and places it. */
export function GameStatus(props: { game: GameSnapshot; className?: string }) {
  return (
    <span
      className={cn(
        "label-caps",
        props.game.progress() === "live" ? "text-live" : "text-muted-foreground",
        props.className
      )}
    >
      {statusText(props.game)}
    </span>
  )
}

/** A game's status as a slate row or a tile shows it: the period and clock, the kickoff, or the status in a word. */
export function statusText(game: GameSnapshot): string {
  switch (game.status) {
    case "live":
      return `${periodName(game.period)} ${game.clock}`
    case "scheduled":
      return localTime(game.kickoff)
    case "halftime":
      return "Half"
    case "delayed":
      return "Delayed"
    case "final":
      return game.inOvertime() ? "Final/OT" : "Final"
    case "postponed":
      return "Postponed"
    case "canceled":
      return "Canceled"
  }
}

/** A time of day as this browser shows it ("1:00 PM"). */
export function localTime(at: DateTime.Utc): string {
  return DateTime.toDateUtc(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function periodName(period: number): string {
  if (period < 5) return `Q${period}`
  return period === 5 ? "OT" : `${period - 4}OT`
}
