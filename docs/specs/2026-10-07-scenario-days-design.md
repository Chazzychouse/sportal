# Scenario days — design

Status: approved in brainstorming on 2026-10-07. Starts once `hub-abstractions` is merged, and is written against
its `Frame`, `Provider` and `Board`. The next step is the plan.

## Goal

Every game day the Hub records is a scenario, with nothing to run. The corpus, the archive and every constraint they
carry are removed.

What the user named:

- Record scenarios live, always; keep it simple.
- Remove the corpus and its constraints.
- Building scenarios from the provider's archive is cut too, with all of its constraints.

After this work, there are two kinds of scenario, and both are only frames:

```
SPORTAL_SCENARIO=2026-10-11              → that game day's frames, read from feed.sqlite
SPORTAL_SCENARIO=crowded-fourth-quarter  → fixtures/scenarios/crowded-fourth-quarter.frames.jsonl.gz
```

## Decisions

- **The feed log is the recording.** It already writes down every live game day. A scenario day reads it back; nothing
  copies it, exports it or cuts it.
- **Nothing builds a scenario.** A day the Hub did not record cannot be played. If a need for that shows up, it comes
  back as its own design.
- **The truth is the feed log alone.** ADR 0010's amendment ("the feed log and the archive") is undone.
- **Behaviour of the live Hub does not change.** Only scenario mode, the corpus and the archive change.

## A scenario day

- **Its name is a game day,** `YYYY-MM-DD`, read by the `GameDay` schema. Any other name is a fixtures file, as today.
- **Its frames** are the feed log's `replay` from `GameDay.dayStart` of that date, taken while a frame's `receivedAt` is
  before the next day's start, each stripped of its `seq` to a `Frame`.
- **It is read from the data directory's `feed.sqlite`,** and nothing is appended to it. `Scenarios.layer` provides
  `FeedLog.layerInDataDir` to itself, so that feed log never reaches the rest of the Hub, which in scenario mode has the
  scenario's own feed log in memory.
- **`Scenarios.names`** lists the fixtures files, then `FeedLog.days`. A day with no frames is not listed, and naming it
  is `ScenarioUnknown`, as an unknown file is.

### `Scenario`

A whole day does not fit in memory as an array, so a scenario's frames become a stream.

```ts
/** Games a Hub plays as its provider: a provider's frames, in order of receipt. */
class Scenario extends Data.Class<{
  readonly name: string
  /** When it starts: its first frame's receipt. */
  readonly origin: DateTime.Utc
  readonly frames: Stream.Stream<Frame, ScenarioUnreadable>
}> {}
```

- `load` reads only the first frame to find `origin`. A fixtures file streams its lines through `Gzip`; a day streams
  the feed log's `replay`.
- `ScenarioProvider` plays `frames` at their offsets from `origin`, as it does today. Its "playing … frames" log line
  drops the count, which would take a second pass.
- A file that stops reading partway is logged at Error, naming the file, and the provider then delivers nothing more. A day cannot fail
  this way: the feed log's replay treats an unreadable row as a defect, as live does.

### The scenario's own feed log is always in memory

`SPORTAL_SCENARIO_FEED_LOG` and `HubConfig.scenarioFeedLog` are removed, with the rule that it is "never the game
day's log", its file-name filter, `HubMode`'s `scenarioFeedLog` layer and their tests. A scenario appends to
`FeedLog.layerMemory`, so playing a day never appends to `feed.sqlite`. Opening it can still touch the file (its
migrations, its journal), so checklist row 44's "`feed.sqlite`'s modification time does not change" becomes "the
day's frame count in `feed.sqlite` does not change".

## What is removed

| Removed | Notes |
|---|---|
| `apps/hub/src/corpus/`, every file | `corpus.ts`, `worker.ts`, `CorpusDay`, `CorpusLine`, `CorpusBuild`, `CorpusRun`, `Synthesis`, `TestCorpus`, and their tests |
| `provider/Archiver.ts` | the port, `GameArchive`, `PlayArchive`, `ArchiveFetchFailed` |
| `provider/espn/EspnArchiver.ts`, `TestEspnArchiver.ts` | and their tests, and any `espn/fixtures/` payload only they read |
| `Espn.layerArchival` | `Espn.ts` keeps `layer` and `layerScenario` |
| `HubConfig.corpusDir`, `SPORTAL_CORPUS_DIR` | and their tests |
| `HubConfig.scenarioFeedLog`, `SPORTAL_SCENARIO_FEED_LOG` | see above |
| the `corpus` script in `apps/hub/package.json` | |

Kept: `EspnSummary.ts` and `EspnPlay.ts`, which the live decode reads; `FeedLog.replay`, which `Board` and scenario
days read; and `FeedLog.days`, which `Scenarios.names` reads.

## Docs and rules

- **ADR 0011, "Scenarios are recorded days; the corpus is gone":** supersedes ADR 0010's corpus decision and its
  "the truth is the feed log and the archive" amendment. ADR 0010's poll fallback stays in force. ADR 0010's status
  becomes "Accepted; its corpus half superseded by ADR 0011".
- **CONTEXT.md removes:** Corpus, the "Every corpus `date` is one" sentence of Game day, Corpus day, Captured day, Backfilled day, Corpus
  input, Corpus line, Had, Corpus day unreadable, Corpus run, Subject, Corpus build failed, Run day, Day run, Days
  failed, Archiver, Game archive, Play archive, Synthesis, Lag model, Archive fetch failed.
- **CONTEXT.md changes:** Scenario (a recorded game day from the feed log, or a fixtures file), Scenarios, Scenario
  unknown, Scenario unreadable.
- **`AGENTS.md`:** the providers rule names only `HubMode.ts` and tests; the entry-point row names only `main.ts`; the
  two examples that use `CorpusDay` and `CorpusLine.of` are replaced with examples from code that stays; the
  `SPORTAL_SCENARIO` command says a name is a game day or a fixtures file, and drops `SPORTAL_SCENARIO_FEED_LOG`.
- **`docs/technical-spec.md`:** the Corpus section, the corpus and archiver rows of the tree, the corpus edges of the
  diagram, and "the corpus CLI" in rule 9 go; the scenario lines say what a scenario is now.
- **Tooling:** knip's `corpus.ts` and `worker.ts` entries, depcruise's corpus exceptions and its
  `test-espn-archiver-is-for-tests`, `test-corpus-is-for-tests` and archiver fixture rules, and `tsconfig.base.json`'s
  comment that names the corpus command and `effect/workers`. If nothing else uses `effect/cli` or `effect/workers`,
  that note goes with them.
- **`docs/history.md`** gets the unit's row when it merges.

## The two old recordings, once

A throwaway script, not kept, imports `fixtures/espn-recordings/2026-10-03/college-football` and
`fixtures/espn-recordings/2026-10-04/nfl` into the data directory's `feed.sqlite` as frames, in receipt order:
scoreboard polls by their file times, and the NFL day's FastCast messages and checkpoints from `fastcast.jsonl`. They
then play as `SPORTAL_SCENARIO=2026-10-03` and `SPORTAL_SCENARIO=2026-10-04`. The script refuses a day the feed log
already has frames on. `fixtures/espn-recordings/` stays: it is the only committed copy of those days.

## Sequencing

Each phase ends with `pnpm check` passing. Heavy checks run one at a time.

1. **Remove the corpus and the archive,** with their config, tooling, docs and ADR 0011.
2. **Scenarios stream,** for fixtures files, with `ScenarioProvider` reading the stream. Every recorded scenario still
   plays.
3. **Scenario days** from the feed log, and `SPORTAL_SCENARIO_FEED_LOG` removed.
4. **Import the two recordings,** once, and play `2026-10-03` at 10× and `2026-10-04` at 10×, eye-checked by the user.

## Tests

- **`Scenarios`:**
  - names list the fixtures files and the feed log's days;
  - a game-day name loads that day's frames, and none from the day before or after;
  - a day the feed log has no frames on is `ScenarioUnknown`;
  - a file that is not gzip'd frames is `ScenarioUnreadable`;
  - `origin` is the first frame's receipt.
- **`ScenarioProvider`:** every frame of a streamed scenario is played at its offset on the test clock, and a file that
  fails partway logs and ends the stream.
- **`HubMode`:** playing a day appends nothing to the day's feed log; its frames are the same before and after.
- **`HubConfig`:** the tests of the removed settings go; nothing else changes.
