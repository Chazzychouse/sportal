import { Schema } from "effect"
import type { Hotkey } from "./Hotkey.ts"
import { TileKey } from "./TileKey.ts"

/** A rectangle in the web UI's window, in whole CSS pixels. */
export const TileBounds = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int,
  height: Schema.Int
})
export type TileBounds = typeof TileBounds.Type

/**
 * Where a tile's provider view sits in the Display's window, in CSS pixels, and what it loads.
 * An `interactive` stream's player gets the mouse; every other stream's player never sees it.
 * A view belongs to its tile's key, so a game that changes tiles keeps its player.
 */
export const TilePlacement = Schema.Struct({
  key: TileKey,
  url: Schema.String,
  bounds: TileBounds,
  muted: Schema.Boolean,
  interactive: Schema.Boolean
})
export type TilePlacement = typeof TilePlacement.Type

/** How the shell moves provider views to new bounds: over `durationMs`, along a CSS cubic-bezier. */
export const ScreenTransition = Schema.Struct({
  durationMs: Schema.Int,
  easing: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite])
})
export type ScreenTransition = typeof ScreenTransition.Type

/** What the desktop shell exposes to the web UI as `window.sportalShell`. Absent in a plain browser. */
export interface ShellBridge {
  /**
   * Replaces the full set of provider views: views not listed are closed. With a transition, views move to
   * their new bounds over its duration; without one, at once.
   */
  syncTiles(placements: ReadonlyArray<TilePlacement>, transition?: ScreenTransition): void
  /** Hides exactly these tiles' views, without unloading or muting them, and shows the rest. */
  setHidden(keys: ReadonlyArray<TileKey>): void
  /** Puts the shell window in or out of full screen. */
  setFullScreen(on: boolean): void
  /** Calls `listener` whenever the window enters or leaves full screen, however it happened. Returns a function that stops the calls. */
  onFullScreenChanged(listener: (on: boolean) => void): () => void
  /** Calls `listener` for each hotkey pressed while a stream view had keyboard focus. Returns a function that stops the calls. */
  onHotkey(listener: (hotkey: Hotkey) => void): () => void
  /** Calls `listener` with the key of the tile whose stream view was clicked while it was not interactive. Returns a function that stops the calls. */
  onTilePressed(listener: (key: TileKey) => void): () => void
  /** Opens the sign-in window for YouTube TV, or focuses it if open. Its sign-in is shared by every tile. */
  openSignIn(): void
  /** Calls `listener` with each guide the shell reads from the source, unchanged. Returns a function that stops the calls. */
  onGuideRead(listener: (guide: string) => void): () => void
  /** Asks the shell to read the guide now: at start, and when the Hub comes back. The shell also reads every 5 minutes. */
  readGuide(): void
}

declare global {
  interface Window {
    sportalShell?: ShellBridge
  }
}
