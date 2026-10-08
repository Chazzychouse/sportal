# Scenario days: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every game day the feed log recorded plays as a scenario by its date; the corpus and the archive are gone.

**Spec:** `docs/specs/2026-10-07-scenario-days-design.md`.

## Constraints

- Starts once `hub-abstractions` is merged. Names are that branch's as merged; where they differ from this plan, the
  merged code wins.
- The live Hub's behaviour does not change.
- `AGENTS.md` governs; on a conflict with Effect 4's idiom, Effect wins.
- Each task ends with `pnpm check` passing, and a commit.

---

## Task 0: Rebase

- [ ] `git rebase main` in `../sportal-scenario-days`, `pnpm install`, `pnpm check` passes.

## Task 1: The corpus and the archive go

- [ ] Delete `apps/hub/src/corpus/`, `provider/Archiver.ts`, `provider/espn/EspnArchiver.ts` (+ test),
  `TestEspnArchiver.ts`, any `espn/fixtures/` payload only they read, `Espn.layerArchival`, `HubConfig.corpusDir`
  (`SPORTAL_CORPUS_DIR`), and the `corpus` script.
- [ ] Remove their entries from `knip.json`, `.dependency-cruiser.cjs` and `tsconfig.base.json`'s comment, and any
  dependency knip then reports unused.
- [ ] Docs: ADR 0011 (scenarios are recorded days; supersedes ADR 0010's corpus decision and archive amendment); ADR
  0010's status line; the corpus and archive rows of `CONTEXT.md`; `AGENTS.md`'s corpus mentions (replace the
  `CorpusDay` and `CorpusLine.of` examples with real ones from code that stays); `docs/technical-spec.md`'s Corpus
  section, tree rows and diagram edges.
- [ ] `grep -rni "corpus\|archiv\|backfill\|synthesis"` over `apps packages AGENTS.md CONTEXT.md docs/technical-spec.md`
  and the tooling configs finds nothing. Commit `refactor(hub): the corpus and the archive go`.

## Task 2: A scenario's frames stream

`Scenario` becomes `{ name, origin: DateTime.Utc, frames: Stream<Frame, ScenarioUnreadable> }`. `load` reads only the
first frame for `origin`. `Gzip` gains a streaming decompress, sharing its transform with `decompress`.
`ScenarioProvider` plays the stream; a stream that fails partway is logged at `Error` and then delivers nothing.

Tests:
- [ ] `Gzip`: should give back the text a chunked gzip stream holds; should fail for bytes that are not gzip.
- [ ] `Scenarios`: existing tests run the stream; should give origin without running the frames; should fail
  `ScenarioUnreadable` for a file with no frames; should fail the stream partway on a bad line.
- [ ] `ScenarioProvider`: should end its frames, logged, when the scenario's stream fails partway.
- [ ] Commit `refactor(scenario): a scenario's frames stream`.

## Task 3: A scenario's feed log is always in memory

- [ ] Remove `HubConfig.scenarioFeedLog` (`SPORTAL_SCENARIO_FEED_LOG`) and its filter; `HubMode` uses
  `FeedLog.layerMemory`. Drop `Database` from `HubMode` and its depcruise exception if unused.
- [ ] Delete the tests of the file feed log (`HubMode`: "…SPORTAL_SCENARIO_FEED_LOG names…"; `ScenarioProvider`: "…and
  nothing to feed.sqlite", "…on a restart…") and their helpers.
- [ ] Docs: the setting's mentions in `AGENTS.md`, `CONTEXT.md`, `docs/technical-spec.md`. Checklist row 44 checks the
  day's frame count in `feed.sqlite` is unchanged, not its modification time.
- [ ] Commit `refactor(hub): a scenario's feed log is always in memory`.

## Task 4: Every recorded game day is a scenario

- A name that is a `GameDay` loads that day from the data directory's `feed.sqlite`; any other name is a fixtures file.
- `names` lists fixtures, then `FeedLog.days`.
- The day's feed log is opened only inside `names` and `load`, and only if `feed.sqlite` exists. Nothing creates it,
  and nothing appends to it.
- A day's frames are `replay(GameDay.dayStart(day))` up to the next day's start, without `seq`. A checkpoint the replay
  looks back for, from before 04:00, is received at 04:00 instead.
- A day with no frames is `ScenarioUnknown`.

Tests (`Scenarios`, with a temp data dir written by `FeedLog.layerTest` and a fixed zone):
- [ ] should list the feed log's game days after the fixtures;
- [ ] should list no days, and create no `feed.sqlite`, when the data directory has none;
- [ ] should load a day's frames in order, none from before 04:00 or from 04:00 the next day;
- [ ] should receive a looked-back checkpoint at the day's start;
- [ ] should fail `ScenarioUnknown` for a day with no frames;
- [ ] should append nothing to the day's feed log;
- [ ] `HubMode`: should play a game day from the data directory's feed log.
- [ ] Docs: Scenario and Scenarios in `CONTEXT.md`, the `SPORTAL_SCENARIO` command in `AGENTS.md`, the scenario lines
  of `docs/technical-spec.md`; checklist row 44 plays the day just recorded.
- [ ] Commit `feat(scenario): every recorded game day is a scenario`.

## Task 5: The two old recordings, once (throwaway, not committed)

- [ ] Restore `ImportRecording.ts` and `Recording.ts` from `15cfc97^` into the scratchpad, mapped to the merged
  `Frame` fields (`poll`/`push`, `whole`/`change`, `number`). Back up `.sportal/feed.sqlite`, then append
  `fixtures/espn-recordings/2026-10-03/college-football` and `2026-10-04/nfl` to it, refusing if either day is there.
- [ ] Check that `2026-10-03` and `2026-10-04` are listed. The user eye-checks both at 10×.

## Task 6: The unit holds

- [ ] `pnpm check`; `pnpm dev:golden` eye-checked by the user; code review; the user's `plannotator review`.
- [ ] On merge, the `docs/history.md` row.

## Known risk

The scenario clock starts at the real time, so a long day played in the evening crosses 04:00. If `Board` rolls its day
then, the slate drops the games partway. Task 4 checks and reports it; it is not fixed here unless asked.
