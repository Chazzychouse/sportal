# Mouse Filter — Design

Date: 2026-10-04
Status: Approved 2026-10-04

## Goal

Watching a game, the pointer resting anywhere on a stream tile brings up YouTube TV's title and controls over
the picture, and they are slow to leave. With four tiles on the Stage, there is nowhere to park the pointer. A
stream tile should show only the picture until the user asks to use the player.

## Problems it fixes

| Problem | Fix |
| --- | --- |
| Hovering a stream tile covers the game with YouTube TV's overlay | The shell drops every mouse event bound for a stream view's page, so the player never sees the pointer |
| The overlay is finicky to dismiss | The player only sees the pointer while the user is using it on purpose |
| A click on a video does nothing for Sportal: its web UI sits under the views | The shell reports a click on a stream view, and the web UI selects that tile |

What the spikes found is in ADR 0002, "Amendment: the mouse filter".

## Decisions

| Question | Decision |
| --- | --- |
| How | **Tile views** handles each provider view's `before-mouse-event` and calls `preventDefault()` while the view is a stream that is not interactive. Nothing is drawn over the view and nothing is injected into its page |
| Which tiles | Stream tiles. A picking tile (the guide) always gets the mouse: it needs it for search and scrolling |
| Clicks | A left `mouseDown` on a filtered view selects its tile: the shell reports the game, and the web UI selects the on-stage tile holding it (`SelectTile`'s effect) |
| Keys | Unchanged. A focused stream view forwards hotkeys and gives the player every other key |
| Using the player | A new hotkey, `I` (`Interact`), makes the selected tile's stream interactive: its mouse events reach the player, and its view takes focus. `I` again ends it, and so does selecting another tile. One tile at most is interactive, and it is local to the Display, like the selected tile |
| How the shell knows | `TilePlacement` gains `interactive: boolean`. The web UI sets it on the interacting game's placement and the shell filters every other stream view |
| Glossary | Adds **Interacting tile** to `CONTEXT.md`: "The one stream tile whose player gets the mouse, after `I`; every other stream tile's player never sees the pointer." Avoid: active, unlocked |
| Not in scope | Hiding the pointer over a tile, Sportal chrome drawn over the video, double-click to solo, ending interaction by itself when the pointer leaves or after idle time, making XWayland the shell's default backend |

## Risks

- Native Wayland broke both spikes when the pointer moved over the video. That is a display backend problem
  recorded in ADR 0002, not this feature's, but on native Wayland this feature will look broken.
- A dropped click may or may not still give the view keyboard focus. In the spike, keys pressed after dropped
  clicks still reached the shell from that view.
