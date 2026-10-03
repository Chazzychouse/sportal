import { Schema } from "effect"

/**
 * Where one provider view sits in the Display's window, in CSS pixels, and what it loads. A `stream` view
 * plays a channel; a `guide` view shows the source's guide so the user can pick the channel for a network.
 */
export const TilePlacement = Schema.Struct({
  tile: Schema.Int,
  url: Schema.String,
  role: Schema.Literals(["stream", "guide"]),
  bounds: Schema.Struct({ x: Schema.Int, y: Schema.Int, width: Schema.Int, height: Schema.Int }),
  muted: Schema.Boolean
})
export type TilePlacement = typeof TilePlacement.Type

/** A guide view landed on a channel's address: the user picked that channel in the tile's guide. */
export const ChannelPick = Schema.Struct({ tile: Schema.Int, url: Schema.String })
export type ChannelPick = typeof ChannelPick.Type

/** What the desktop shell exposes to the web UI as `window.sportalShell`. Absent in a plain browser. */
export interface ShellBridge {
  /** Replaces the full set of provider views: views not listed are closed. */
  syncTiles(placements: ReadonlyArray<TilePlacement>): void
  /** Opens the sign-in window for YouTube TV, or focuses it if open. Its sign-in is shared by every tile. */
  openSignIn(): void
  /** Calls `listener` for every channel picked in a guide view. Returns a function that stops the calls. */
  onChannelPicked(listener: (pick: ChannelPick) => void): () => void
}

declare global {
  interface Window {
    sportalShell?: ShellBridge
  }
}
