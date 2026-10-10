# Autopilot ranking

2026-10-10. A redesign of the [Autopilot](2026-10-10-autopilot-design.md)'s chase. Home (the main tile's game and the
sound game you chose, which the autopilot left and came back to) made it hard to predict and hard to trust. Without
home, the autopilot is one ranking and a dwell: the main tile shows the best game, holds it a while, and gives way
only to a game in a higher rank or when it stops. Every step's decision goes to Grafana, and timeline tests replay
scripted game days through the pure fold.

This spec supersedes the autopilot spec's Home, Away-worthy, The main tile, The sound and the tooltip's wording; its
manual input table, on and off, and the [layout spec](2026-10-10-autopilot-layout-design.md) stand, with the home
layout renamed the ceiling.

It also fixes the classifier: a big play no longer hides the break that follows it, so a game cut to commercials
after a touchdown ranks as a break.

Not in this spec: favourites, a tie-breaker for the game most recently back from a break, an in-app decision log,
replaying recorded game days, and the prompts (piece 4).

## Behaviour

### Ranking

Each game on a tile, on screen or benched, has a rank, highest first:

1. a red zone (`ScoringThreat`);
2. crunch time (`CrunchTime`);
3. a big play with no stop after it (`BigPlay`);
4. plain live play (`Live`), and a game with no classification;
5. a break (`Break`, whatever its `during` or `after`);
6. not live (`Upcoming`, `Final`).

Within a rank, the higher score first, then the lower tile. The first four ranks are **live**.

### The main tile

Each step, unless the main tile is yours, the Screen is soloed, or the autopilot is off:

- With no live game on any tile, nothing moves.
- Otherwise the best game is the first by the ranking. The main tile's game gives way to it when:
  - the main tile's game has **stopped**: on a break, not live, or on no tile (an empty main tile counts); or
  - the best game's rank is strictly higher, and the main tile's game has held the tile for `dwell` (30 s).
- Within a rank it never gives way for score; a red zone never hands off to another red zone.

Giving way is a `Promote` of the best game's tile, which swaps it with the main tile and moves the sound.

The autopilot keeps only what is in the main tile and since when (`main: { game, since }`), whoever put it there: it
starts its dwell clock when it sees a game it did not see last step, so your promote starts one too.

### The sound

The sound follows the main tile: after its own promote, or when the main tile holds a game the sound is not on, it
puts the sound on the main tile's game with `FocusAudio`. While the sound is yours, it leaves the sound alone (the
Screen moves it only when its game leaves the screen).

### Manual input

Unchanged: each command you send makes the parts in the autopilot spec's and layout spec's tables yours for
`suspension` (3 min). A `SetLayout` you send sets the ceiling. When a suspension runs out, the next step ranks again;
your game keeps the main tile only if it is still the best, or holds on by the rules above.

Solo freezes the autopilot, as before.

### Layout

As in the layout spec, under the **ceiling** (the layout you chose, taken when it is turned on and from each
`SetLayout` you send). Fitting runs first each step; the main tile and the sound are steered on the fitted Screen.

### Status

The toggle's tooltip, first that holds: off; the main tile yours (`main tile yours for 2:41`); the sound yours; the
layout yours; nothing live (`following: nothing live`); following the main tile's game and its rank (`following: PHI
@ DAL — red zone`, `crunch time`, `big play`, `live`), with `, fitted to 2 tiles` when the Screen's layout is not the
ceiling.

## Domain

### `Moment.Break.after`

`Break` gains `after: Schema.optional(Schema.Struct({ play: PlayId, kind: BigPlayKind }))`: the big play just before
the stop, while it lasts (`Classifier.bigPlayHold`).

### `Classifier`

- `momentOf`: a break reason, when one holds, wins over a big play: the moment is `Break`, with `during` as before and
  `after` the big play while it lasts. With no break reason, a big play is `BigPlay`, then stakes, then `Live`. A
  touchdown is a `Break` for `afterScore` with `after` as soon as it arrives; a turnover a `Break` for
  `possessionChange`; a long gain mid-drive stays `BigPlay`.
- `settled`: entering a break never waits (today `BigPlay` → `Break` would hold for `momentHold`, `Break` being lower
  in precedence). A break for the same reason keeps its `since` and `expectedEnd` when `after` runs out.

### Web: `MomentBadge`

A break with `after` shows the big play's icon beside `BRK`.

## Web

### `apps/web/src/autopilot/Ranking.ts`

Pure: `rankOf(moment: Moment | undefined): Rank` (the six ranks above, as a literal union `"redZone" | "crunchTime" |
"bigPlay" | "live" | "break" | "notLive"`), `isLive(rank)`, and `byRank(classifications)`: an `Order` over
`{ tile, game }` by rank, then score, then tile. The fold and the toggle both read it, so a rank has one name.

### `apps/web/src/autopilot/Autopilot.ts`

Rewritten as a `Schema.Class`, kept under `sportal/autopilot`:

- Fields: `on`; `main: Option<{ game, since }>`; `ceiling: Option<LayoutName>`; `suspended: { main, audio, layout }`.
  A value kept before this change decodes with no `main` and no `ceiling` (it fits nothing until toggled).
- `toggle(screen)`: on takes the ceiling from the Screen; off is `Autopilot.off`.
- `manual(command, after, now)`: the suspensions in the tables; a `SetLayout` sets the ceiling.
- `step(screen, classifications, now): { next, commands, decision }`: fit, then the main tile, then the sound, each
  on the Screen after the commands before it. Off or soloed: itself, no commands, and a decision saying so.
- `nextDeadline(now, screen, classifications)`: the main game's dwell end while a game in a higher rank waits, each
  suspension's end, and `nextFit`.
- `status(now, screen)`: the tagged union the toggle words.
- Gone: `home`, `away`, `follow`, `Move`, `mainCommands`, the sound-only chase.

### `Decision`

A plain value, built by `step`, for the log:

- `ranking`: each occupied tile's game with its rank and score, best first.
- `layout`: `Fitted { from, to }`, `Yours { until }`, or `Kept`.
- `main`: `Promoted { game, over, why: "outranks" | "stopped" }`, or `Stayed { game, why }` with `why` one of `Best`,
  `SameRank`, `Dwell { left }`, `Yours { until }`, `NothingLive`.
- `sound`: `Followed { game }`, `Kept`, or `Yours { until }`.
- Or `Off`, or `Frozen` (soloed).

### `apps/web/src/autopilot/AutopilotState.ts`

- The writer, after each step, sets a `decision` atom to the step's decision.
- The `pilot` atom also streams `decision`, keeps those whose action or reason differs from the last logged (a
  reordered ranking alone, or a dwell's seconds counting down, is not a new decision), and logs each with
  `Effect.logInfo("Autopilot …")` and annotations: the parts' actions and reasons, the games, their ranks and scores,
  and the ranking.

### Web telemetry

- `WebRuntime` adds an OTLP logger (`effect/observability`, logs only), service `sportal-web`, a
  `service.instance.id` per page load, posting to the Hub's `/otlp/v1/logs`.
- The Hub relays `POST /otlp/v1/logs` unchanged to `SPORTAL_OTLP_URL`'s `/v1/logs` when it is set; without it, it
  answers `204` and drops the body. A failed relay warns once, as the Hub's own exporter does.

### `TestWeb.timeline`

`timeline(screen, autopilot, steps)`: each step an offset in seconds, the classifications then, and optionally a
command you send. It runs the pure fold as the Display would (your command through `Screen.apply` and `manual`, then
`step`, its commands applied in order) and returns each step's main game, the Screen's layout, and the decision.

## Docs

- The autopilot spec: a line at the top that this spec supersedes its chase.
- CONTEXT.md: Home and Away removed; Ranking and Dwell added; Ceiling as the layout you chose; Autopilot reworded.

## Testing

- `Classifier.test.ts`: a touchdown is a `Break` for `afterScore` with `after`; a turnover a `Break` for
  `possessionChange` with `after`; a long gain with no stop stays `BigPlay`; `BigPlay` to `Break` does not wait;
  `after` drops when the big play runs out, the break keeping its `since`.
- `Ranking.test.ts`: each moment's rank; the order by rank, score, tile.
- `Autopilot.test.ts`: one rule per test — promotes the best on a stopped main tile; waits out the dwell for a higher
  rank; never switches within a rank; nothing live moves nothing; yours is left alone and ranked again after; the
  sound follows; the decisions' reasons; `nextDeadline`; `status`; toggling and `manual`.
- `AutopilotTimeline.test.ts`, one scenario each: a touchdown's break hands off to a live game; a red zone holds
  through its dwell; crunch time beats plain live play but not a red zone; your promote holds 3 min, then the ranking
  decides; nothing live leaves the main tile; a finished game's hold shrinks the layout.
- `AutopilotState.test.ts`: a new decision is logged once; a dwell counting down is not logged again.
- Hub: the relay forwards a body to the collector, and answers `204` without one configured.

Then, on a live game day: read the decisions in Grafana and turn each surprise into a timeline scenario.
