# Slate Strip — Design

Date: 2026-10-03
Status: Approved 2026-10-03

Supersedes [the slate drawer design](2026-10-03-slate-drawer-design.md).

## Goal

Make filling the Stage quick without hiding any video. The drawer floated over the Stage, so the provider views
under it had to hide: the slate blocked the views. The slate becomes a strip under the Stage that takes its own
room, games are cycled and dropped from the keyboard, teams show their logos, and every key is discoverable.

## Decisions

| Question | Decision |
| --- | --- |
| Presence | A strip in its own grid row under the Stage, about 64px. Shown by default; `S` hides and shows it; hidden in full screen. The Stage measures its own area, so the views resize with it. Nothing overlays a video, so the drawer's covering, Esc, and click-outside handling go, and `design/sheet.tsx` is removed |
| Contents | Left: a fixed "to tile **N**" label. Then a horizontally scrolling row of cards: Bench (set off by a divider), Live (watch order), Upcoming (by kickoff), Final (dimmed). The mouse wheel scrolls it sideways |
| Card | Two lines, `[logo] ABBR score` per team, status (clock or kickoff) and networks on the right. A placed game shows its "T*n*" or "Bench" tag and is not pickable |
| Mouse | Click assigns a game to the selected tile; click on a bench card swaps it into the selected tile. Dragging a bench card onto a tile still swaps |
| Pick (highlight) | Local client state, like `selected`, held as a game id so a reordering slate does not move it. `[` and `]` step it over pickable cards (unplaced games and bench cards); the strip scrolls it into view. From no pick, either step lands on the first unplaced live game, or the first pickable card when none is live. `Enter` drops the pick into the selected tile, like a click; the pick stays, so `]` `Enter` fills the next tile |
| Selecting a tile | `Alt`+`1`–`9` selects that on-stage tile, from the page or a stream view. After any drop the selection moves to the next empty on-stage tile (`Stage#nextEmptySlot`), so `]` `Enter` repeated fills the Stage |
| Keys in a stream view | `[`, `]`, `?` are forwarded from a stream view like every hotkey. `Enter` is a hotkey only when pressed in the page, so the provider player keeps its own Enter |
| Logos | Hotlinked from `team.logo`. ESPN URLs on `a.espncdn.com` are asked for at size through its `combiner/i?img=…&w=…&h=…` resizer (about 4KB, not 94KB). With no logo, or one that fails to load, a neutral circle with the abbreviation. Shown on strip cards, tile headers, the data-tile scoreboard, and the palette's games |
| Key help | `?` toggles a Keys dialog listing every hotkey grouped Stage, Strip, Tiles. It covers videos only while open (`useCovering`), and `Esc` closes it first. The top bar gets a `?` button; the tile header's buttons carry their key in `title` and `aria-keyshortcuts`; palette commands show theirs |
| One keymap | `Hotkey.keys` beside `Hotkey.of` is the table the help renders: for each binding, the keys as shown, what it does, its group, and a sample press. A test asserts every sample press reads back to a hotkey, so the help cannot drift from the bindings |
| Not in scope | Channel surfing that replaces a tile's game per key press; a Hub logo cache; type-to-filter in the strip |

## Code

- **Hotkey** (`packages/api/src/Hotkey.ts`). New cases `StepPick { step: -1 | 1 }` (`BracketLeft`,
  `BracketRight`), `DropPick` (`Enter`, `NumpadEnter`), `ShowKeys` (`Shift`+`Slash`). `Hotkey.of(key, from)` takes
  where the key was pressed, `"page"` or `"stream"`; `DropPick` only for `"page"`. `TileViews.ts` passes
  `"stream"`, `Hotkeys.ts` `"page"`. `Hotkey.keys` is the help table. Tested in `Hotkey.test.ts`.
- **Strip cards** (`apps/web/src/slate/StripCards.ts`). Pure: the ordered cards for a Stage and a slate, each
  with its section and place, and the next pick from a current pick and a step. Written test-first.
- **Strip** (`apps/web/src/slate/SlateView.tsx`). Rewritten from drawer to strip, holding the card component
  privately. `App.tsx` places it in the grid row under the Stage and owns the pick beside `selected`.
- **Logo** (`apps/web/src/slate/TeamLogo.tsx`). Used by the strip, `TileChrome`, `TileBody`, `CommandPalette`.
- **Key help** (`apps/web/src/frame/KeysDialog.tsx`). Renders `Hotkey.keys`; `App.tsx` holds its open state.
- **Docs.** The drawer spec gets a superseded note. `CONTEXT.md`'s Slate row notes its view is the strip; no new
  exported type names.

## Risks to check

| Risk | Check |
| --- | --- |
| `Enter` with a stream view focused does nothing for Sportal | Accepted: click the card, or click the page first. Shown in the Keys dialog |
| Electron draws `title` tooltips over native views? | Verified by the user in the shell; if hidden, accepted — the Keys dialog and palette carry the same keys |
| A hotlinked logo is slow or blocked | The abbreviation fallback renders until it loads or on error |
