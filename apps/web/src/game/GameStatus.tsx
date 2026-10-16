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

/** A game's status as a list row or a tile shows it: the start time in this browser's zone, else the provider's. */
function statusText(game: GameSnapshot): string {
  return game.status === "scheduled" ? localTime(game.startsAt) : game.statusText
}

/** A time of day as this browser shows it ("1:00 PM"). */
export function localTime(at: DateTime.Utc): string {
  return DateTime.toDateUtc(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}
