# Autopilot

Its chase (home, away, the main tile and the sound) is superseded by [Autopilot ranking](2026-10-10-autopilot-ranking-design.md).

2026-10-10. The third piece of the automation (see the [Classification roadmap](2026-10-10-classification-design.md#roadmap)):
a Display may follow the classifications. While it is on, the autopilot promotes the best moment into the main tile
and moves the sound with it, then puts things back when the moment is over. What you choose is home; the autopilot
leaves home only for a moment that clearly beats it, and your input always wins.

It runs in each Display, on the classifications that already ride the live stream beside the slate. Nothing changes
in the Hub or the domain: the classifications are the ranking ADR 0015 anticipated.

Not in this spec: pulling a game that is on no tile onto the Screen (that is the prompts' job, piece 4), soloing (the
layout came after, in [Autopilot layout](2026-10-10-autopilot-layout-design.md)), returning ahead of a break's
`expectedEnd`, BigPlay as a reason to move, coordination between Displays, and the Remote.

## Behaviour

### Home

Home is the main tile's game and the game whose sound is on, each optional. Turning the autopilot on takes home from
the Screen. After every screen command you send, home becomes what the Screen then shows.

### Away-worthy

A game is **away-worthy** when its moment is `ScoringThreat` or `CrunchTime`. A `Break` is never away-worthy, even
with a `during`; `BigPlay` is not either.

Of several games, the **best** is the one whose moment is most worth chasing (a red zone, then crunch time, then a big
play, then plain live play), then the highest score; ties go to the lower tile index. "Comes first" below means by
that order. (`Moment.precedence` puts a big play first, for commentary; the autopilot does not chase a play already
over.)

### The main tile

Each step, unless the main tile is suspended or the Screen is soloed, the autopilot works out a target among the
occupied tiles, on screen and benched:

- **Home live** (`Live`, `BigPlay`, `ScoringThreat`, `CrunchTime`): if home is itself away-worthy, the target is home.
  Otherwise it is the best away-worthy game other than home, if any, else home.
- **Home stopped** (`Break` or `Final`), or no home game on any tile (a home game with no classification, or
  upcoming, counts as live but never away-worthy): the best game whose moment is live (any of the
  four above) other than home, if any, else home. This is "no commercials": a stopped home game is left even for a
  plain `Live` game.

While a game is **away** (in the main tile because the autopilot put it there):

- It holds the main tile for at least `dwell` (30 s) from when it was promoted, unless its moment becomes `Break` or
  `Final` or it is on no tile.
- After that, it is replaced only by a target whose moment comes strictly first, or when it stops being
  a target for its own sake: no longer away-worthy (home live) or no longer live (home stopped). A red zone never
  hands off to another red zone.
- When it stops being a target, the autopilot goes to the new target; when that is home, this is the **revert**:
  `Promote` home's tile, then `FocusAudio` home's sound game when it is on screen and not the main game. Because
  `Promote` swaps with slot 0, a revert puts every tile back where it was.

Going away is `Promote` of the target's tile, which also moves the sound.

### The sound

While the main tile is suspended (you chose the main game) and the sound is not, the autopilot runs the same rules
for the sound alone: over on-screen tiles only (sound cannot be on a benched game), against home's sound game, with
`FocusAudio` in place of `Promote`, and the same dwell and order. Otherwise the sound follows the main tile; while
the sound is yours, a promote is followed by a `FocusAudio` that puts it back on your game.

### Manual input

Every screen command you send (a hotkey, a palette item, a tile button, a drop) updates home. Some also suspend part
of the autopilot for `suspension` (3 min) from when you sent it, each part on its own timer:

| Command                                       | Suspends    |
| --------------------------------------------- | ----------- |
| `Promote`                                     | main tile   |
| `Solo`                                        | main, sound |
| `Swap` with tile 0 as `a` or `b`              | main tile   |
| `Assign` or `Clear` of tile 0                 | main tile   |
| `FocusAudio`                                  | sound       |
| `SetLayout`, `SetSplit`, `Unsolo`, any other  | nothing     |

A command the Screen refuses is not yours either; it changes nothing.

A suspension ends any away of its part: the autopilot does not revert what you chose. When it runs out, the next
step decides from the home you left.

While the Screen is soloed, the autopilot does nothing.

### On and off

Off by default, for each Display, and kept in its browser. A toggle in the top bar and the hotkey `A` turn it on and
off. Turning it on takes home from the Screen; turning it off forgets the away game and the suspensions and leaves
the Screen as it is.

The toggle's tooltip says what it is doing: off; following, nothing to chase; away on a game and why (`PHI @ DAL —
red zone`, `crunch time`, `home is on a break`); or the main tile or the sound yours for the time left (`main tile
yours for 2:41`).

## Web

### `apps/web/src/autopilot/Autopilot.ts`

A pure fold, a `Data.Class`, like the Classifier:

- Fields: `on: boolean`; `home: { main: Option<GameId>, audio: Option<GameId> }`;
  `away: { main: Option<{ game, since }>, audio: Option<{ game, since }> }`;
  `suspended: { main: Option<DateTimeUtc>, audio: Option<DateTimeUtc> }` (until when).
- Statics: `off`, `dwell = 30 s`, `suspension = 3 min`.
- `toggle(screen, now)`: on takes home from `screen`; off is `Autopilot.off`.
- `manual(command, screenAfter, now)`: home from `screenAfter`, and the suspensions in the table, ending their part's
  away.
- `step(screen, classifications, now): readonly [Autopilot, ReadonlyArray<ScreenCommand>]`: the rules above. Tile
  indexes come from `screen`; a lapsed suspension is dropped. Off, or soloed, it returns itself and no commands.
- `nextDeadline(): Option<DateTimeUtc>`: the earliest away's dwell end and suspension end still ahead.
- `status(now)`: a tagged union, `Off | Idle | Away { game, why } | Yours { part, until }`, which the view words.

Because the Display keeps it, it is a `Schema.Class` if `Atom.kvs` needs a schema; the shape is the same.

### `apps/web/src/autopilot/AutopilotState.ts`

- `autopilot`: kept in the browser with `Atom.kvs` under `sportal/autopilot`, as `DisplayScreen` keeps the Screen.
- A driver, mounted once by the Display: on each live update and at `nextDeadline()`, it steps the autopilot with the
  Screen and the live classifications and writes each command to `DisplayScreen.screen`. A refused command is
  dropped; the next step decides again.
- `DisplayState.display`'s writer, in its `Atom.batch`, hands each of your commands and the Screen after it to
  `manual`. The autopilot's own commands go straight to the Screen, so they never count as yours.

### View and hotkey

- `ToggleAutopilot` in `@sportal/api/Hotkey`, on `A`; the keys dialog, the palette and the shell's key map follow.
- A toggle in `TopBar`, on or off, with the status as its tooltip.

## Docs

- ADR 0015: one line under Consequences, that the classifications on the slate are the ranking for now.
- CONTEXT.md: Autopilot, Home, Away and Suspension.

## Testing

`Autopilot.test.ts`, one rule per test, with Screen and Classification builders:

- off does nothing; soloed does nothing;
- home live, a red zone on another tile: promotes it; home itself in the red zone: stays;
- a benched game in the red zone is promoted;
- home on a break, another game plain live: promotes it (no commercials);
- the away game holds through `dwell` though its moment ends; a break cuts it short;
- a second red zone does not replace the first; crunch time does not replace a red zone, and a red zone over
  crunch time waits out the dwell;
- the moment over, it reverts: home's tile back in slot 0, the tile order as before, the sound back on home's sound
  game;
- a manual `Promote` suspends the main tile, home becomes the promoted game, and the sound still moves to a red zone
  on screen; after `suspension` the main tile follows again;
- a manual `FocusAudio` suspends only the sound;
- `nextDeadline` gives the dwell's end, then the suspension's.

`AutopilotState.test.ts`: a live update with a red zone sends a `Promote` to the Screen; a command sent through the
Display suspends the main tile.

Then, on a live game day: whether a 30 s dwell and 3 min suspension feel right, and how often "no commercials" jumps.
