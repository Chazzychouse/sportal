import { Connection } from "../hub/LiveStream.ts"

/** The Sportal name with its on-air dot. */
export function BrandMark() {
  return (
    <span className="label-caps flex items-center gap-2 text-[15px] tracking-[0.22em]">
      <span className="size-2 rounded-full bg-on-air shadow-[0_0_8px_var(--on-air)]" />
      Sportal
    </span>
  )
}

/** Whether the Hub's live stream is up: "Hub live", "Connecting" before it first is, "Reconnecting" once lost. */
export function ConnectionPill(props: { connection: Connection }) {
  const live = Connection.$is("Connected")(props.connection)
  return (
    <span className={`label-caps flex items-center gap-1.5 text-[11px] ${live ? "text-live" : "text-warn"}`}>
      <span className={`size-1.5 rounded-full ${live ? "bg-live" : "animate-pulse bg-warn"}`} />
      {Connection.$match(props.connection, {
        Connecting: () => "Connecting",
        Connected: () => "Hub live",
        Lost: () => "Reconnecting"
      })}
    </span>
  )
}
