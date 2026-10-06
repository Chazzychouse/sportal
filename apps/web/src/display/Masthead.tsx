/** The Sportal name with its on-air dot. */
export function BrandMark() {
  return (
    <span className="label-caps flex items-center gap-2 text-[15px] tracking-[0.22em]">
      <span className="size-2 rounded-full bg-on-air shadow-[0_0_8px_var(--on-air)]" />
      Sportal
    </span>
  )
}

/** Whether the Hub's live stream is up: "Hub live", or "Reconnecting" while it is not. */
export function ConnectionPill(props: { connected: boolean }) {
  return (
    <span
      className={`label-caps flex items-center gap-1.5 text-[11px] ${props.connected ? "text-live" : "text-warn"}`}
    >
      <span className={`size-1.5 rounded-full ${props.connected ? "bg-live" : "animate-pulse bg-warn"}`} />
      {props.connected ? "Hub live" : "Reconnecting"}
    </span>
  )
}
