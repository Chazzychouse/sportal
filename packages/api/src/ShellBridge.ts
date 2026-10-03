import { Schema } from "effect"

/** Where one stream tile sits in the Display's window, in CSS pixels, and what it plays. */
export const TilePlacement = Schema.Struct({
  tile: Schema.Int,
  url: Schema.String,
  bounds: Schema.Struct({ x: Schema.Int, y: Schema.Int, width: Schema.Int, height: Schema.Int }),
  muted: Schema.Boolean
})
export type TilePlacement = typeof TilePlacement.Type

/** What the desktop shell exposes to the web UI as `window.sportalShell`. Absent in a plain browser. */
export interface ShellBridge {
  /** Replaces the full set of provider views: views not listed are closed. */
  syncTiles(placements: ReadonlyArray<TilePlacement>): void
}

declare global {
  interface Window {
    sportalShell?: ShellBridge
  }
}
