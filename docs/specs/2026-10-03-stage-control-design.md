# Stage Control — Design

Date: 2026-10-03
Status: Approved 2026-10-03; spike pending (section 0)

## Goal

Make the Stage a real multiview: named layouts with adjustable dividers, swap and promote, a bench for games
that do not fit, solo, Display full screen, audio that follows the game, hotkeys, a command palette, and
animated transitions in which the video moves with its tile. Adopt shadcn as the web UI's component base and
give the frame, the Stage chrome, and the overlays a deliberate visual design.

## Decisions

| Question | Decision |
| --- | --- |
| Scope | shadcn plus the core Stage: layouts, splits, swap, promote, bench, solo, full screen, audio focus, hotkeys, command palette, transitions. Presets, score strips, Couch mode, and the stream budget each get their own spec |
| Layouts | A fixed set (`Single`, `Pair`, `Quad`, `MainThree`, `MainFive`) whose dividers can be dragged. Each layout remembers its own split. No split-tree editor |
| Shrinking a layout | Tiles that no longer fit go to the **Bench**, in order, and come back when the layout grows. Benched games are not played |
| Full screen | Two things that stack. **Solo** is a Stage command (one slot fills the Stage), shared through the Hub so a Remote can solo a tile on the TV. **Full screen** is local to the Display: the shell window goes OS full screen and the top bar and sidebar hide |
| Audio | Audio focus names a game, not a slot: it follows the game through swap, promote, and layout changes. Promote and solo take audio. Switching is instant: Electron cannot set a view's volume and the page is not modified, so there is no crossfade |
| Who owns geometry | The domain. `Layout.slots` turns a layout and its split into slot rectangles as fractions of the Stage area. The web UI positions its chrome from them and computes the shell's placements from them; nothing is measured per tile |
| Transitions | The web UI sends the shell target placements and `{ durationMs, easing }`; the shell interpolates each view's bounds in the main process with the same curve the CSS uses. If the spike shows stutter, the shell's strategy becomes *dip and settle* (hide the moving views, set final bounds after `durationMs`, show them). Frame capture is not an option: Widevine captures black, and provider video is never captured |
| Views and identity | The shell keys provider views by game, not slot. A swap, promote, or layout change moves a view; only a changed address reloads it |
| Overlays over native video | Every overlay renders through one overlay host, which asks the shell to hide only the views the overlay covers. Audio keeps playing. A shell-side overlay layer (a transparent view above the provider views) is a later spec, if the spike shows transparency composites |
| Hotkeys while a stream has focus | The shell reads `before-input-event` on stream views only and forwards Sportal's keys over the Shell bridge. Guide views receive every key. In a plain browser, a DOM listener |
| shadcn's home | `apps/web/src/design/`, aliased in `components.json`. Files keep the CLI's names so `shadcn add` and `shadcn diff` keep working. `cn` lives in `src/design/ClassName.ts`. knip ignores unused exports in `src/design/` only |
| The slate | Restyled on the new primitives, same content and behaviour. Its redesign belongs to the Tracker phase |
| Stage persistence | Unchanged: in memory in the Hub |
| Approaches not taken | The web UI driving the shell every animation frame (IPC at 60 Hz; renderer jank shows as video jitter). Geometry only in CSS (a Remote could not draw the TV's Stage, and the Director could not reason about the main tile) |

## 0. Spike (throwaway, in `spikes/`)

Run by hand on the development machine, on the default backend and with `--ozone-platform=x11`. The user
runs it and reports what they see: an agent-launched Electron misreports rendering on this machine.

| Question | How |
| --- | --- |
| Do provider views animate smoothly? | Three signed-in YouTube TV channels in `WebContentsView`s; move and resize all three over 300 ms on a 16 ms timer, back and forth, for a minute. Judge stutter, black frames, player relayout, and GPU process logs |
| Does dip and settle look acceptable? | The same moves with the views hidden for 300 ms |
| Does a transparent view composite over a playing view? | A `WebContentsView` with a transparent background and a translucent backdrop above one playing view. Recorded for the later overlay-layer spec; it does not change this one |

The result is recorded in ADR 0002 as an amendment and picks the shell's transition strategy.

## 1. Domain (`packages/domain`)

### `Layout.ts` (new)

- `LayoutName`: `Single`, `Pair`, `Quad`, `MainThree` (one main tile and three beside it), `MainFive` (one main
  tile and five around it). Slot 0 is always the **main tile**.
- `Split`: `{ x, y }`, divider positions as fractions of the Stage area. A layout uses none, one, or both
  (`Single` none; `Pair` `x`; `Quad`, `MainThree`, `MainFive` `x` and `y`). Each layout has a default split.
- `Layout.slots(name, split)`: each slot's rectangle `{ x, y, width, height }` as fractions of the Stage area,
  in slot order. `Layout.slotCount(name)`.
- Dividers are held to 0.2–0.8.

Operations are statics of the type that owns them, as AGENTS.md requires; the plan picks the exact class
shape (`LayoutName` with statics on a `Layout` class, or a `Layout` class with a `name` field).

### `Stage.ts` (extended)

Fields:

- `tiles`: ordered. The first `Layout.slotCount(layout)` are **on stage**; the rest are the **Bench**. Empty
  tiles at the end of the bench are trimmed. Growing a layout pulls benched tiles into the new slots in order;
  shrinking it pushes the tiles past the last slot to the front of the bench, in order.
- `layout: LayoutName`.
- `splits`: one `Split` per `LayoutName`, starting at each layout's default.
- `audioFocus: Option<GameId>`, replacing the slot index.
- `solo: Option<number>`: the on-stage slot filling the Stage.

`Stage.initial` is `Quad`, four empty tiles, no audio focus, no solo.

Commands (`StageCommand`):

| Command | Effect |
| --- | --- |
| `Assign { tile, game }` | As today, across stage and bench. A game already elsewhere moves |
| `Clear { tile }` | As today |
| `FocusAudio { tile }` | Audio focus becomes that tile's game |
| `Swap { a, b }` | Exchanges two tiles; either may be benched |
| `Promote { tile }` | Swaps the tile into slot 0 and gives its game audio focus. A benched tile may be promoted |
| `SetLayout { layout }` | Changes layout, moving tiles between stage and bench |
| `SetSplit { split }` | Sets the current layout's split |
| `Solo { tile }` | Solos the slot and gives its game audio focus |
| `Unsolo` | Ends solo |

Invariants, enforced only in `apply`:

- A game appears in at most one tile across stage and bench.
- Audio focus is an on-stage game or none. When the focused game leaves the stage (cleared, benched by a
  layout change or swap), focus moves to the main tile's game, or none if the main tile is empty.
- Solo names an on-stage, non-empty slot. When that slot empties or is benched, solo ends. Solo follows its
  game when a swap or promote moves it to another on-stage slot.

`StageRejection.reason` widens:

| Reason | When |
| --- | --- |
| `no-such-tile` | An index outside stage and bench |
| `empty-tile` | Solo, promote, or focus audio on an empty tile |
| `offstage-tile` | Solo or focus audio on a benched tile |
| `split-out-of-range` | A divider outside 0.2–0.8 |

`refresh` re-resolves benched tiles as well as on-stage ones.

### Glossary (`CONTEXT.md`)

New rows: **Bench**, **Solo**, **Split**, **Swap**, **Full screen** (the Display's window, not a Stage
state), **Overlay host**, **Stage transition**. **Layout** is reworded to "a named arrangement of tile slots
whose dividers can be moved". **Audio focus** becomes "the single game whose sound is on".

## 2. Shell bridge and desktop shell (`packages/api`, `apps/desktop`)

### `ShellBridge`

- `TilePlacement` is keyed by `game` instead of `tile`: `{ game, url, role, bounds, muted }`.
- `ChannelPick` reports `game` instead of `tile`.
- `syncTiles(placements, transition?)`, where `transition` is `{ durationMs, easing: [x1, y1, x2, y2] }`.
- `setHidden(games)`: hides exactly the listed games' views, without unloading them, and shows the rest.
- `setFullScreen(on)` and `onFullScreenChanged(listener)`.
- `onHotkey(listener)`: a Sportal key pressed while a stream view had focus.

### `TileViews`

- Views are a `Map<GameId, Entry>`. Benched games are not placed, so their views close.
- Without a transition, bounds are set at once (window resize, divider drag).
- With a transition, each placed view is interpolated from its current bounds to its target on a ~16 ms timer
  in the main process, with the cubic-bezier given. A sync arriving mid-animation starts from the current
  bounds. A view new in the sync is shown at its target when the animation ends; a removed view closes at
  once; a view closed mid-animation leaves it.
- The transition strategy is internal: *animate* or *dip and settle*, chosen by the spike.
- Hidden views stay hidden through syncs until `setHidden` names them no longer.
- On stream views only, `before-input-event` is read for Sportal's keys, which are forwarded through
  `onHotkey` and not delivered to the page. Every other key, and every key in a guide view, reaches the page.
  Nothing is injected.

### Window

The shell window's full screen is set through `setFullScreen` and reported through `onFullScreenChanged`, so
the UI follows changes made by the OS or window manager.

## 3. Web UI (`apps/web`)

### shadcn

- Installed for Tailwind v4 with CSS-variable theming, dark first. Tokens in `theme/theme.css`.
- Primitives in `src/design/`: Button, Command, Dialog, DropdownMenu, ToggleGroup, Tooltip, Sonner, and what
  the work needs beyond these. `cn` in `src/design/ClassName.ts`.
- Visual direction: a broadcast control room. Dense, dark, tabular numbers, a strong audio-focus indicator,
  restrained motion outside Stage transitions.

### Frame

- Top bar: layout picker (a ToggleGroup of layout glyphs), solo, full screen, connection state, sign-in.
- Sidebar: the slate, restyled; below it, the bench as a strip of games. Clicking or dragging a benched game
  onto a slot swaps it in.
- In full screen the top bar and sidebar hide and the Stage fills the window.

### Stage view

- Tiles are positioned absolutely at `Layout.slots` fractions of the Stage area, keyed by game (empty slots by
  slot), so each tile's element persists as it moves. Chrome moves with CSS transitions using one shared
  `{ durationMs, easing }` constant, beside the Stage view, that is also passed to `syncTiles`.
- Placements are the Stage area's rectangle times the slot fractions, rounded the way CSS lays out the tiles,
  so the video and the chrome settle on the same pixels.
- Solo renders the soloed slot over the whole Stage area; the other tiles' views are not placed.
- Tile chrome is a slim header: score, audio indicator, solo, promote, clear, and a tile menu.
- Dividers are drag handles. During a drag the split is local and synced to the shell without a transition;
  on release the UI sends `SetSplit`.

### Overlay host

Every overlay (dialog, command palette, dropdown, tooltip) renders through it. It tracks each open overlay's
rectangle, intersects it with the placed views, and calls `setHidden` with the games covered. Toasts sit at
the bottom left over the sidebar and never cover video.

### Command palette

⌘K. Assign a game to a tile, promote, swap, set layout, focus audio on a game, solo, unsolo, full screen.
Fuzzy matching over team names, abbreviations, and networks.

### Hotkeys

| Key | Action |
| --- | --- |
| `1`–`9` | Focus audio on tile N |
| `Shift` + `1`–`9` | Promote tile N |
| `F` | Solo the selected tile, or unsolo |
| `Esc` | Unsolo |
| `F11` | Full screen |
| `L` | Next layout |
| `⌘K` / `Ctrl+K` | Command palette |

The same table is used by the DOM listener and by the shell's forwarder.

### Rejections

A `StageRejection` shows as a toast.

## 4. Hub and API

`StageSessions` is unchanged in shape; the wider `StageCommand` and `Stage` reach the API's `dispatch`
endpoint and the `StageChanged` live message through their schemas.

## 5. Testing

- `Layout.test.ts` (test-first): slot rectangles for every layout at default and edge splits; slots cover the
  area without overlap; splits outside 0.2–0.8 are refused by the Stage.
- `Stage.test.ts` (test-first): each command and rejection; bench push and pull as layouts shrink and grow;
  audio following its game through swap, promote, layout change, and clear, and falling back to the main
  tile; solo ending when its slot empties or is benched; one game per Stage across the bench; `refresh` on
  benched tiles.
- `TileViews.test.ts`: a swap moves views without reloading; interpolation lands exactly on the target; a
  mid-animation sync starts from the current bounds; `setHidden` hides only the named views and survives
  syncs; dip and settle; hotkeys forwarded only from stream views.
- Web: placements equal the Stage area times the slot fractions.
- Game-day checklist rows: a promote animates with the video playing; full screen and solo stack; hotkeys work
  with a stream focused and typing works in a guide; a divider drag tracks the video; a tile menu blanks only
  its tile; the command palette blanks only what it covers.

## 6. Order of work

1. Spike; amend ADR 0002 with the result.
2. Domain: `Layout`, then `Stage` (test-first); glossary rows.
3. Shell: views keyed by game, transitions, `setHidden`, full screen, hotkey forwarder; Shell bridge.
4. Web: shadcn setup and theme, frame, Stage view, dividers, bench, overlay host, command palette, hotkeys.
5. Docs: technical spec §5.3, game-day rows.
