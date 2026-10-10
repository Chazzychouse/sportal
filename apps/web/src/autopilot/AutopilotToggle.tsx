import type { SlateChanged } from "@sportal/api/LiveMessage"
import type { GameId } from "@sportal/domain/Game"
import type { Slate } from "@sportal/domain/Slate"
import { DateTime, Duration, Option } from "effect"
import { Radar } from "lucide-react"
import { Button } from "@/design/button"
import { type Autopilot, AutopilotStatus } from "./Autopilot.ts"

/** The top bar's autopilot switch: on or off, with what it is doing as its tooltip. */
export function AutopilotToggle(props: {
  autopilot: Autopilot
  slate: Slate
  classifications: SlateChanged["classifications"]
  now: DateTime.Utc
  onToggle: () => void
}) {
  const { autopilot, slate, classifications, now } = props
  const nameOf = (game: GameId) =>
    Option.match(slate.gameOf(game), {
      onNone: () => "a game",
      onSome: ({ snapshot }) => `${snapshot.away.team.abbreviation} @ ${snapshot.home.team.abbreviation}`
    })
  const doing = AutopilotStatus.$match(autopilot.status(now), {
    Off: () => "Autopilot off",
    Idle: () => "Autopilot on: following, nothing to chase",
    Away: ({ game }) =>
      `Autopilot on: away on ${nameOf(game)} — ${whyAway(classifications[game]?.moment._tag)}`,
    Yours: ({ part, until }) =>
      `Autopilot on: ${part === "main" ? "main tile" : "sound"} yours for ${countdown(DateTime.distance(now, until))}`
  })

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-keyshortcuts="A"
      aria-pressed={autopilot.on}
      title={`${doing} · A`}
      className={`label-caps text-xs ${autopilot.on ? "bg-accent" : ""}`}
      onClick={props.onToggle}
    >
      <Radar />
      Auto
      <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">A</kbd>
    </Button>
  )
}

function whyAway(moment: string | undefined): string {
  return moment === "ScoringThreat"
    ? "red zone"
    : moment === "CrunchTime"
      ? "crunch time"
      : "home is on a break"
}

/** A duration as minutes and seconds, `2:41`, rounded up. */
function countdown(left: Duration.Duration): string {
  const seconds = Math.ceil(Duration.toSeconds(left))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
