# Slate Drawer — Design

Date: 2026-10-03
Status: Approved 2026-10-03

## Goal

Give the Stage the whole window. The slate stops being a permanent sidebar and becomes a drawer summoned
over the Stage, its rows line up in fixed columns, and it separates what matters (live games, games already
on the Stage) from what does not (finals, empty scores).

## Problems it fixes

| Problem | Fix |
| --- | --- |
| The slate is always showing and takes width from the Stage | A drawer from the left edge, opened on demand, closed after a pick |
| Text does not align because names, scores, clocks, and networks vary in length | One fixed-column row grid with tabular figures, used by every game row |
| Hard to sort signal from noise | Sections by status (Live, Upcoming, Final collapsed); a chip on every game already on the Stage or the Bench |

## Decisions

| Question | Decision |
| --- | --- |
| Presence | A drawer (`Sheet` from shadcn, side `left`, about 24rem, full height under the top bar). The `aside` in `App.tsx` is removed; the Stage spans the window |
| Overlay over native video | The drawer registers with `useCovering`, so only the videos it overlaps hide while it is open. In most layouts the main tile stays visible |
| Opening | Hotkey `S` (a new `ToggleSlate` case in `packages/api/src/Hotkey.ts`, so it works while a stream view has focus), and a Slate button in the top bar left of the layout toggles that shows the live count |
| Closing | `S` again, `Esc`, a click outside, or picking a game. While the drawer is open, `Esc` closes it and does not also unsolo |
| Where a pick goes | The existing `selected` cursor. The drawer header reads "Slate · to tile N" |
| Bench | A section at the top of the drawer, shown only when non-empty. Clicking swaps into the selected tile; dragging onto a visible tile still works, and the drawer stays open during a drag |
| Sections | Bench, Live (watch order), Upcoming (by kickoff), Final (collapsed to one "Final · N" line, expands on click). Postponed and canceled games sit in Final and show their status |
| Games already placed | A chip in the row's last column: "T2" for a game on tile 2, "Bench" for a benched game. Clicking such a row does nothing |
| Toaster | Moves from bottom left to top center, over the top bar strip, so a toast is never drawn behind a video |
| Not in scope | Type-to-filter (the command palette covers keyboard picking), close-game highlighting, choosing a tile per pick, follows, Couch mode sizing |

## Row anatomy

Every game row — slate and bench — is one grid with fixed column widths; empty cells keep their width.

```
│ 12 │ OSU  │ 24 │ Q3 4:12  │ T2 │
│    │ MICH │ 17 │ CBS·ESPN │    │
 rank  team score  status    stage
```

| Column | Width | Content |
| --- | --- | --- |
| Rank | 2ch, right-aligned, muted | Ranking, blank when unranked |
| Team | 4ch, left-aligned, semibold | Abbreviation |
| Score | 3ch, right-aligned | Hidden for upcoming games. In live and final games the leading side is full strength, the trailing side muted |
| Status | fixed, two lines | Top: `statusText` (clock, kickoff, or status), live color when live. Bottom: networks, truncated with an ellipsis, full list in `title` |
| Stage | fixed | "T*n*" or "Bench" chip, or empty |

Numbers use `font-mono` with `tabular-nums`. Final rows are muted; the winner keeps normal weight.

## Code

- **Domain.** `GameSnapshot` gains a method giving the section a game belongs to (live, upcoming, over),
  and `watchOrder` is rewritten on top of it so the two can never disagree. Written test-first in
  `Game.test.ts`. No new module: `Slate.ts` from the technical spec is not needed for this.
- **Hotkey.** `ToggleSlate` on `KeyS`, with its case in `Hotkey.test.ts`. The desktop shell forwards it
  like every other hotkey; nothing changes there.
- **Web.** `slate/SlateView.tsx` becomes the drawer: header, sections, and the row as a private component
  below. The bench section moves in from `stage/Bench.tsx`, which is deleted, so there is one row format.
  `design/sheet.tsx` is added with `shadcn add sheet`. `App.tsx` holds the drawer's open state beside the
  palette's; `TopBar.tsx` gets the Slate button.
- **Glossary.** No new exported type names; the drawer is the Slate's view, so `CONTEXT.md` is unchanged.

## Risks to check

| Risk | Check |
| --- | --- |
| `S` pressed while a stream view has focus opens the drawer, but key focus stays in the stream view, so `Esc` goes to the shell as `Unsolo` | When the drawer opens, focus moves to the web contents; verify in the shell, run by the user |
| A drawer over the left tile hides that video for as long as it is open | Accepted: the drawer is short-lived and closes on pick |
