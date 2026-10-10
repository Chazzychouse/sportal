# Autopilot layout

2026-10-10. A step on the [Autopilot](2026-10-10-autopilot-design.md), before the prompts (piece 4): while it is on, the
autopilot also fits the layout to the games worth showing. One game left is a Single, two a Pair, and so on, never
past the layout you chose.

It stays a web fold: the slate's classifications are still the ranking, and nothing changes in the Hub or the domain.

Not in this spec: pulling a game that is on no tile onto the Screen (the prompts), reshuffling on-screen games by
interest, choosing between Quad and MainThree by the moment, and changing splits.

## Behaviour

### Home layout and ceiling

Turning the autopilot on takes the **home layout** from the Screen; a `SetLayout` you send (a palette item or the
next-layout hotkey) sets it. The home layout is the **ceiling**: the autopilot shrinks the layout when fewer games are
worth showing and grows it back as they start, never past it. The next-layout hotkey cycles from the layout on screen (a fitted one included), and what it gives becomes
the ceiling. Each home layout has a ladder:

| Home        | Ladder                                      |
| ----------- | ------------------------------------------- |
| `Single`    | `Single`                                    |
| `Pair`      | `Single` → `Pair`                           |
| `Quad`      | `Single` → `Pair` → `Quad`                  |
| `MainThree` | `Single` → `Pair` → `MainThree`             |
| `MainFive`  | `Single` → `Pair` → `MainThree` → `MainFive` |

### Worth showing

An occupied tile's game is **worth showing** while it is in progress: any moment but `Upcoming` and `Final`, a `Break`
included. A `Final` game is still worth showing for `finalHold` (2 min) from its classification's `since`, so you see
the end. A game with no classification is worth showing, as it counts as live for the main tile; the autopilot never
shrinks out of doubt.

### Fitting

Slot 0 is the main tile's: fitting never moves it, the main tile's rules or you do. The games to show are the main
tile, which always counts as one (even empty or finished), and every other occupied tile's game worth showing.

- The **target layout** is the smallest on the ladder with a slot for each game to show. With no game worth showing
  at all, on any tile, it is the home layout: before kickoff and at the end of the night you see the whole ceiling.
- **Shrinking**: before the `SetLayout`, each game worth showing in a slot the target layout does not keep is swapped
  into a kept slot (from 1) that holds no game worth showing, lowest first, so none goes to the bench.
- **Filling**: each slot from 1 that the layout shows and that holds no game worth showing (a finished game or an
  empty tile) is swapped with the first benched game worth showing, in tile order.
- With more games worth showing than the ceiling has slots, only finished and empty slots are filled; on-screen games
  are not reshuffled.

A game that starts grows the layout at the next step; a finished one shrinks it once its hold runs out.

### Order with the main tile and the sound

Each step, unless the Screen is soloed: fitting first, unless the layout is suspended or there is no home layout; then
the main tile's and the sound's rules as before, on the Screen after the fitting commands. The step's commands are the
fitting commands, then the main tile's and the sound's.

### Manual input

The layout is a third part with its own `suspension` (3 min). The suspension table becomes:

| Command                                       | Suspends    |
| --------------------------------------------- | ----------- |
| `Promote`                                     | main tile   |
| `Solo`                                        | main, sound |
| `Swap` with tile 0 as `a` or `b`              | main tile   |
| `Swap` of two other tiles                     | layout      |
| `Assign` or `Clear` of tile 0                 | main tile   |
| `Assign` or `Clear` of another tile           | layout      |
| `FocusAudio`                                  | sound       |
| `SetLayout`                                   | layout      |
| `SetSplit`, `Unsolo`, any other               | nothing     |

`SetLayout` also sets the home layout. When the layout's suspension runs out, the next step fits under the ceiling
you left.

### Status

After the main tile's and the sound's statuses: the layout yours (`layout yours for 2:41`), then **fitted**, while the
layout is not suspended and the Screen's layout is not the home layout (`fitted to 2 tiles`), then idle.

## Web

### `apps/web/src/autopilot/Fit.ts`

Pure:

- `finalHold = 2 min`.
- `fit(screen, ceiling, classifications, now): ReadonlyArray<ScreenCommand>`: the `Swap`s, then the `SetLayout`, that
  fit `screen`; none when it fits. Each is built against the Screen after the ones before it.
- `nextFit(screen, classifications, now): Option<DateTimeUtc>`: the earliest end of a `Final` hold still ahead, for a
  game on a tile.

### `apps/web/src/autopilot/Autopilot.ts`

- `home.layout: Option<LayoutName>` (`OptionFromOptionalKey`, so an autopilot kept before this change decodes with
  none, and fits nothing until toggled) and `suspended.layout`.
- `Part` gains `"layout"`; `toggle` takes the home layout from the Screen; `manual` follows the table and sets
  `home.layout` on `SetLayout`.
- `step` fits first as above.
- `nextDeadline(now, screen, classifications)` also gives `nextFit`.
- `status(now, screen)` gains `Fitted { slots }`; the `Yours` part may be the layout.

### `apps/web/src/autopilot/AutopilotState.ts`

The pilot's deadline follows both the autopilot and the live state, switching to the latest deadline when either
changes, so a `Final` hold's end steps it.

### `apps/web/src/autopilot/AutopilotToggle.tsx`

Reads the Screen for `status`, and words `Fitted` and a layout `Yours`.

## Docs

- The autopilot spec: "Not in this spec" points here for the layout.
- CONTEXT.md: Ceiling and Fit.

## Testing

`Fit.test.ts`, one rule per test: a starting game grows the layout; a `Final` game shrinks it only after `finalHold`;
it never goes past the ceiling; nothing worth showing is the ceiling; slot 0 is never moved; a shrink moves games
worth showing into kept slots first; a benched game worth showing fills a finished slot; a game with no classification
counts; more games than slots fills only finished slots; `nextFit` gives a hold's end.

`Autopilot.test.ts`: each new row of the table; `SetLayout` sets the ceiling; fitting runs before a promote and the
promote is built on the fitted Screen; a suspended layout is not fitted; `nextDeadline` includes a hold's end; the
`Fitted` and layout `Yours` statuses.

`AutopilotState.test.ts`: with TestClock, a `Final` game's hold running out shrinks the layout.

`AutopilotToggle.test.ts`: the `Fitted` and layout `Yours` wording.

Then, on a live game day: whether 2 min feels right, whether fitting and chasing together ever fight, whether next-layout from a fitted layout should lower
the ceiling, the jump to the full ceiling when every game is over, and the sound moving when a shrink benches its game.
