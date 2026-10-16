import { ListVideo, MonitorPlay, Plus, X } from "lucide-react"
import { cn } from "@/design/ClassName"
import { type CustomStream, CustomTarget } from "./CustomStream.ts"

/**
 * A saved YouTube stream's card in the guide: its name, and whether it is a video or a playlist. Choosing it watches it
 * in the selected tile; its ×, shown while it is focused or hovered, removes it from the list.
 */
export function CustomCard(props: {
  stream: CustomStream
  focused: boolean
  compact: boolean
  onChoose: () => void
  onRemove: () => void
}) {
  const video = CustomTarget.guards.Video(props.stream.target)
  const Glyph = video ? MonitorPlay : ListVideo
  return (
    <div data-focused={props.focused} className={cn("group relative", frame(props.compact))}>
      <button
        type="button"
        tabIndex={-1}
        onClick={props.onChoose}
        className="flex h-full w-full flex-col items-start justify-between gap-1 px-3.5 py-3 text-left"
      >
        <Glyph className="size-5 text-muted-foreground" />
        <span className="line-clamp-2 font-medium text-sm">{props.stream.name}</span>
        {!props.compact && (
          <span className="label-caps text-[10px] text-muted-foreground">{video ? "Video" : "Playlist"}</span>
        )}
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Remove ${props.stream.name}`}
        title="Remove · Delete"
        onClick={props.onRemove}
        className={cn(
          "absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-sm text-muted-foreground hover:text-destructive",
          props.focused ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        )}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

/** The last card under Custom: it opens the YouTube form. */
export function AddCustomCard(props: { focused: boolean; compact: boolean; onChoose: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-focused={props.focused}
      onClick={props.onChoose}
      className={cn(
        "flex flex-col items-center justify-center gap-1 border-dashed text-muted-foreground",
        frame(props.compact)
      )}
    >
      <Plus className="size-5" />
      <span className="text-sm">Add YouTube</span>
    </button>
  )
}

/** A card's frame in the guide's shape: the ribbon's chip size when compact, else the full guide's card size. */
function frame(compact: boolean) {
  return cn(
    "guide-focus shrink-0 overflow-hidden rounded-card border border-card-edge backdrop-blur-[var(--guide-blur)] [background:var(--card-surface)]",
    compact ? "h-full max-h-32 w-52" : "h-32 w-60"
  )
}
