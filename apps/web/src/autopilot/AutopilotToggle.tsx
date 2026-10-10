import type { SlateChanged } from "@sportal/api/LiveMessage"
import type { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import type { Slate } from "@sportal/domain/Slate"
import { DateTime, Duration, Match, Option } from "effect"
import { Radar } from "lucide-react"
import { useState } from "react"
import { Button } from "@/design/button"
import type { Screen } from "../screen/Screen.ts"
import { type Autopilot, AutopilotStatus } from "./Autopilot.ts"

/** The top bar's autopilot switch: on or off, with what it is doing as its tooltip. */
export function AutopilotToggle(props: {
  autopilot: Autopilot
  slate: Slate
  classifications: SlateChanged["classifications"]
  screen: Screen
  onToggle: () => void
}) {
  const { autopilot, slate, classifications, screen } = props
  const [now, setNow] = useState(DateTime.nowUnsafe)
  const nameOf = (game: GameId) =>
    Option.match(slate.gameOf(game), {
      onNone: () => "a game",
      onSome: ({ snapshot }) => `${snapshot.away.team.abbreviation} @ ${snapshot.home.team.abbreviation}`
    })
  const doing = AutopilotStatus.$match(autopilot.status(now, screen), {
    Off: () => "Autopilot off",
    Idle: () => "Autopilot on: following, nothing to chase",
    Away: ({ part, game }) =>
      `Autopilot on: ${part === "main" ? "" : "sound "}away on ${nameOf(game)}${Option.match(
        whyAway(classifications[game]?.moment),
        {
          onNone: () => "",
          onSome: (why) => ` — ${why}`
        }
      )}`,
    Yours: ({ part, until }) =>
      `Autopilot on: ${partName(part)} yours for ${countdown(DateTime.distance(now, until))}`,
    Fitted: ({ slots }) => `Autopilot on: fitted to ${slots} ${slots === 1 ? "tile" : "tiles"}`
  })

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-keyshortcuts="A"
      aria-pressed={autopilot.on}
      title={`${doing} · A`}
      onPointerEnter={() => setNow(DateTime.nowUnsafe())}
      onFocus={() => setNow(DateTime.nowUnsafe())}
      className={`label-caps text-xs ${autopilot.on ? "bg-accent" : ""}`}
      onClick={props.onToggle}
    >
      <Radar />
      Auto
      <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">A</kbd>
    </Button>
  )
}

function partName(part: "main" | "audio" | "layout"): string {
  return part === "main" ? "main tile" : part === "audio" ? "sound" : "layout"
}

function whyAway(moment: Moment | undefined): Option.Option<string> {
  return Match.value(moment).pipe(
    Match.when({ _tag: "ScoringThreat" }, () => Option.some("red zone")),
    Match.when({ _tag: "CrunchTime" }, () => Option.some("crunch time")),
    Match.whenOr({ _tag: "BigPlay" }, { _tag: "Live" }, () => Option.some("home is on a break")),
    Match.orElse(() => Option.none())
  )
}

/** A duration as minutes and seconds, `2:41`, rounded up. */
function countdown(left: Duration.Duration): string {
  const seconds = Math.ceil(Duration.toSeconds(left))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
