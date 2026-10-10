import type { Classification } from "@sportal/domain/Classification"
import { Moment } from "@sportal/domain/Moment"
import { Flag, Timer, Zap } from "lucide-react"
import { cn } from "@/design/ClassName"

/**
 * A game's moment as a small mark — a flag in the red zone, a clock in crunch time, a bolt after a big play, BRK in a
 * break — titled with its score and the points each part gave it. Nothing for plain live play or a game not live.
 */
export function MomentBadge(props: { classification: Classification | undefined; className?: string }) {
  const { classification } = props
  if (classification === undefined) return null
  const mark = markOf(classification)
  if (mark === null) return null

  const { prior, closeness, swing, upset, momentBonus } = classification.breakdown
  const title = `Score ${classification.score}: matchup ${points(prior)}, closeness ${points(closeness)}, swing ${points(swing)}, upset ${points(upset)}, moment ${points(momentBonus)}`
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
    Break: () => <span className="label-caps text-[9px] text-muted-foreground">BRK</span>,
    Live: () => null,
    Upcoming: () => null,
    Final: () => null
  })
}

function points(value: number): string {
  return `${value >= 0 ? "+" : ""}${Math.round(value)}`
}
