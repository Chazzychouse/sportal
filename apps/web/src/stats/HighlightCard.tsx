import type { Highlight } from "@sportal/domain/Highlight"

/**
 * A highlight as a card: its thumbnail with its length, and its headline. The theme's card tokens give it the Glass or
 * Team shape the game cards have.
 */
export function HighlightCard(props: { highlight: Highlight; focused: boolean; onChoose: () => void }) {
  const { highlight } = props
  return (
    <button
      type="button"
      tabIndex={-1}
      data-focused={props.focused}
      aria-label={highlight.headline}
      onClick={props.onChoose}
      className="guide-focus flex w-60 shrink-0 flex-col overflow-hidden rounded-card border border-card-edge text-left backdrop-blur-[var(--guide-blur)] [background:var(--card-surface)]"
    >
      <span className="relative block aspect-video bg-well">
        {highlight.thumbnail !== undefined && (
          <img src={highlight.thumbnail} alt="" loading="lazy" className="size-full object-cover" />
        )}
        <span className="absolute right-1.5 bottom-1.5 rounded-sm bg-black/70 px-1 font-mono text-[11px] text-white">
          {highlight.durationText()}
        </span>
      </span>
      <span className="line-clamp-2 bg-card-footer px-2.5 py-2 text-xs">{highlight.headline}</span>
    </button>
  )
}
