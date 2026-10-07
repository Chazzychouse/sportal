# Readability pass — design

Status: approved in brainstorming, 2026-10-07; the code layout standard and Unit 3 added the same day at the user's
request. One branch, `readability`, in `../sportal-readability`, with three units run in order:

1. **Code**: plays as a tagged union that keeps ESPN's outcome, the domain slate's internals, the Hub's `LiveSlate` and
   `LiveStage` renames, and layout geometry moved to the web. Every test file these touch is rewritten to the testing
   standard (Unit 2), and every source file they touch is laid out to the code layout standard (Unit 3), as part of
   the same change.
2. **Tests**: the testing standard written into `AGENTS.md`, every remaining test file rewritten to it, the `Test*.ts`
   helpers reorganized, and Vitest split into projects.
3. **Code layout**: every remaining source file laid out to the code layout standard, which is written into
   `AGENTS.md` before Unit 1 starts.

The source is `docs/Scratch.md`'s list under "Readability pass": improve Play/PlayKind, rework Slate, make Layout a UI
concern, clean up the tests.

## Decisions

- **Behaviour is preserved, except that Play's wire shape changes.** Every other change is a refactor, and the
  existing tests (rewritten), the Hub's replay tests, and a corpus run over the recorded days prove it.
- **Play's shape changes everywhere it is stored or sent:**
  - `recentPlays` on the live stream: the web decodes with the same schema, so this needs nothing extra.
  - `GameHistory` stores each play as JSON. Game history can be rebuilt from the feed log, so a new migration
    drops its play rows and the history is rebuilt from the log. Old rows are not converted.
  - Written corpus days hold `Plays` deliveries. `corpus build` rewrites the captured days from the feed log, and
    `corpus backfill` rewrites backfilled days from the archive. A day that neither can rebuild is not deleted
    without asking the user.
- **Football gets its own play type now, because more sports are coming.** `Play` stays the name the rest of the
  code uses; for now `Play` is `FootballPlay`. The `mlb-postseason` spec's "`FootballPlay`: today's `Play`, renamed and
  tagged, unchanged" no longer holds: that branch rebases onto this union and adds `AtBat` beside it.
- **Metric names stay the same,** so the Grafana dashboard keeps working after the renames.
- **The testing standard applies to every test this branch writes or touches.** Unit 1 follows it before Unit 2
  writes it into `AGENTS.md`.
- **The code layout standard applies to every source file this branch writes or touches,** and is in `AGENTS.md`
  from the branch's first commit.

## The code layout standard

The source is dense, and not only for lack of blank lines. The share of blank lines in the densest Effect files is
2–5%: `HubConfig.ts` 1.7%, `CorpusBuild.ts` 3.4%, then `CorpusDay.ts`, `FastCast.ts`, `HubServer.ts` and `Slate.ts`.
Most TypeScript sits at 10–15%. `apps/hub/src/corpus/CorpusBuild.ts:21-80` shows the three causes:

- **A `yield*` buried in an argument.** `decoder.decode((yield* FeedLog).replay(from).pipe(...))` is read inside out to
  find the order of the steps.
- **A big calculation inside a constructor.** `new CorpusDay({ leagues: [...new Set(deliveries.flatMap(...
  Delivery.match ...))].toSorted(), games: ... })` makes the reader work out each field's meaning mid-construction.
- **No breaks between phases.** The function reads the services, decodes, checks, and assembles, with no gap between
  them.

The rules, written into `AGENTS.md`'s "Inside a file":

1. **A blank line between the phases of a generator block** (or any function body), not between every `yield*`.
2. **Each `yield*` on its own line, bound to its own `const`** (or standing alone as a statement), never nested inside
   another expression: `const feedLog = yield* FeedLog`, then `feedLog.replay(from)`. Every `yield*` then sits at the
   left margin and the block reads as a list of steps.
3. **Name a value that takes a calculation to build,** or a pipe more than two levels deep: `const leagues = …` and
   `const games = …` before the constructor, so the constructor is a plain list of fields.
4. **A long chain of steps that does one thing is a named function** that says what it does, as `CorpusLine.of`
   already is. It is a private helper below its user, or a method of the concept it operates on.

Rule 2 is checked mechanically: no `yield*` follows `(`, `[`, `{`, `,`, `.`, an operator, or another `yield*` on its
line. The others are checked in review. The blank-line share is a symptom, not a target, and is not checked.

## Unit 1: code

### `FootballPlay`: what ESPN's play type says

Today `EspnPlay` maps ESPN's type id to one of 16 `PlayKind` literals and loses the outcome. For example, Kickoff
Return Touchdown (32) reads as `kickoff`; a blocked, missed and good field goal all read as `fieldGoal`; and Safety
(20), Coin Toss (70), Fumble Return Touchdown (39), Punt Return Touchdown (34) and Extra Point Missed (62) read as
`other`.

**Rule:** every ESPN type id seen in the recordings decodes to a case that keeps all of what the id says. Nothing is
read from the play's text.

`FootballPlay` is a `Schema.Union` of `Schema.TaggedClass` cases. `PlayKind` is deleted.

**Fields on every case** come from one struct that each case spreads in: `id`, `sequence`, `period`, `clock`, `text`,
`homeScore`, `awayScore`, `scoring`, `homeWinProbability?`. `scoring` stays ESPN's own flag, because it can run
ahead of the type: 280 recorded `Rush` rows are flagged scoring.

**Fields on each snap, kick, safety and penalty:** `team`, `yards`, `start`, `end`. `Spot` keeps optional only the
fields that the recordings show can be missing for that case. The plan settles which against the fixtures.

| Case | ESPN type ids | Outcome field |
| --- | --- | --- |
| `Rush` | 5, 68 Rushing Touchdown | `touchdown: boolean` |
| `Completion` | 24, 4, 67 Passing Touchdown | `touchdown: boolean` |
| `Incompletion` | 3 | none |
| `Interception` | 63, 26 returned, 36 returned for a touchdown | `return: "none" \| "returned" \| "touchdown"` |
| `Sack` | 7, 80 the opponent recovers a fumble | `fumbleLost: boolean` |
| `Fumble` | 69, 9 own recovery, 29 opponent recovery, 39 return touchdown | `recovery: "unknown" \| "own" \| "opponent" \| "touchdown"` |
| `TwoPointTry` | 15 pass, 16 rush | `by: "pass" \| "rush"` |
| `Kickoff` | 53, 32 return touchdown | `returnTouchdown: boolean` |
| `Punt` | 52, 14 returned, 34 return touchdown | `return: "none" \| "returned" \| "touchdown"` |
| `FieldGoal` | 59 good, 60 missed, 18 blocked | `result: "good" \| "missed" \| "blocked"` |
| `ExtraPoint` | 61 good, 62 missed | `good: boolean` |
| `Safety` | 20 | none |
| `Penalty` | 8 | none |
| `Timeout` | 21 | `team?`: the team that called it |
| `Stoppage` | 74 official timeout, 75 two-minute warning, 70 coin toss | `kind: "officialTimeout" \| "twoMinuteWarning" \| "coinToss"` |
| `PeriodEnd` | 2, 65 half, 79 regulation, 66 game | `ends: "period" \| "half" \| "regulation" \| "game"` |
| `Other` | any id not in the table | `type: { id, text }` |

The ids are the 39 that appear in `fixtures/espn-recordings` and `apps/hub/src/provider/espn/fixtures` (tallied
2026-10-07). An unknown id still decodes, as `Other`, and `EspnPlay.unknownTypes` keeps reporting it.

**On the types:**

- `Play.order` and `Play.eventsSince` keep their behaviour.
- The questions that callers work out for themselves today move onto the cases: whether a snap is a big play, which
  team was sacked (`play.team ?? play.start.team`), and whether a play lost yards. This includes `eventsOf` in
  `Play.ts` itself.
- `RecentPlays`, `Delivery.Plays` and `GameHistory` keep naming `Play`.

**ESPN adapter:**

- `EspnPlay` has one table whose rows are an ESPN type id, its text, and the case and outcome it reads as. Reading
  and writing both use it: `typeOf` becomes the reverse lookup of the same rows, replacing the `kinds` and `types`
  tables.
- `EspnScript` writes a case back as the id it reads from.
- `Synthesis` matches on `Timeout` and `PeriodEnd` instead of comparing kinds.

**Scenarios:** a written scenario's play names a case and its outcome, e.g. `{ _tag: "Kickoff", returnTouchdown:
true, yards: 98 }`. `ScenarioScript`'s sentence table has one sentence per case and outcome.

**Web:** `Field.tsx` picks the arrow's course with one `$match` arm per case, and reads lost yardage and the team
with the ball from the play.

**`CONTEXT.md`:** a row for **Football play** and its cases. The **Play** row says `Play` is the plays of every sport,
football's only for now.

### The domain `Slate`'s internals

`packages/domain/src/Slate.ts` keeps its public surface: `empty`, `dayStart`, `take`, `tick`, `earliestDue`, `games`,
`recentPlays`, `everyGame`, `publishesSameAs`, `Taken`. Inside:

- **A private `Advancing` data class replaces the `Advanced` and `Listed` types.** It holds `live`, `finished`,
  `listed`, `events` and `observations`. Its methods have names: `observe`, `say`, `hold`, `release`, `guard`. The
  helpers call those methods instead of spreading `{ ...acc, observations: [...acc.observations, …] }`.
- **What one step did to one game is a private tagged union:** `Started | Changed | Stopped | Unheld`. One function
  decides it from the current live game, the step's new one, and whether that is current. One `$match` applies it.
  This replaces `settled`'s Option matches nested three deep.
- **`SlateObservation` moves to its own `SlateObservation.ts`.** It has its own `CONTEXT.md` row, and the Hub's
  telemetry is its reader.
- The file follows `AGENTS.md`: the `Slate` class first, then `Advancing`, then private helpers in the order they
  are first used.

**What proves the behaviour is unchanged:**

- `Slate.test.ts`, rewritten to the standard with every old assertion kept;
- the Hub's replay tests;
- `corpus run` over the recorded days: the same game events, in order, before and after. They are compared by game,
  instant and tag, and a `Played` event by its play's id, since the play's own shape changes in this unit.

### The Hub: `LiveSlate` and `LiveStage`

- **`apps/hub/src/Slate.ts` becomes `LiveSlate.ts`:** service `LiveSlate`, key `sportal/hub/LiveSlate`.
  `SlateTelemetry.ts` becomes `LiveSlateTelemetry.ts`. `Published` and `Following` stay with it. The domain `Slate` is
  imported under its own name everywhere, so the `DomainSlate` alias goes away.
- **`apps/hub/src/StageSessions.ts` becomes `LiveStage.ts`:** service `LiveStage`, key `sportal/hub/LiveStage`.
  - The old name and its `CONTEXT.md` row are wrong: there is one Stage, shared by every Display, with no session
    and nothing per Display.
  - `dispatch`, the atomic step, and the availability refresh stay as they are.
  - Its comments are trimmed to the two that explain a constraint: why the step is atomic, and why availability is
    read inside it.
- **`CONTEXT.md`:**
  - a **Live slate** row;
  - the **Slate** row describes only the domain fold;
  - **Stage sessions** becomes **Live stage**, with the definition corrected to: the Hub's one Stage, shared by every
    Display, applying stage commands one at a time and refreshing channel availability when the source changes.

### Layout geometry moves to the web

**Domain:** `packages/domain/src/Layout.ts` and its test are deleted. What `Stage` needs moves into `Stage.ts`, above
the class, since its fields read it:

- `LayoutName` and `Split`;
- a private table of each layout's slot count and default split;
- `Stage.slotCount(name)` and `Stage.splitBounds`.

`Stage.initial` keeps the default splits. `SetSplit` rejects `split-out-of-range` against `Stage.splitBounds`, so the
Hub enforces both rules it enforces today. `Stage.currentLayout()` is removed.

**Web:** `apps/web/src/layout/Layout.ts` holds the `Layout` class (`name`, `split`), beside `LayoutPicker` and
`LayoutGlyph`. It has:

- `Layout.of(stage)`;
- `slots()`;
- `Layout.dividers(name)`;
- `Layout.next(name)`;
- `Layout.clamp(split)`, which reads `Stage.splitBounds`.

Its users switch to it: `TileRects`, `StageMap`, `Dividers`, `Display`, `LayoutPicker`, `LayoutGlyph`. The geometry
tests move to `apps/web/src/layout/Layout.test.ts`, and the slot-count and split tests stay in `Stage.test.ts`.

## Unit 2: tests

### The standard, in `AGENTS.md`

A new **Tests** section:

- **One behaviour per test.** A test that checks several cases becomes one test per case. `it.each` is used only when
  the cases really are one behaviour over different inputs.
- **Descriptions use "should":** `it("should order plays by sequence")`. The `describe` names the unit under test,
  e.g. `describe("Play.eventsSince")`.
- **Arrange, Act, Assert,** separated by blank lines, with no `// Arrange` comments. A test with nothing to arrange
  is Act, then Assert.

The existing rules stay: tests beside the file, written test-first, providers tested against recorded payloads.

### Helpers

- **A `Test*.ts` module is named for the one concept it builds or fakes, and sits beside that concept's module.**
- `apps/hub/src/TestFeed.ts` is split by concept. Today it holds frames and deliveries, decoders, a live slate
  harness, and the written scenarios.
- `TestGame.polled` operates on a `Slate`, not a game, so it moves out of `TestGame.ts`.
- A helper only one test file uses moves to the bottom of that file.
- `knip.json`'s `Test*.ts` exclusions keep working under the new names.

### Test files

- A test file tests one module. `Slate.replay.test.ts` is folded into `LiveSlate.test.ts` or split by what it tests;
  the plan decides which after reading it.
- Long files (`LiveGame`, `Game`, `Slate`, `Stage`, `FeedLog`, …) get builders in place of repeated setup, and one
  `describe` per method or behaviour.

### Vitest

- The root `vitest.config.ts` becomes `test.projects`, one project per workspace (`domain`, `api`, `hub`, `web`,
  `desktop`).
- The web project owns the `@/` alias.
- `pnpm test` and `pnpm check` work as they do today, and `pnpm --filter <workspace> test` runs one project.

### Proving nothing was lost

- Before Unit 2 starts, record v8 coverage (`vitest run --coverage`). After it, no file's line or branch coverage
  is lower.
- Every assertion of an old test exists in some new test. Each commit's body lists, for each file it rewrites, the
  old test names and the new tests that carry their assertions, so the review can check it.
- One commit per test file, or per small group of related files. `pnpm check` passes on every commit.

## Unit 3: code layout

Every source file (`apps/*/src/**`, `packages/*/src/**`, excluding tests, `apps/web/src/design/`, and the wire
schemas' field lists) is laid out to the code layout standard. The densest files go first: `HubConfig.ts`,
`CorpusBuild.ts`, `CorpusDay.ts`, `FastCast.ts`, `HubServer.ts`, then the rest of the Hub, the domain, the web, and the
desktop shell.

- Behaviour is unchanged. The tests are not touched in this unit; they pass unchanged on every commit.
- A helper extracted under rule 4 follows "Inside a file": below its user, a hoisted `function`, or a method of its
  concept when it operates on one.
- One commit per file, or per group of small files in one folder.

## Physical changes

```
packages/domain/src/
  Play.ts                 FootballPlay union and its cases; Play = FootballPlay; PlayKind gone
  Slate.ts                Advancing, per-game step union (private)
  SlateObservation.ts     new: moved out of Slate.ts
  Stage.ts                gains LayoutName, Split, slotCount, splitBounds
  Layout.ts, Layout.test.ts   deleted
apps/hub/src/
  Slate.ts → LiveSlate.ts
  SlateTelemetry.ts → LiveSlateTelemetry.ts
  StageSessions.ts → LiveStage.ts
  TestFeed.ts             split by concept
  provider/espn/EspnPlay.ts   one type table
apps/web/src/layout/
  Layout.ts, Layout.test.ts   new: the geometry
vitest.config.ts          projects
AGENTS.md                 Tests section; code layout rules in "Inside a file"
CONTEXT.md                Football play, Live slate, Live stage; Slate and Play rows updated
```

## Out of scope

- The Hub `LiveSlate` service's internals and the telemetry's structure, beyond the rename and Unit 3's layout.
- The `web-one-command-path` goal.
- Any change to behaviour other than Play's wire shape.

## Done when

- Every ESPN type id in the recordings decodes to its table row's case, and none of them to `Other`, checked by a
  test over the fixtures.
- `corpus run` over the recorded days gives the same game events before and after Unit 1, compared as the slate
  section says.
- No `PlayKind`, `DomainSlate`, `StageSessions` or domain `Layout` remains.
- Every test follows the standard, and no file's coverage dropped.
- No source file has a nested `yield*`, and every source file has been through Unit 3's review.
- `pnpm check` passes on every commit, `plannotator review` on the branch is approved, and the branch is merged.
