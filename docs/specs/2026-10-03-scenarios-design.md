# Scenarios and Synthetic Streams — Design

Date: 2026-10-03
Status: Approved 2026-10-03

Piece 1 of [the Director design](2026-10-03-director-design.md).

## Goal

Play a game day on demand. A **scenario** is a timeline of game snapshots for several games, either written in
TypeScript or cut from the ESPN recordings. Tests read it directly. A Hub started with `SPORTAL_SCENARIO` plays it
in place of ESPN, at any speed, and a **Scenario** source plays each game as a synthetic stream page instead of a
YouTube TV channel. That lets the Stage, the shell, and later the Director be exercised end to end, with no
provider, no sign-in, and no stream budget.

## Decisions

| Question | Decision |
| --- | --- |
| What a scenario is | `Scenario` in `packages/domain`: a name, an origin instant, and frames. Each frame is an offset from the start and the whole slate at that offset (`GameSnapshot`s). `GameSnapshot` stays the only game format and the JSON form is the wire schema, so no second format exists |
| Reading one | `scenario.slateAt(start, elapsed)`: the latest frame at or before `elapsed`, every instant in it (kickoffs) shifted by `start − origin`. Before the first frame, the first frame. After the last frame, the last frame: the day holds where it ended |
| Writing one | `Scenario.build(name, games)` takes a data array of games, each `{ id, home, away, league?, network?, timeline: [offset, change][] }`. A game starts from `TestGame.snapshot`, and each `["m:ss", change]` sets the game from that offset on (depcruise's `test-game-is-for-tests` rule lets `Scenario.ts` and `scenarios/` import `TestGame`). Changes merge onto the game's previous state, and `ball: { team, yardLine, down, distance }` fills `Situation`, deriving `isRedZone` from the yard line. The builder compiles to frames, one per distinct offset |
| Named scenarios | One file each in `packages/domain/src/scenarios/`, plus `Scenarios.ts` there, listing them by name. The first set: `two-minute-drill-tie`, `three-red-zones-at-once`, `all-lulls-but-one`, `blowout-and-upset-brewing`, `kickoff-window` (games going live one after another). They are written to be what the Director must handle; piece 2 and 3 tests read them |
| Recorded slices | `pnpm --filter @sportal/hub scenario:cut <name> <recording-dir> <from> <to> [game ids…]` decodes each scoreboard poll in the window through the ESPN decoder (`EspnPayload`) and writes `fixtures/scenarios/<name>.json` in the `Scenario` schema. Optional game ids keep a slice small. The ESPN decoder is reused, not copied |
| Picking one | `SPORTAL_SCENARIO=<name>` names a built scenario, or a slice in `fixtures/scenarios/`. An unknown name stops the Hub at startup, listing the names it knows. `SPORTAL_SCENARIO_SPEED` (default 1) speeds it up; it must be a finite number above 0, or the Hub refuses to start |
| Scenario time | In scenario mode, `main.ts` provides a **scenario clock** to Ingest and the Scenario provider: it starts at the Hub's start and runs `speed` times faster, and its sleeps are shortened to match. Cadence then needs no change: at 10×, a 10-second poll is one real second. Later the Director runs on the same clock, so its holds and cooldowns scale too. The rest of the Hub keeps the real clock |
| Scenario provider | `ScenarioProvider`, an adapter behind the existing `Provider` port: `slate(league)` returns `slateAt(start, elapsed)` filtered to the league |
| Scenario source | `ScenarioSource`, an adapter behind the existing `Source` port. Every game is carried: a channel named for the game's first network (or "Scenario" when it has none), source `"Scenario"`, locator `WebView` at `/scenario-stream/<game id>`. `readGuide`, `learn`, `markNotCarried`, `forget` succeed and do nothing; `changes` never emits. `SourceName` gains `"Scenario"` |
| Relative locator | The Hub does not know which origin serves the UI (4401 in dev, 4400 built), so the locator is a path. The web UI resolves it against its own origin when it builds tile placements; YouTube TV's absolute addresses are unaffected |
| Shell allowlist | `allows` also accepts the UI's own origin under `/scenario-stream/`, and nothing else on it. The UI origin is the address the shell already loads (`SPORTAL_HUB_URL`) |
| Synthetic stream page | `/scenario-stream/<game id>` in the web UI, routed in `main.tsx` like `/remote`. Full-bleed: a slowly moving test pattern (so a frozen stream is obvious), and over it, in type readable from a quarter-size tile, the teams with logos, score, period and clock, down and distance and yard line, a red-zone mark, the status, and the game id small in a corner. It reads the slate from the Hub's live stream like every view |
| Sound | Each page plays a quiet steady tone, its pitch from the game id, so moving audio focus is heard. The shell's mute does the rest. The provider views need no user gesture to start sound (`autoplayPolicy` on the provider session's views, if Electron's default blocks it) |
| What else changes in scenario mode | Nothing. The Stage, Stage sessions, the live stream, the strip, the Remote, and the channel store behave as they do on a real day; the channel store is simply never consulted |
| Not in scope | Pausing, seeking, or restarting a running scenario (restart the Hub); a UI for choosing a scenario; Playwright end-to-end tests; NFL recordings (none exist yet) |

## Code

- **Domain.** `Scenario.ts`: the `Scenario` class (`slateAt`, `build`) and its frame schema. `scenarios/*.ts`:
  one named scenario each, and `Scenarios.ts` listing them. `Source.ts`: `SourceName` gains `"Scenario"`.
  Tests: `Scenario.test.ts` for the builder (merging, red zone from yard line, frame order) and `slateAt` (shift,
  before first, after last).
- **Hub.** `scenario/ScenarioClock.ts`, `scenario/ScenarioProvider.ts`, `scenario/ScenarioSource.ts`, each tested
  on the test clock. `provider/espn/CutScenario.ts` with its `scenario:cut` script, tested against one recorded poll; it lives in the ESPN folder because depcruise forbids other folders importing the ESPN payload.
  `main.ts` reads `SPORTAL_SCENARIO` and `SPORTAL_SCENARIO_SPEED` and wires the three in place of `EspnProvider`,
  `YouTubeTv`, and the real clock for Ingest; it is the only file that names them.
- **Web.** `scenario/ScenarioStream.tsx` (the page) and its tone; `main.tsx` routes `/scenario-stream/`.
  `TileRects.ts` resolves a relative locator against `window.location.origin`.
- **Desktop.** `ProviderSession.ts`' `allows` takes the UI origin and admits `/scenario-stream/` on it; tests for
  the new and still-refused cases.
- **Docs.** Glossary rows for **Scenario** and **Scenario time**; `AGENTS.md` gains the `SPORTAL_SCENARIO` command;
  a game-day checklist row: `SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_SCENARIO_SPEED=10 pnpm dev` shows four
  synthetic streams that tick, and audio focus is heard to move.

## Risks to check

| Risk | Check |
| --- | --- |
| A faster clock given to Ingest also speeds anything else it runs | It is provided to Ingest and the Scenario provider only; the `ScenarioProvider` test asserts the surrounding clock stays real |
| Recorded slices are large | Game ids filter a slice; a slice's size is printed when it is cut |
| A synthetic page in the provider session reaches beyond the UI | The allowlist admits only `/scenario-stream/` on the UI origin; everything else stays refused, as tested |
| Sound does not start without a gesture | Checked on the first run; `autoplayPolicy` on provider views if needed |
