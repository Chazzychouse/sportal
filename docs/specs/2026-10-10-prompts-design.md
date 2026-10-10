# Prompts

2026-10-10. Piece 4 of the automation roadmap ([Classification](2026-10-10-classification-design.md), [Break
detection](2026-10-10-break-detection-design.md), [Autopilot](2026-10-10-autopilot-design.md) and its
[ranking](2026-10-10-autopilot-ranking-design.md)). The autopilot only steers the games already on a tile. A prompt
brings in a game that is on no tile: when one enters a red zone or crunch time and is better than the weakest game on
screen, a toast asks whether to watch it. Nothing changes unless you say yes.

Not in this spec: a phone push (a later delivery of the same prompt), bringing a game in without asking, prompting
for a big play, and prompting for a game no source can stream.

## Behaviour

### Prompt-worthy

A game is a **candidate** when all of these hold:

- it is on the slate and on no tile, on screen or benched;
- its moment is `ScoringThreat` (red zone) or `CrunchTime`;
- a source can stream it: the Screen would give it a `StreamTile` (`Screen.tileFor`), never a `DataTile`;
- you have not dismissed it for this moment (see Dismissing).

### Where it would go

The **target** is the first empty on-screen slot. With none, it is the on-screen tile whose game is last by `byRank`
(rank, then score, then tile): the weakest game on screen.

A candidate qualifies only when the target is empty, or its rank is strictly higher than the target game's
(`outranks`). Within a rank it never qualifies: a red zone does not prompt over another red zone, nor crunch time over
crunch time.

### The prompt

The prompt is the best qualifying candidate by rank, then score, then game id; or none. One prompt at a time: a better
candidate takes the toast over, and the one it replaced comes back when it is again the best and still qualifies.

A prompt lasts as long as a step still gives it. When its game leaves the red zone or crunch time, gets a tile, loses
its stream, or no longer outranks the target, the toast closes. No timer.

With prompts off, or the Screen soloed, there is no prompt.

### Accepting

Accepting sends, as your commands through the Display, `Assign { tile: target, game }` then `Promote { tile: target }`:
the game takes the target's slot, then swaps into the main tile with the sound. The main tile's game moves to the
target's slot; the target's game, if any, leaves the Screen (it stays on the slate).

Being your commands, they suspend the autopilot's main tile and sound for 3 min, as any command you send does.

### Dismissing

Dismissing records the game with its moment's `since`. While the game's classification has that same `since`, it is
not a candidate. A new red zone or crunch time (a new `since`) makes it one again. Each dismissal drops the records
whose game's `since` has since changed, so the record stays small.

### On and off

Prompts are on by default and kept in this browser, apart from the autopilot: off silences them, and the autopilot
being off does not.

## Web

### `apps/web/src/prompts/Prompts.ts`

A `Schema.Class` (`sportal/prompts`):

- Fields: `on: boolean`; `dismissed: Record<GameId, DateTimeUtc>` (the moment's `since` you said no to).
- `Prompts.initial`: on, nothing dismissed.
- `toggle()`: flips `on`.
- `prompt(screen, live): Option<Prompt>`: the rules above, reading the slate, availability and classifications from
  the live state.
- `dismiss(prompt, classifications)`: records `prompt.game` with `prompt.since`, dropping each record whose game's
  `since` differs or that has no classification.
- `Prompt.commands`: the `Assign` then `Promote` that accept it.

`Prompt`, beside it, a `Data.Class`: `game`, `rank` (`redZone` or `crunchTime`), `since`, `target` (the tile index),
and `replaces: Option<{ game, rank }>` (none when the target is empty).

### `Screen.tileFor`

`tileFor` in `Screen.ts` becomes a static, `Screen.tileFor(game, availability)`, so a prompt and an assign agree on
what streams.

### `apps/web/src/prompts/PromptsState.ts`

As `AutopilotState`:

- `PromptInput`, a `Data.TaggedEnum`: `Toggled`, `Accepted`, `Dismissed`.
- `prompts`: an `Atom.kvs` (`sportal/prompts`, default `Prompts.initial`) behind a writable atom. `Toggled` toggles;
  `Accepted` sends the current prompt's commands to `DisplayScreen.screen`; `Dismissed` dismisses it. Accepting or
  dismissing with no prompt does nothing.
- `current`: a derived atom, `prompts.prompt(screen, live)`, recomputed on each change of the three.
- `log`, mounted by the Display beside `pilot`: `Effect.logInfo("Prompt: …")` when a prompt is shown (with what it
  would replace), taken over, accepted, dismissed, or closed because it no longer holds, annotated with
  `prompt.game`, `prompt.rank` and `prompt.target`. Sent to `sportal-web` through the existing OTLP logger.

### The toast

`apps/web/src/prompts/PromptToast.tsx`, mounted in `DisplayView`: one Sonner toast with a fixed id, updated in place
while `current` holds a prompt and closed when it holds none. It reads `PHI @ DAL — red zone` (or `crunch time`) with
its `MomentBadge`, then `replaces CHI @ GB (break)` or `into an empty tile`, and `Y watch · N skip`. A click on the
toast accepts; its close button dismisses.

### The toggle

`apps/web/src/prompts/PromptsToggle.tsx`, a bell in the `TopBar` beside the autopilot's toggle. Its tooltip:
`prompts: off`, `prompts: on`, or `prompts: on — showing PHI @ DAL`.

### Hotkeys

In `@sportal/api/Hotkey`: `TogglePrompts` on `P`, `AcceptPrompt` on `Y`, `DismissPrompt` on `N`, in a `Prompts`
group of the keys. Pressed in a stream view too, like the others. The keys dialog, the command palette and the shell's
key map follow, as for `ToggleAutopilot`.

## Docs

CONTEXT.md, Automation: **Prompt** (a toast asking whether to bring a game on no tile into the main tile, when it is
in a red zone or crunch time and outranks the weakest game on screen), **Prompts** (a Display's prompts: on or off,
and the games you dismissed for their moment), **Target** (the slot a prompt's game would take). Planned: **Phone
push** (a prompt delivered to a phone).

## Testing

- `Prompts.test.ts`, one rule per test: a red-zone game on no tile prompts into an empty slot; crunch time prompts
  too; a big play does not; a game on a tile, on screen or benched, does not; a game with no stream does not; a red
  zone does not prompt over a red zone on screen; it prompts over a break and names it in `replaces`; the target is the
  weakest on-screen game; of two candidates the better rank, then score, wins; a dismissed game stays quiet for its
  `since` and prompts again for a new one; dismissing drops stale records; off prompts nothing; soloed prompts
  nothing; `commands` are `Assign` then `Promote` on the target.
- `PromptsState.test.ts`: accepting sends both commands and leaves the game in the main tile with the sound;
  accepting or dismissing with no prompt does nothing; a toggle is kept.
- `AutopilotTimeline.test.ts`, one scenario: accepting a prompt holds the main tile through a higher-ranked game for
  3 min, then the ranking decides.
- `Hotkey.test.ts`: `P`, `Y`, `N`.

Then, on a live game day: read the prompts in Grafana beside the autopilot's decisions.
