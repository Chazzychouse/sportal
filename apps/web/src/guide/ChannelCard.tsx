import type { Lineup } from "@sportal/domain/Guide"
import { DateTime, Option } from "effect"
import { Tv } from "lucide-react"
import { cn } from "@/design/ClassName"
import { localTime } from "../game/GameStatus.tsx"

/**
 * A sports channel's card in the guide: its name, what airs on it now and the minutes left, and what is next. Choosing
 * it watches the channel in the selected tile.
 */
export function ChannelCard(props: {
  member: Lineup[number]
  focused: boolean
  compact: boolean
  onChoose: () => void
}) {
  const { channel, now, next } = props.member
  return (
    <button
      type="button"
      tabIndex={-1}
      data-focused={props.focused}
      onClick={props.onChoose}
      className={cn(
        "guide-focus flex shrink-0 flex-col items-start justify-between gap-1 overflow-hidden rounded-card border border-card-edge px-3.5 py-3 text-left backdrop-blur-[var(--guide-blur)] [background:var(--card-surface)]",
        props.compact ? "h-full max-h-32 w-52" : "h-32 w-60"
      )}
    >
      <span className="flex items-center gap-2 font-medium text-sm">
        <Tv className="size-4 text-muted-foreground" />
        {channel.name}
      </span>
      {Option.match(now, {
        onNone: () => <span className="text-muted-foreground text-sm">Nothing listed</span>,
        onSome: ({ title, end }) => (
          <span className="line-clamp-2 text-sm">
            {title} <span className="text-muted-foreground">· {minutesLeft(end)} min left</span>
          </span>
        )
      })}
      {!props.compact &&
        Option.match(next, {
          onNone: () => null,
          onSome: ({ title, begin }) => (
            <span className="label-caps truncate text-[10px] text-muted-foreground">
              Next {localTime(begin)} · {title}
            </span>
          )
        })}
    </button>
  )
}

/** Whole minutes from this browser's now to `end`, at least 0. */
function minutesLeft(end: DateTime.Utc): number {
  return Math.max(0, Math.ceil((DateTime.toEpochMillis(end) - Date.now()) / 60_000))
}
