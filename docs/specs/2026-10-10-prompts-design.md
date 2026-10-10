# Prompts

2026-10-10. Piece 4 of the automation roadmap ([Classification](2026-10-10-classification-design.md), [Break
detection](2026-10-10-break-detection-design.md), [Autopilot](2026-10-10-autopilot-design.md) and its
[ranking](2026-10-10-autopilot-ranking-design.md)). The autopilot only steers the games already on a tile. A prompt
brings in a game that is on no tile: when one enters a red zone or crunch time and is better than the weakest game on
screen, the top bar asks whether to watch it. Nothing changes unless you say yes.

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

The prompt is the best qualifying candidate by rank, then score, then slate order; or none. One prompt at a time: a better
candidate takes the prompt over, and the one it replaced comes back when it is again the best and still qualifies.

A prompt lasts as long as a step still gives it. When its game leaves the red zone or crunch time, gets a tile, loses
its stream, or no longer outranks the target, the prompt goes. No timer.

With prompts off, or the Screen soloed, there is no prompt.

### Accepting

Accepting sends, as your commands, `Assign { tile: target, game }` then `Promote { tile: target }`:
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
### `apps/web/src/prompts/Prompt.ts`

`Prompt`, a `Data.Class`: `game`, `rank` (`redZone` or `crunchTime`), `since`, `target` (the tile index), and
`replaces: Option<{ game, rank }>` (none when the target is empty). `commands()`: the `Assign` then `Promote` that
accept it. `words(nameOf)`: `PHI @ DAL — red zone, replaces CHI @ GB (on a break)`, or `…, into an empty tile`.

### `Screen.tileFor`

`tileFor` in `Screen.ts` becomes a static, `Screen.tileFor(game, availability)`, so a prompt and an assign agree on
what streams.

### `AutopilotState.yours`

A writable atom taking a `ScreenCommand`: it sends the command to the Screen and, when the Screen applies it, to the
autopilot as yours (`Commanded`). `DisplayState.display` sends its steps' commands through it, as it does today inline,
and accepting a prompt sends its two commands through it; so both are yours to the autopilot without `PromptsState`
importing `DisplayState` (which imports `PromptsState` for the hotkeys).

### `apps/web/src/prompts/PromptsState.ts`

As `AutopilotState`:

- `PromptInput`, a `Data.TaggedEnum`: `Toggled`, `Accepted`, `Dismissed`.
- `prompts`: an `Atom.kvs` (`sportal/prompts`, default `Prompts.initial`) behind a writable atom. `Toggled` toggles;
  `Accepted` sends the current prompt's commands through `AutopilotState.yours`; `Dismissed` dismisses it. Accepting or
  dismissing with no prompt does nothing.
- `prompt`: a derived atom, `prompts.prompt(screen, live)`, recomputed on each change of the three.
- `log`, mounted by the Display beside `pilot`: `Effect.logInfo("Prompt: …")` when a prompt is shown (with what it
  would replace), taken over, accepted, dismissed, or closed because it no longer holds, annotated with
  `prompt.game`, `prompt.rank` and `prompt.target`. Sent to `sportal-web` through the existing OTLP logger.

### The prompt in the top bar

`PromptView` in `apps/web/src/prompts/PromptView.tsx`, in the `TopBar` after the prompts toggle, while `prompt` holds a
prompt; nothing when it holds none. It reads the prompt's words, `PHI @ DAL — red zone, replaces CHI @ GB (on a
break)` or `…, into an empty tile`, cut to the bar's width with the whole line as its tooltip, and has two buttons:
`Watch · Y` accepts, `Skip · N` dismisses. No timer.

Not a toast: a toast with two buttons is taller than the 44px bar, and what falls below it lies under the native video
views, which draw above the page. In full screen there is no top bar, so no prompt is seen there; `Y` and `N` still
answer it.

### The toggle

`apps/web/src/prompts/PromptsToggle.tsx`, a bell in the `TopBar` beside the autopilot's toggle. Its tooltip:
`Prompts off`, `Prompts on`, or `Prompts on: showing PHI @ DAL`, each followed by ` · P`.

### Hotkeys

In `@sportal/api/Hotkey`: `TogglePrompts` on `P`, `AcceptPrompt` on `Y`, `DismissPrompt` on `N`, in a `Prompts`
group of the keys. Pressed in a stream view too, like the others: the shell reads the same `Hotkey.of`. The keys dialog
gains the `Prompts` group. `DisplayState.inputs` sends the three to `PromptsState.prompts`, as it sends
`ToggleAutopilot` to the autopilot; `Display.press` does nothing with them.

## Docs

CONTEXT.md, Automation: **Prompt** (the top bar asking whether to bring a game on no tile into the main tile, when it is
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
- `PromptsState.test.ts`: accepting leaves the game in the main tile with the sound; accepting with no prompt does
  nothing; accepting makes the main tile yours to an autopilot that is on; dismissing closes the prompt; a toggle is
  kept in this browser.
- `DisplayState.test.ts`: the `TogglePrompts` hotkey turns prompts off.
- `Display.test.ts`: the three prompt hotkeys change nothing in the Display.
- `Hotkey.test.ts`: `P`, `Y`, `N`.

Then, on a live game day: read the prompts in Grafana beside the autopilot's decisions.
