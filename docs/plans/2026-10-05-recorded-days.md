# Recorded Game Days Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saturday's and Sunday's real game days become 19 recorded scenarios. A test runs Watchability over every one of them and checks rules that must hold on any day. The first rule it breaks, college overtime counted as a lull, is fixed.

**Architecture:** `CutScenario` learns the file names of Sunday's recorder, then cuts the catalogue's windows into `fixtures/scenarios/`. A domain test decodes every slice there as a `Scenario` and folds `Watchability` across its frames, each frame judged at the instant it was recorded (`origin + at`), so the run is deterministic and needs no clock. Each broken rule names the scenario, the instant, and the game. `GameSnapshot` gains the knowledge that college overtime has no clock, and Watchability's lull uses it.

**Tech Stack:** Effect 4 (`Schema`, `DateTime`, `FileSystem`), `@effect/vitest`.

**Spec:** `docs/specs/2026-10-05-recorded-days-design.md` (D2, D3, C1). Work only in the worktree `/home/chazzy/development/projects/sportal/.worktrees/recorded-days-design` (branch `recorded-days-design`). Never touch the main checkout, except to read its ignored recordings.

## Global Constraints

- Read `AGENTS.md` first. Effect 4 is newer than most training data: check `node_modules/effect/ai-docs/src/` before writing Effect code from memory.
- No new exported type and no new `CONTEXT.md` term. "Recorded scenario" is already a Scenario.
- An operation on a domain type is a method of its class. Logic is a pure function or an `Effect`; no `for` loops over mutable accumulators where `Array` and `Option` combinators fit; nothing caught and ignored.
- Main export first; private helpers below as hoisted `function` declarations; no options-bag type aliases; no `any`, casts outside decoding, non-null assertions, enums, or default exports.
- The raw recordings are ignored by git and live only in the main checkout: `RECORDINGS=/home/chazzy/development/projects/sportal/fixtures/espn-recordings`. Saturday is `$RECORDINGS/2026-10-03/college-football`, Sunday `$RECORDINGS/2026-10-04/nfl`.
- Tests sit beside their file. Run one with `pnpm vitest run <path>`. `pnpm check` must pass before every commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Files

| File | Responsibility |
| --- | --- |
| `apps/hub/src/provider/espn/CutScenario.ts` (modify) | `instantOf` also reads `<epoch seconds>.<millis>.json.gz` |
| `apps/hub/src/provider/espn/CutScenario.test.ts` (modify) | Cuts a recording with Sunday's names |
| `fixtures/scenarios/*.json` (create, 19) | The catalogue's cut slices |
| `packages/domain/src/Game.ts` (modify) | `GameSnapshot#timed()` |
| `packages/domain/src/Game.test.ts` (modify) | Its cases |
| `packages/domain/src/Watchability.ts` (modify) | Lull at 0:00 only in a timed period |
| `packages/domain/src/Watchability.test.ts` (modify) | Unit case for overtime, and the recorded-days rules |
| `AGENTS.md`, `docs/game-day-checklist.md` (modify) | The cutter takes either recorder's names; record each game day into `fixtures/espn-recordings/<date>/<league>/` |

---

### Task 1: The cutter reads Sunday's recorder

**Files:**
- Modify: `apps/hub/src/provider/espn/CutScenario.ts` (`instantOf`)
- Test: `apps/hub/src/provider/espn/CutScenario.test.ts`
- Modify: `AGENTS.md` (the `scenario:cut` line)

**Interfaces:**
- Consumes: nothing new.
- Produces: `instantOf(file: string): Option.Option<DateTime.Utc>` stays private. It now takes `20261003T160848Z.json.gz` (Saturday's `record.sh`) or `1791130515.585.json.gz` (Sunday's `record.py`: epoch seconds, a dot, then milliseconds), and nothing else.

- [ ] **Step 1: Write the failing tests** in `CutScenario.test.ts`, reusing `recordingOf`. It currently writes `<instant>.json.gz` under `college-football/`. Let it take the file stems as given and a league folder (`"college-football" | "nfl"`); the existing three tests pass `"college-football"`.
  - `"reads polls named in epoch seconds, timed to the millisecond"`: a recording with `1791130515.585` and `1791130525.541` inside a window around them. Frame `at`s are `[0, 9956]`, and `origin` is `2026-10-04T16:15:15.585Z`. Convert the epochs with `DateTime.makeUnsafe(seconds * 1000)` in the test, so no expected instant is computed by hand wrongly.
  - `"skips a file that is neither name"`: with `notes.txt` and `1791130515.585.json.gz.tmp` beside one good poll, there is one frame.
- [ ] **Step 2: Run it and see it fail.** `pnpm vitest run apps/hub/src/provider/espn/CutScenario.test.ts`. Expected: the first new test fails with `CutFailed` ("no scoreboard poll … falls in the window").
- [ ] **Step 3: Implement.** Give `instantOf` a second pattern, `^(\d{10})\.(\d{3})\.json\.gz$`, which becomes `DateTime.makeUnsafe(seconds * 1000 + millis)`. Match the two patterns as alternatives with `Option.orElse`; keep the existing branch as it is.
- [ ] **Step 4: Run and pass.** The same command; all five tests pass.
- [ ] **Step 5: Check it against the real day.** Run `pnpm --filter @sportal/hub scenario:cut bogus-clock-two-minute $RECORDINGS/2026-10-04/nfl 2026-10-04T17:48:30Z 2026-10-04T17:51:15Z 401872970`. Expect about 17 frames, written to `fixtures/scenarios/bogus-clock-two-minute.json`. In that file, LAR@PHI (`401872970`) shows clock `1:01` in Q2 for about 83 s, then `9:31`. Delete the file afterwards; Task 2 makes it again.
- [ ] **Step 6: Docs.** In `AGENTS.md`, the `scenario:cut` sentence says the recording may come from either recorder (`record.sh` names or `record.py` epoch names).
- [ ] **Step 7: `pnpm check`, then commit** `feat(hub): scenario:cut reads Sunday's recorder, named in epoch seconds`.

### Task 2: Cut the catalogue

**Files:**
- Create: 19 files in `fixtures/scenarios/`
- Modify: `docs/game-day-checklist.md`

**Interfaces:**
- Consumes: Task 1's cutter.
- Produces: `fixtures/scenarios/<name>.json` for each name below, each a valid `Scenario`. Task 3 reads them all.

- [ ] **Step 1: Cut each window.** Run `pnpm --filter @sportal/hub scenario:cut <name> <recording> <from> <to> <game ids…>` for each line. The arguments, in that order, are:

```
maction-double-finish $RECORDINGS/2026-10-03/college-football 2026-10-03T22:19:00Z 2026-10-03T22:49:00Z 401866477 401866434 401858248 401856710 401856709
overtime-and-final-drive $RECORDINGS/2026-10-03/college-football 2026-10-03T19:46:00Z 2026-10-03T20:07:00Z 401858252 401866432 401866431 401866430
uk-sc-tying-drive-solo $RECORDINGS/2026-10-03/college-football 2026-10-03T23:20:00Z 2026-10-03T23:48:30Z 401856709 401858247 401858472 401858478 401856821
uk-sc-overtime-and-delay $RECORDINGS/2026-10-03/college-football 2026-10-03T23:48:00Z 2026-10-04T00:04:00Z 401856709 401862790 401856818 401860898 401858478
crowded-fourth-quarter $RECORDINGS/2026-10-03/college-football 2026-10-03T18:51:00Z 2026-10-03T19:21:00Z 401856822 401856819 401862791 401858474 401858252 401866432
cal-unlv-phantom-touchdown $RECORDINGS/2026-10-03/college-football 2026-10-03T22:52:00Z 2026-10-03T23:08:00Z 401858247 401858248 401856710 401856709
syr-conn-stale-tied-finish $RECORDINGS/2026-10-03/college-football 2026-10-03T19:28:00Z 2026-10-03T19:46:00Z 401858252 401866432 401856819 401866431
mich-minn-period-flap $RECORDINGS/2026-10-03/college-football 2026-10-03T18:29:30Z 2026-10-03T18:40:00Z 401858474 401858252 401858251 401856819 401856822
halftime-status-flaps $RECORDINGS/2026-10-03/college-football 2026-10-03T21:15:00Z 2026-10-03T21:40:00Z 401866431 401862793 401869956 401864514 401858472 401856709
night-all-lull $RECORDINGS/2026-10-03/college-football 2026-10-04T04:17:00Z 2026-10-04T04:40:00Z 401860921 401856817 401860900 401856820 401864513
late-go-ahead-cascade $RECORDINGS/2026-10-04/nfl 2026-10-04T20:00:00Z 2026-10-04T20:17:00Z 401872971 401872967 401872970 401872973 401872966 401872969 401872974
four-touchdowns-in-150-seconds $RECORDINGS/2026-10-04/nfl 2026-10-04T19:50:00Z 2026-10-04T19:56:30Z 401872971 401872970 401872967 401872969 401872968 401872972
goal-line-stand-overturned-touchdowns $RECORDINGS/2026-10-04/nfl 2026-10-04T17:13:00Z 2026-10-04T17:21:00Z 401872972 401872970 401872971 401872966 401872973
halftime-staggered-return $RECORDINGS/2026-10-04/nfl 2026-10-04T18:22:00Z 2026-10-04T18:49:00Z 401872968 401872972 401872967 401872969 401872971 401872966 401872973 401872970
first-half-two-minute-drills $RECORDINGS/2026-10-04/nfl 2026-10-04T18:08:00Z 2026-10-04T18:33:00Z 401872966 401872967 401872968 401872969 401872970 401872971 401872972 401872973
q3-red-zone-pileup $RECORDINGS/2026-10-04/nfl 2026-10-04T18:53:00Z 2026-10-04T19:05:40Z 401872971 401872972 401872966 401872973 401872967 401872969
q4-lull-solo-lead-change $RECORDINGS/2026-10-04/nfl 2026-10-04T19:25:00Z 2026-10-04T19:31:00Z 401872967 401872969 401872972 401872968 401872973
slate-handover-4pm $RECORDINGS/2026-10-04/nfl 2026-10-04T20:03:00Z 2026-10-04T20:30:00Z 401872973 401872966 401872971 401872967 401872969 401872970 401872974 401872976 401872977 401872975
bogus-clock-two-minute $RECORDINGS/2026-10-04/nfl 2026-10-04T17:48:30Z 2026-10-04T17:51:15Z 401872970
```

- [ ] **Step 2: Check each slice.** Every file should have more than one frame, and every frame should hold every game named. If a game is missing, it was not on that poll's scoreboard: report it, do not drop it silently. Add up the sizes: they should be a few megabytes in all. If any one is over 2 MB, report it before committing.
- [ ] **Step 3: Spot-check that the moments are there,** using `jq` on the slices:
  - `uk-sc-overtime-and-delay`: UK@SC (`401856709`) reaches period 5 with clock `0:00`.
  - `cal-unlv-phantom-touchdown`: one team's score goes 30, then 24, then 30.
  - `halftime-staggered-return`: some frame has all eight games at `halftime`.
- [ ] **Step 4: Play one.** `SPORTAL_SCENARIO=late-go-ahead-cascade SPORTAL_SCENARIO_SPEED=10 pnpm --filter @sportal/hub dev`, then `curl -s localhost:4400/api/health`. Expected: it answers, and the log says `ScenarioProvider: playing late-go-ahead-cascade`. Stop the Hub.
- [ ] **Step 5: Docs.** Add a row to `docs/game-day-checklist.md`: record the day with the recorder into `fixtures/espn-recordings/<date>/<league>/`, never `~/.cache`, and then cut its moments.
- [ ] **Step 6: `pnpm check`, then commit** `feat(fixtures): nineteen recorded scenarios from 2026-10-03 and 2026-10-04`.

### Task 3: Watchability over every recorded day

**Files:**
- Test: `packages/domain/src/Watchability.test.ts`

**Interfaces:**
- Consumes: `Scenario` (its schema decodes a slice), `Watchability.fold`, `GameSnapshot#progress()`, and Task 2's slices.
- Produces: a `describe("Watchability over recorded game days")`. Later properties, including the Director's, join it.

**How it runs.**
- It reads every `*.json` in `fixtures/scenarios/` and decodes each as a `Scenario`. Read them the way other tests read fixtures: `readFileSync` with `new URL("../../../fixtures/scenarios/", import.meta.url)`. That is the only file access, and it is in a test, so `packages/domain` stays pure.
- It uses `Watchability.fold` across the frames. Each frame is judged at `origin + at`.
- A rule that breaks fails with lines like `uk-sc-overtime-and-delay 2026-10-03T23:58:12Z 401856709: in a lull at 0:00 in overtime`. Gather every breach of a rule into one assertion, so one run lists them all.

- [ ] **Step 1: Write the rules as tests,** one `it` each:
  - `"finds the recorded scenarios"`: at least 19 slices decode. This guards against a path mistake that would pass every other test vacuously.
  - `"is the same when a day is played twice"`: folding a slice twice gives equal watchability at every frame.
  - `"scores a game that is not being played 0"`: whenever `progress()` is not `"live"`, the score is 0.
  - `"never puts an overtime in a lull for its clock alone"`: in period 5 or later, a live game is never a lull when its status is `live`, play showed within the last 60 s, and no break is on. In those conditions only the 0:00 clock can make the lull.
- [ ] **Step 2: Run them.** `pnpm vitest run packages/domain/src/Watchability.test.ts`. Expected: the first three pass. The overtime rule fails, listing frames from `uk-sc-overtime-and-delay` and `overtime-and-final-drive`. This is spec C1, seen in real data. If any other rule fails, stop and report it: it is a finding, not something to tune away.
- [ ] **Step 3: Do not commit yet.** A red rule is not committed, and it is not skipped. Go on to Task 4, which commits the two tasks together.

### Task 4: College overtime is not a lull for its clock

**Files:**
- Modify: `packages/domain/src/Game.ts`, `packages/domain/src/Game.test.ts`
- Modify: `packages/domain/src/Watchability.ts` (`judged`, the lull)
- Test: `packages/domain/src/Watchability.test.ts`

**Interfaces:**
- Produces: `gameSnapshot.timed(): boolean`. It is true when the current period runs on a game clock, so a 0:00 clock means the period is over. It is false for a college overtime (`league` is `"fbs"` and `period >= 5`). NFL overtime has a clock.

- [ ] **Step 1: Write the failing unit tests.**
  - In `Game.test.ts`, `"knows a college overtime has no clock"`: fbs Q4 is timed, fbs period 5 is not, nfl period 5 is timed.
  - In `Watchability.test.ts` under `Watchability.initial`, `"is not in a lull at 0:00 in a college overtime, but is in an NFL one"`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - `GameSnapshot#timed()`, with a doc comment that says why: ESPN shows a college overtime's clock as 0:00.
  - In `judged`, the clock part of the lull becomes `game.timed() && game.secondsLeft() === 0`.
  - Check `inTwoMinuteDrill` and `closeness`. Both already key on `period` 2 and 4, or 5 and over, so neither should change. Confirm that, and do not edit them on a guess.
- [ ] **Step 4: Run both files.** The unit tests and Task 3's four rules all pass.
- [ ] **Step 5: `pnpm check`, then commit** `fix(domain): a college overtime is not a lull for its 0:00 clock; Watchability rules over recorded game days`.

---

## Not in this plan

- **C2, C3, D5:** the live-feed spec takes these up: staleness from the feed going quiet, the stale-rule wording, and a delivery log in scenarios. They are a revision of that spec, in its worktree.
- **D4:** lull flapping waits on your decision. If it is a bug, its rule joins Task 3's suite.
- **D6:** synthetic faults wait for D5.
- **The push-only faults:** `fastcast-stall-burst`, `pat-phantom-play-ids`, and `quiet-feed-not-stale` show nothing in scoreboard polls, so they are not cut. They wait for D5.
