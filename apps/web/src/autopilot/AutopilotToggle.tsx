import type { SlateChanged } from "@sportal/api/LiveMessage"
import type { Slate } from "@sportal/domain/Slate"
import { DateTime, Duration, Option } from "effect"
import { Radar } from "lucide-react"
import { useState } from "react"
import { Button } from "@/design/button"
import type { Screen } from "../screen/Screen.ts"
import { type Autopilot, AutopilotStatus, type Part } from "./Autopilot.ts"
import { nameIn } from "./AutopilotState.ts"
import { label } from "./Ranking.ts"

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
  const nameOf = nameIn(slate)
  const doing = AutopilotStatus.$match(autopilot.status(now, screen, classifications), {
    Off: () => "Autopilot off",
    Yours: ({ part, until }) =>
      `Autopilot on: ${partName(part)} yours for ${countdown(DateTime.distance(now, until))}`,
    NothingLive: ({ fitted }) => `Autopilot on: following, nothing live${fittedWords(fitted)}`,
    Following: ({ game, rank, fitted }) =>
      `Autopilot on: following ${nameOf(game)} — ${label(rank)}${fittedWords(fitted)}`
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

function partName(part: Part): string {
  return part === "main" ? "main tile" : part === "audio" ? "sound" : "layout"
}

/** `, fitted to 2 tiles` for a layout fitted below the ceiling; nothing otherwise. */
function fittedWords(fitted: Option.Option<number>): string {
  return Option.match(fitted, {
    onNone: () => "",
    onSome: (slots) => `, fitted to ${slots} ${slots === 1 ? "tile" : "tiles"}`
  })
}

/** A duration as minutes and seconds, `2:41`, rounded up. */
function countdown(left: Duration.Duration): string {
  const seconds = Math.ceil(Duration.toSeconds(left))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
