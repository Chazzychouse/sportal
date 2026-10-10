import type { Classification } from "@sportal/domain/Classification"
import { type BreakReason, Moment } from "@sportal/domain/Moment"
import { Flag, Timer, Zap } from "lucide-react"
import { cn } from "@/design/ClassName"
import { localTime } from "./GameStatus.tsx"

/**
 * A game's moment as a small mark — a flag in the red zone, a clock in crunch time, a bolt after a big play, BRK in a
 * break, with what was at stake — titled with its score, the points each part gave it, and for a break its reason and
 * when it is likely back.
 */
export function MomentBadge(props: { classification: Classification | undefined; className?: string }) {
  const { classification } = props
  if (classification === undefined) return null
  const mark = markOf(classification)
  if (mark === null) return null

  const { prior, closeness, swing, upset, momentBonus } = classification.breakdown
  const { moment } = classification
  const stopped =
    moment._tag === "Break"
      ? ` — ${reasonText[moment.reason]}, back about ${localTime(moment.expectedEnd)}`
      : ""
  const title = `Score ${classification.score}: matchup ${points(prior)}, closeness ${points(closeness)}, swing ${points(swing)}, upset ${points(upset)}, moment ${points(momentBonus)}${stopped}`
  return (
    <span title={title} className={cn("inline-flex shrink-0 items-center", props.className)}>
      {mark}
    </span>
  )
}

function markOf(classification: Classification) {
  return Moment.match(classification.moment, {
    ScoringThreat: () => <Flag aria-label="Red zone" className="size-3 text-on-air" />,
    CrunchTime: () => <Timer aria-label="Crunch time" className="size-3 text-on-air" />,
    BigPlay: () => <Zap aria-label="Big play" className="size-3 text-on-air" />,
    Break: ({ during }) => (
      <span className="label-caps text-[9px] text-muted-foreground">
        {during === undefined ? "BRK" : `BRK · ${during._tag === "ScoringThreat" ? "RZ" : "CT"}`}
      </span>
    ),
    Live: () => null,
    Upcoming: () => null,
    Final: () => null
  })
}

function points(value: number): string {
  return `${value >= 0 ? "+" : ""}${Math.round(value)}`
}

const reasonText: Record<BreakReason, string> = {
  halftime: "halftime",
  delay: "delay",
  periodEnd: "end of the quarter",
  twoMinuteWarning: "two-minute warning",
  timeout: "timeout",
  review: "review",
  injury: "injury",
  afterScore: "after the score",
  afterKickoff: "after the kickoff",
  possessionChange: "change of possession",
  stall: "no play for a while"
}
