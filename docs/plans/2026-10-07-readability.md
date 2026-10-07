# Readability pass — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry out `docs/specs/2026-10-07-readability-design.md`.

**Architecture:** One branch, `readability`, in `../sportal-readability`. Tasks run in order, with one commit each
unless a task says otherwise, and every commit passes `pnpm check`. Task 0 writes the code layout standard into
`AGENTS.md` and records the baselines. Unit 1 (Tasks 1–8) changes the code; Unit 2 (Tasks 9–17) changes the tests;
Unit 3 (Tasks 18–22) lays out the remaining source; Task 23 checks and reviews the whole branch.

**Tech Stack:** Effect 4 (`effect`, `@effect/platform-node`, `@effect/sql`), Vitest 5 with `@effect/vitest`, React 19,
Biome, dependency-cruiser, knip, pnpm workspaces.

## Global constraints

- **Read first.** Read `AGENTS.md`, `CONTEXT.md` and the spec before any task. Their rules apply to every line.
- **Effect 4 is newer than training data.** Before writing Effect code, read
  `node_modules/.pnpm/effect@4.0.0/node_modules/effect/ai-docs/src/index.md` and the example it points to. Copy the
  patterns of the file you are editing. Never write Effect from memory. Tagged unions of schemas:
  `Schema.Union([...]).pipe(Schema.toTaggedUnion("_tag"))` gives `.match`, `.guards` and `.cases` (see its doc in
  `effect/dist/Schema.d.ts`); `Delivery.ts` is the house example of `Schema.TaggedUnion`.
- **No bodies in this plan.** It gives signatures, behaviour and test cases. Each task names the existing code whose
  patterns to follow.
- **Testing standard (every test this branch writes or touches):**
  - One behaviour per test. Several cases are several tests; `it.each` only when the cases are one behaviour over
    different inputs.
  - `it("should …")`; the `describe` names the unit (`describe("Play.eventsSince")`).
  - Arrange, Act, Assert, separated by a blank line each, with no `// Arrange` comments. Nothing to arrange: Act, then
    Assert.
  - Rewriting a test keeps every assertion it had. The commit body lists, per rewritten file, each old test name and
    the new test names that carry its assertions.
- **Code layout standard (every source file this branch writes or touches):**
  1. A blank line between the phases of a generator block or function body, not between every `yield*`.
  2. Each `yield*` on its own line, bound to its own `const` (or a statement alone), never nested in another
     expression: not `decoder.decode((yield* FeedLog).replay(from))`, nor `{ port: yield* Config.Port(…) }`.
  3. A value that takes a calculation to build, or a pipe more than two levels deep, gets a name before it is used;
     a constructor is a plain list of fields.
  4. A long chain of steps that does one thing is a named function (a private helper below its user, or a method of
     its concept), as `CorpusLine.of` is.
- **Nested `yield*` check** (rule 2), used by Tasks 8, 22 and 23; both commands print nothing when it holds:
  `rg -n 'yield\*' -g '*.ts' -g '*.tsx' -g '!*.test.ts' <paths> | rg -v '^\S+:\d+:\s*((const|let) [^=]+ = |\w+ = |return )?yield\* '`
  and `rg -n 'yield\*.*yield\*' -g '*.ts' -g '*.tsx' -g '!*.test.ts' <paths>`. On `main` they find 65 and 17 lines.
  A `yield*` that starts a line inside a multi-line argument list escapes the check; review catches it.
- **Behaviour:** preserved everywhere except Play's wire shape. A test whose assertion changes for any other reason
  is a defect in the change, not in the test.
- **Commands:** `pnpm check` before every commit. One file: `pnpm vitest run <path>`.
- **knip:** no export lives only for its tests (`knip --production`). `Test*.ts` files are outside knip's production
  project.
- **Glossary:** every new exported type name gets its `CONTEXT.md` row in the same commit; a renamed one moves its row.
- **Services:** yielded where used; nothing indexes `X["Service"]`.
- **Comments:** doc comments on major exports; inline comments only for a non-obvious why. Trim restating comments in
  code you move.
- **TypeScript:** no `any`, non-null assertions, enums, default exports, or casts outside decoding.
- **Commits:** conventional prefixes as in `git log`; every commit ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **The main checkout:** never edit `../sportal`. The user runs the app from it. Reading its `.sportal/` is fine.

## Setup

- [ ] `git worktree add ../sportal-readability -b readability main` then
  `cd ../sportal-readability && pnpm install --frozen-lockfile --prefer-offline`.
- [ ] `pnpm check` passes.

## File map

| File | Task | Change |
| --- | --- | --- |
| `AGENTS.md` | 0, 9 | code layout rules (0); Tests section (9) |
| `packages/domain/src/Play.ts` | 1 | `FootballPlay` union and its cases; `Play = FootballPlay`; `PlayKind` gone |
| `packages/domain/src/TestGame.ts` | 1, 10 | `play` builds a case; `polled` moves out (10) |
| `apps/hub/src/provider/espn/EspnPlay.ts` | 1 | one type table |
| `apps/hub/src/provider/espn/EspnSummary.ts`, `EspnScript.ts` | 1 | timeout by case; write back by the table |
| `apps/hub/src/scenario/ScenarioScript.ts`, `scenario/written/*.ts` | 1 | a script play names a case |
| `apps/hub/src/corpus/Synthesis.ts`, `CorpusInput.ts`, `fixtures/2026-10-04-ne-buf.push.ndjson` | 1 | match cases; format 2; golden regenerated |
| `apps/web/src/game/Field.tsx` | 1 | `$match` per case |
| `apps/hub/src/GameHistory.ts` | 2 | migration `2_drop_plays` |
| `packages/domain/src/SlateObservation.ts` | 3 | new, moved out of `Slate.ts` |
| `packages/domain/src/Slate.ts` | 4 | `Advancing`, `GameStep` (private) |
| `apps/hub/src/Slate.ts` → `LiveSlate.ts`, `SlateTelemetry.ts` → `LiveSlateTelemetry.ts` | 5 | rename |
| `apps/hub/src/StageSessions.ts` → `LiveStage.ts` | 6 | rename |
| `packages/domain/src/Stage.ts`, `Layout.ts` (deleted), `apps/web/src/layout/Layout.ts` (new) | 7 | geometry to the web |
| `vitest.config.ts`, workspace `vitest.config.ts` files, `package.json` | 9 | Tests section; projects; coverage |
| `apps/hub/src/TestFeed.ts` (split), `.dependency-cruiser.cjs`, `knip.json` | 10 | helpers by concept |
| every `*.test.ts` | 11–16 | the testing standard |
| every other source file | 18–21 | the code layout standard |

## Task 0: The code layout standard, and baselines

- [ ] **`AGENTS.md`:** add the four code layout rules (Global constraints above) to "Inside a file", after rule 7,
  with the `CorpusBuild.ts` example of rule 2 and rule 3 as one before/after pair of two lines each. Commit
  `docs(agents): the code layout rules`.

The rest of Task 0 writes only to the scratch directory `$SCRATCH` (the session's scratchpad) and commits nothing.

- [ ] **Corpus days.** Build captured days from the main checkout's feed log with the code as it is on `main`:
  `SPORTAL_DATA_DIR=<abs>/sportal/.sportal SPORTAL_CORPUS_DIR=$SCRATCH/corpus-before pnpm --filter @sportal/hub corpus build --all`.
  Expect at least one day. If the feed log yields none, stop and tell the user; do not fabricate days.
- [ ] **Events dump.** Write `$SCRATCH/dump-events.ts` (not committed): for each date under `<corpusDir>/days/`, run
  `CorpusRun.day(date, CorpusRun.events)` from the worktree's `apps/hub/src/corpus/CorpusRun.ts` with `CorpusDays`
  and `DateTime.layerCurrentZoneLocal` provided (copy the layer setup from `CorpusWorker.ts`), and write one line per
  event: `{ date, game, at, tag, play? }`, where `play` is `event.what.play.id` for `Played` and absent otherwise.
  Run it over `corpus-before` into `$SCRATCH/events-before.jsonl`.
- [ ] **Golden push file.** Copy `apps/hub/src/corpus/fixtures/2026-10-04-ne-buf.push.ndjson` to
  `$SCRATCH/ne-buf.push.before.ndjson`.

## Unit 1: code

### Task 1: Plays as `FootballPlay`

One commit: the domain type, every reader and writer, the corpus format and the golden file change together, since
none compiles or passes alone.

**Files:**
- Modify: `packages/domain/src/Play.ts`, `Play.test.ts`, `TestGame.ts`, `LiveGame.ts` (imports only),
  `GameEvent.ts` (doc only)
- Modify: `apps/hub/src/provider/espn/EspnPlay.ts`, `EspnPlay.test.ts`, `EspnSummary.ts`, `EspnScript.ts`,
  `EspnScript.test.ts`, `EspnDecode.ts` (only if a type name changes)
- Modify: `apps/hub/src/scenario/ScenarioScript.ts`, `ScenarioScript.test.ts`, `ScenarioProvider.test.ts`,
  `scenario/written/{KickoffWindow,BlowoutAndUpsetBrewing,ThreeRedZonesAtOnce,AllStoppedButOne,TwoMinuteDrillTie}.ts`
- Modify: `apps/hub/src/corpus/Synthesis.ts`, `CorpusInput.ts`, `fixtures/2026-10-04-ne-buf.push.ndjson`
- Modify: `apps/web/src/game/Field.tsx`, `apps/web/src/hub/LiveStream.test.ts`
- Modify: `CONTEXT.md`

**Interfaces — produces (`packages/domain/src/Play.ts`):**

```ts
export const PlayId: Schema.brand<Schema.String, "PlayId">           // unchanged
export class Rush extends Schema.TaggedClass<Rush>()("Rush", { ...common, ...gained, touchdown: Schema.Boolean })
export class Completion   /* ...common, ...gained, touchdown: Boolean */
export class Incompletion /* ...common, ...gained */
export class Interception /* ...common, ...gained, return: Literals(["none", "returned", "touchdown"]) */
export class Sack         /* ...common, ...gained, fumbleLost: Boolean */
export class Fumble       /* ...common, ...gained, recovery: Literals(["unknown", "own", "opponent", "touchdown"]) */
export class TwoPointTry  /* ...common, ...gained, by: Literals(["pass", "rush"]) */
export class Kickoff      /* ...common, ...gained, returnTouchdown: Boolean */
export class Punt         /* ...common, ...gained, return: Literals(["none", "returned", "touchdown"]) */
export class FieldGoal    /* ...common, ...gained, result: Literals(["good", "missed", "blocked"]) */
export class ExtraPoint   /* ...common, ...gained, good: Boolean */
export class Safety       /* ...common, ...gained */
export class Penalty      /* ...common, ...gained */
export class Timeout      /* ...common, team?: TeamId (the caller) */
export class Stoppage     /* ...common, kind: Literals(["officialTimeout", "twoMinuteWarning", "coinToss"]) */
export class PeriodEnd    /* ...common, ends: Literals(["period", "half", "regulation", "game"]) */
export class Other        /* ...common, type: Struct({ id: String, text: String }) */

/** Every football play: a tagged union with `.match`, `.guards`, `.cases`, and the two statics below. */
export const FootballPlay: toTaggedUnion<"_tag", [typeof Rush, …, typeof Other]> & {
  readonly order: Order.Order<FootballPlay>
  eventsSince(before: ReadonlyArray<FootballPlay>, after: ReadonlyArray<FootballPlay>): ReadonlyArray<GameEventKind>
}
export type FootballPlay = typeof FootballPlay.Type

/** The plays of every sport; football's only, for now. */
export const Play = FootballPlay
export type Play = FootballPlay
```

- `common` (private struct fields): `id: PlayId`, `sequence: Int`, `period: Int`, `clock: String`, `text: String`,
  `homeScore: Int`, `awayScore: Int`, `scoring: Boolean`, `start: Spot`, `end: EndSpot`, `homeWinProbability?: Finite`.
  Every case carries its spots: `Synthesis` takes a snapshot's situation from each play's end spot, timeouts' too.
- `gained` (private struct fields): `team?: TeamId`, `yards: Int`.
- `Spot` (private struct): `team: TeamId`, `down?`, `distance?`, `yardsToEndzone?`; `EndSpot` the same with `team?`, since
  the recordings have a pass reception, a blocked field goal and an official timeout that end with no team. The decode
  drops a down below 1 and its distance, as today.
- `FootballPlay` is built with `Object.assign(union, { order, eventsSince })` so call sites keep `Play.order` and
  `Play.eventsSince`, and gain `Play.match` and `Play.guards`.
- Methods on the cases that have `gained`, declared once as a private function the classes call:
  - `offense(): TeamId` — `team`, else `start.team`: the team with the ball at the snap.
  - `lostYards(): boolean` — a `Sack`, or `yards < 0`.
- `eventsSince` keeps today's behaviour, now read per case: every play is `Played`; a `Rush` or `Completion` of at
  least 20 yards with a `team` is also `BigPlay`; a `Sack` is also `Sack({ team: offense() })`.

**ESPN (`EspnPlay.ts`):**

- One private table, a `ReadonlyArray` of rows `{ id: string, text: string, play: <case tag and outcome> }`, with
  the 37 ids of the spec's table, each row's text as ESPN spells it (the spec's table and Task 1's tally agree).
- `read(league, play)` decodes by the table: the row's case, with its outcome fields; an id with no row is `Other`
  with `type: { id, text }`.
- `typeOf(play: FootballPlay): { id: string; text: string }` is the reverse lookup: the first row whose case and
  outcome equal the play's. Every case and outcome reachable from a script has a row. `Other` writes its own `type`.
- `unknownTypes` is unchanged in behaviour.
- `read` leaves a `Timeout`'s `team` unset: ESPN's `team` on one is the team with the ball.
- `EspnSummary.ts:118`: the timeout caller is read when `Play.guards.Timeout(read.play)`, and a caller it resolves is
  the timeout's `team` as well as `timeoutBy`.
- `EspnScript.entityOf`: writes `type: EspnPlay.typeOf(play)` and the spots; `statYardage` and `team` from a case with
  `gained`, and 0 and the start spot's team otherwise, as ESPN writes a stoppage.

**Scenarios (`ScenarioScript.ts`):** a script change's `play?` is a case that gains yards, by its tag and outcome
fields, with `yards: number` and `text?: string`, written as e.g. `play: { _tag: "Completion", touchdown: false,
yards: 23 }`. Its sentence is one `switch` over the case tag, taking the outcome and the yards (a table keyed by tag
cannot type its argument per case without a cast); every written scenario keeps its sentences word for word (pass → "Pass
complete for …", etc.), and new outcomes get a sentence each ("Kickoff returned for a touchdown", "Field goal
blocked"). The 31 written uses map: `pass` → `Completion` (touchdown when the change's score rises by 6),
`rush` → `Rush` (likewise), `incompletion` → `Incompletion`, `interception` → `Interception` `return: "none"`,
`fieldGoal` → `FieldGoal` `result: "good"`, `punt` → `Punt` `return: "none"`.

**Corpus:** `Synthesis.ts` uses `Play.guards.Timeout` for the timeout count and
`Play.guards.PeriodEnd(play)` and `period === 2`, as today, for halftime: college summaries end the second period with
End Period (2), not End of Half (65), so `ends === "half"` would lose college halftimes. `CorpusInput.ts`:
`CorpusLine.format` becomes `2`, so a day built in the old shape is refused with "build it again".

**Web (`Field.tsx`):** `pathOf` and `dashesOf` become one `Play.match` each, with an arm per case (kicks: `Kickoff`,
`Punt`, `FieldGoal`, `ExtraPoint`; passes: `Completion`; the loop: `Incompletion`; dashes: `Penalty`,
`Incompletion`). `PlayArrow` uses `play.lostYards()`; `scorerOf` uses `play.offense()`. Cases without `gained` draw no
arrow, as today's zero-yard stoppages draw none — check `PlayArrow`'s current guard and keep its outcome.

**Tests (should-form; write first, watch them fail, then implement):**

`packages/domain/src/Play.test.ts`
- `describe("FootballPlay")`
  - should round-trip each case through its wire form (`it.each` over one instance per case)
  - should decode a play whose `_tag` it does not know as a failure
  - should order plays by sequence, not by id
- `describe("FootballPlay.eventsSince")`
  - should report nothing when there are no new plays
  - should report nothing for a repeated list
  - should report nothing for a play whose text was revised
  - should report a touchdown completion as played and big
  - should leave the score of a touchdown to the snapshot
  - should report a defensive touchdown as played only
  - should report an interception as played only
  - should report a lost fumble as played only
  - should report a punt as played only
  - should report a kept fumble as played only
  - should report a long punt as played, not big
  - should report a long penalty as played, not big
  - should report a timeout as played only
  - should report a period end as played only
  - should report a sack for the offense
  - should report two new plays in sequence order
- `describe("Rush#offense")`: should be the play's team; should fall back to the start spot's team
- `describe("Sack#lostYards")`: should be true; `describe("Rush#lostYards")`: should be true below zero yards, false at zero

`apps/hub/src/provider/espn/EspnPlay.test.ts` — each existing test, split per case, plus:
- should read each recorded type id as its table row (`it.each` over the table)
- should read every play in the recorded fixtures without falling back to `Other` (walks
  `apps/hub/src/provider/espn/fixtures/*` and the 2026-10-04 recording the way `TestEspn` loads them)
- should read an unknown type as `Other`, keeping its id and text
- should list an unknown type once in `unknownTypes`
- should write each row's case back as the row's id (`typeOf`, `it.each` over the table)
- should read a kickoff return touchdown as a `Kickoff` with `returnTouchdown`
- should read a blocked field goal as a `FieldGoal` `blocked`
- should read a safety as a `Safety`
- should read a coin toss as a `Stoppage` `coinToss`

`ScenarioScript.test.ts`, `EspnScript.test.ts`, `ScenarioProvider.test.ts`, `LiveStream.test.ts`: existing tests
rewritten to the standard and to the new script shape; add
- should write a script's `Kickoff` return touchdown as ESPN's type 32 (`EspnScript`)
- should give each case and outcome a sentence (`ScenarioScript`, `it.each` over the cases)

**Steps:**
- [ ] Write the `Play.test.ts` tests; run `pnpm vitest run packages/domain/src/Play.test.ts`; expect failures on the
  missing cases.
- [ ] Implement `Play.ts` and `TestGame.play` (`play(overrides?: Partial<…>)` builds a `Rush` by default; a test
  needing another case constructs it directly). Run the file; expect pass.
- [ ] Write the `EspnPlay.test.ts` tests; run; expect failures. Implement `EspnPlay.ts`, `EspnSummary.ts`,
  `EspnScript.ts`. Run `pnpm vitest run apps/hub/src/provider/espn`; expect pass.
- [ ] Update `ScenarioScript.ts`, the five written scenarios and their tests; run `pnpm vitest run apps/hub/src/scenario`.
- [ ] Update `Synthesis.ts` and `CorpusInput.ts`. Regenerate the golden push file by writing `Synthesis.day`'s push
  lines, encoded as the test encodes them, over the old file (a scratch script, not committed).
- [ ] **Check the golden file mechanically:** a scratch script reads `$SCRATCH/ne-buf.push.before.ndjson` and the new
  file line by line, and asserts every line is equal except each play, where the old `kind` and the new case agree by
  the table (`pass` ↔ `Completion`/`TwoPointTry` by `pass`, …) and every other field is equal. The poll file must be
  byte-identical. Paste the script's summary in the commit body.
- [ ] Update `Field.tsx`. Update `CONTEXT.md`: **Football play** row (the cases, as in the spec's table) and the
  **Play** row (the plays of every sport, football's only for now); remove **Play kind**; **Decode observation**
  still says "an unknown play type".
- [ ] `pnpm check`; commit `refactor(domain)!: a play is a FootballPlay case that keeps what ESPN's play type says`.

### Task 2: Game history drops plays of the old shape

**Files:** Modify `apps/hub/src/GameHistory.ts`, `GameHistory.test.ts`.

- Migration `"2_drop_plays"` in `migrations`: `DELETE FROM play`. The history refills as the Hub replays the feed
  log, as its doc comment says.
- Tests:
  - should start with no plays after migrating a database that held plays of the old shape (write a row with an
    old-shape body through `1_create_history`'s table, then run the layer)
  - should keep game snapshots through the migration
- [ ] Write the tests; run; expect failure. Add the migration; run; expect pass.
- [ ] `pnpm check`; commit `fix(hub): game history drops plays stored in the old shape`.

### Task 3: `SlateObservation` gets its own module

**Files:** Create `packages/domain/src/SlateObservation.ts`; modify `Slate.ts` and every importer of
`SlateObservation` (`apps/hub/src/SlateTelemetry.ts`, `TestFeed.ts`, `provider/espn/EspnScript.test.ts`,
`corpus/Synthesis.test.ts`, `packages/domain/src/Slate.test.ts`).

- `SlateObservation` (type and `Data.taggedEnum`) moves unchanged, doc comments with it. `Slate.ts` imports it.
- [ ] Move; update imports; `pnpm check`; commit `refactor(domain): SlateObservation is its own module`.

### Task 4: The domain slate's internals

**Files:** Modify `packages/domain/src/Slate.ts`, `Slate.test.ts`, `TestGame.ts` (only if `polled` needs it; it
moves in Task 10).

**Interfaces:** the public surface does not change: `Slate.empty`, `Slate.dayStart`, `take`, `tick`,
`earliestDue`, `games`, `recentPlays`, `everyGame`, `publishesSameAs`, `Taken`.

**Private shapes:**

```ts
/** A take or tick under way: what the slate holds so far, and what it has said. */
class Advancing extends Data.Class<{
  readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly live: ReadonlyMap<GameId, LiveGame>
  readonly finished: ReadonlyMap<GameId, GameSnapshot>
  readonly events: ReadonlyArray<GameEvent>
  readonly observations: ReadonlyArray<SlateObservation>
}> {
  observe(observation: SlateObservation): Advancing
  say(id: GameId, at: DateTime.Utc, events: ReadonlyArray<GameEventKind>): Advancing
  relist(league: LeagueId, games: ReadonlyArray<GameSnapshot>): Advancing   // also drops finished games no listing names
  settle(id: GameId, at: DateTime.Utc, current: Option.Option<LiveGame>, step: { … }): Advancing
  guard(snapshot: GameSnapshot, by: string, step: (advancing: Advancing) => Advancing): Effect.Effect<Advancing>
}

/** What one step did to one game's place in the slate. */
type GameStep = Data.TaggedEnum<{
  Started: { readonly after: LiveGame }          // not held before, current now
  Changed: { readonly before: LiveGame; readonly after: LiveGame }   // held, still current
  Stopped: { readonly before: Option.Option<LiveGame>; readonly after: LiveGame }  // held, no longer current
  Unheld: {}                                     // not held, not current: nothing happens, nothing is said
}>
```

- `settle` decides the `GameStep` in one private function (`gameStepOf(current, step, at)`) and applies it with one
  `$match`: `Started` holds and observes `Started`; `Changed` holds the new live game if the step made one and observes
  `Changed`; `Stopped` releases, remembers an `Over` game as finished, and observes `Stopped`; `Unheld` returns the
  slate unchanged. Events are said for every case but `Unheld`, exactly as `settled` does today.
- `advance`, `tickTo`, `applied` and `snapshotTaken` keep their logic, threading an `Advancing` instead of
  `Advanced`/`Listed`. `Taken` is built from the final `Advancing`.
- File order: `Slate`, `Taken`, `Advancing`, `GameStep`, then helpers in first-use order.
- Copy `Data.Class` and `Data.taggedEnum` usage from `LiveGame.ts`.

**Tests:** `Slate.test.ts` rewritten to the standard first, with its assertions unchanged and passing against the old
code (commit body has the mapping). The multi-case tests split:
- `dayStart`: should be today's 04:00 from 04:00; should be yesterday's 04:00 before 04:00
- `empty`: should hold no listing; no live game; no finished game; no `reached`
- covered fallback: should hold a listing ahead of a covered game; should fall back at `until` and say its events then
- finished game: should observe nothing of a poll equal to its final; should observe a lagging poll as behind
- seq: should keep the last seq on a tick; should replace it on a take
- `games`: should show each held game's live snapshot in place of the listed one; should keep the leagues' order
- `recentPlays`: should keep the last ten plays; should keep sequence order; should leave out a game with no plays;
  should answer only for the games asked for
- `publishesSameAs`: should be the same after a tick that changed nothing; should differ after a take that changed a
  game

**Steps:**
- [ ] Rewrite `Slate.test.ts`; run it against the unchanged `Slate.ts`; expect pass. Commit
  `test(domain): Slate's tests, one behaviour each`.
- [ ] Restructure `Slate.ts`; run `pnpm vitest run packages/domain apps/hub/src/Slate.test.ts apps/hub/src/Slate.replay.test.ts apps/hub/src/corpus`;
  expect pass.
- [ ] `pnpm check`; commit `refactor(domain): the slate advances through one Advancing and one GameStep`.

### Task 5: The Hub's `LiveSlate`

**Files:** `git mv apps/hub/src/Slate.ts apps/hub/src/LiveSlate.ts`, `Slate.test.ts` → `LiveSlate.test.ts`,
`Slate.replay.test.ts` → `LiveSlate.replay.test.ts` (folded in Task 12), `SlateTelemetry.ts` →
`LiveSlateTelemetry.ts`; modify every importer: `HubMode.ts`, `Ingest.ts`, `GameHistory.ts`, `StageSessions.ts`,
`hub-server/HubServer.ts`, `TestFeed.ts` and the tests the slate reader listed (`GameHistory`, `Ingest`, `HubMode`,
`StageSessions`, `ScenarioProvider`, `HubServer`, `CorpusRun` tests); `telemetry/dashboards/live-games.json`;
`docs/technical-spec.md`; `docs/game-day-checklist.md`; `CONTEXT.md`; `.dependency-cruiser.cjs` if it names the file.

- Service `LiveSlate`, key `"sportal/hub/LiveSlate"`. Members unchanged.
- Spans `Slate.take` → `LiveSlate.take`, `Slate.replay` → `LiveSlate.replay`; log prefix `Slate:` → `LiveSlate:`.
  Update the TraceQL in `live-games.json:514`, the log line quoted in `game-day-checklist.md:57`, and every test that
  looks up a span or log line.
- Metric names unchanged.
- Every `Slate as DomainSlate` import becomes `Slate`.
- Comments in `corpus/CorpusBuild.test.ts:20` and `corpus/CorpusRun.test.ts:35` name the renamed test file.
- `CONTEXT.md`: **Slate** row describes only the domain fold; new **Live slate** row (the Hub service: follows the
  feed log from the game day's start, replays it quietly, then takes each appended frame, with a timer and
  telemetry, and publishes); **Published** and **Following** say "the live slate".
- `technical-spec.md`: the tree (`:222`, `:223`), the Slate section (`:382–394`), `:446`, `:452`, and add
  `SlateObservation.ts` at `:198`.
- [ ] Rename; `rg -n "DomainSlate|SlateTelemetry|\"Slate\\.|Slate: " apps packages telemetry docs/technical-spec.md docs/game-day-checklist.md`
  shows nothing left but history; `pnpm check`; commit `refactor(hub): the Slate service is LiveSlate`.

### Task 6: The Hub's `LiveStage`

**Files:** `git mv apps/hub/src/StageSessions.ts apps/hub/src/LiveStage.ts`, `StageSessions.test.ts` →
`LiveStage.test.ts`; modify `main.ts`, `hub-server/HubServer.ts`, `HubServer.test.ts`, `CONTEXT.md`,
`docs/technical-spec.md` (`:73`, `:227`, `:464`).

- Service `LiveStage`, key `"sportal/hub/LiveStage"`, span `LiveStage.dispatch`. `dispatch`, the atomic step and the
  refresh unchanged.
- Comments: keep the two constraint comments (why the step is atomic; why availability is read inside it); drop
  "Assigning a game that is not on the slate gives a data tile." and the other restating ones.
- `CONTEXT.md`: **Stage sessions** becomes **Live stage**: "The Hub's one Stage, shared by every Display: applies
  stage commands one at a time and refreshes channel availability when the source changes." Avoid column keeps
  "stage store, stage manager" and adds "stage sessions".
- [ ] Rename; `pnpm check`; commit `refactor(hub): StageSessions is LiveStage, the Hub's one Stage`.

### Task 7: Layout geometry moves to the web

**Files:** Delete `packages/domain/src/Layout.ts`, `Layout.test.ts`. Modify `packages/domain/src/Stage.ts`,
`Stage.test.ts`. Create `apps/web/src/layout/Layout.ts`, `Layout.test.ts`. Modify `apps/web/src/stage/TileRects.ts`,
`remote/StageMap.tsx`, `stage/Dividers.tsx`, `stage/StageView.tsx`, `display/Display.ts`,
`display/CommandPalette.tsx`, `layout/LayoutPicker.tsx`, `layout/LayoutGlyph.tsx`. `CONTEXT.md`, `technical-spec.md`.

**Domain (`Stage.ts`), above the class:**

```ts
/** The layouts a Stage can take, in the order the next-layout hotkey cycles through them. */
export const LayoutName: Schema.Literals<["Single", "Pair", "Quad", "MainThree", "MainFive"]>
export type LayoutName = typeof LayoutName.Type
/** Where a layout's dividers sit, as fractions of the Stage area. */
export const Split: Schema.Struct<{ x: Schema.Finite; y: Schema.Finite }>
export type Split = typeof Split.Type
```

and on the class:

```ts
static slotCount(layout: LayoutName): number
/** The range each divider stays within, so every tile stays watchable. */
static readonly splitBounds: { readonly min: 0.2; readonly max: 0.8 }
```

- A private table `{ [name]: { slots, split } }` beside its users gives `slotCount` and `Stage.initial`'s splits.
- `SetSplit` rejects `split-out-of-range` when either axis is outside `splitBounds` (today's `Layout.holds`).
- `currentLayout()` is removed.

**Web (`apps/web/src/layout/Layout.ts`):**

```ts
/** A layout with its dividers: the slots it arranges, main tile first, as fractions of the Stage area. */
export class Layout extends Schema.Class<Layout>("sportal/web/Layout")({ name: LayoutName, split: Split }) {
  static of(stage: Stage): Layout                       // the Stage's current layout at its split
  static ofDefault(name: LayoutName): Layout            // at Stage.initial's split, for the glyph
  static dividers(name: LayoutName): ReadonlyArray<"x" | "y">
  static next(name: LayoutName): LayoutName
  static clamp(split: Split): Split                    // into Stage.splitBounds
  slots(): ReadonlyArray<{ x: number; y: number; width: number; height: number }>
}
```

- A private table of divider axes per layout. `rect` and `within` move as private helpers.
- Users: `TileRects` and `StageMap` call `Layout.of(stage).slots()`; `Dividers` uses `Layout.dividers`,
  `Layout.clamp`, and `Stage.splitBounds` for its aria values; `Display` uses `Layout.next`; `LayoutGlyph` uses
  `Layout.ofDefault(name).slots()`; `LayoutPicker` uses `Stage.slotCount`; `CommandPalette` and `StageView` import
  `LayoutName`/`Split` from `@sportal/domain/Stage`.

**Tests (should-form):**

`apps/web/src/layout/Layout.test.ts` (from domain `Layout.test.ts`)
- `describe("Layout#slots")`: should give Single one slot filling the area; should split Pair at x; should split Quad
  at x and y with the main tile top left; should put MainThree's main tile left of three stacked tiles; should put
  MainFive's main tile top left, two beside it and three along the bottom; should tile the whole area without overlap
  (`it.each` over layout × split, as today); should give as many slots as `Stage.slotCount`
- `describe("Layout.next")`: should go to the next layout; should wrap from the last to the first
- `describe("Layout.dividers")`: one `it.each` row per layout
- `describe("Layout.clamp")`: should raise an axis below the bounds; should keep an axis inside them; should lower
  an axis above them

`Stage.test.ts`
- `describe("Stage.slotCount")`: `it.each` per layout
- `describe("Stage#apply SetSplit")`: should accept a split at the bounds; should reject a split below them; should
  reject a split above them
- existing tests that used `Layout.defaultSplit`/`currentLayout` read `Stage.initial.splits[…]` and
  `stage.splits[stage.layout]`

**Steps:**
- [ ] Write `Layout.test.ts` (web) and the new `Stage.test.ts` cases; run; expect failures.
- [ ] Move the code; update users; run `pnpm vitest run packages/domain/src/Stage.test.ts apps/web`; expect pass.
- [ ] `CONTEXT.md`: **Layout** says it is the web's; **Layout name** and **Split** name `Stage.ts`.
  `technical-spec.md` tree updated.
- [ ] `pnpm check`; commit `refactor: layout geometry is the web's; the Stage keeps names, slot counts and split bounds`.

### Task 8: Unit 1 holds

- [ ] Build days from the same feed log with the branch's code:
  `SPORTAL_DATA_DIR=<abs>/sportal/.sportal SPORTAL_CORPUS_DIR=$SCRATCH/corpus-after pnpm --filter @sportal/hub corpus build --all`.
- [ ] Run `$SCRATCH/dump-events.ts` over `corpus-after` into `$SCRATCH/events-after.jsonl`.
  `diff $SCRATCH/events-before.jsonl $SCRATCH/events-after.jsonl` prints nothing. Any difference stops the unit and is
  reported to the user.
- [ ] `rg -n "PlayKind|DomainSlate|StageSessions|@sportal/domain/Layout" apps packages` prints nothing.
- [ ] The nested `yield*` check over the source files Tasks 1–7 touched prints nothing.
- [ ] No commit unless a fix was needed.

## Unit 2: tests

### Task 9: The standard, Vitest projects, and the coverage baseline

**Files:** Modify `AGENTS.md`, `vitest.config.ts`, root `package.json`, `pnpm-lock.yaml`; create
`packages/domain/vitest.config.ts`, `packages/api/vitest.config.ts`, `apps/hub/vitest.config.ts`,
`apps/web/vitest.config.ts`, `apps/desktop/vitest.config.ts`; `docs/technical-spec.md` (`:46` drops "Playwright for
the web UI", which nothing uses; `:171` the config files).

- `AGENTS.md`: a **Tests** section after "How code is written", holding the three standard bullets from the Global
  constraints above, plus the existing test bullets moved into it (tests beside the file; test-first for domain and
  decoding; recorded payloads; `Test*.ts` named for the concept it builds or fakes, beside its module).
- Root `vitest.config.ts`: `test.projects: ["packages/*", "apps/*"]`, `exclude` keeps `.worktrees/**`, coverage
  `provider: "v8"`, `reporter: ["json-summary", "text"]`, `include: ["apps/*/src/**", "packages/*/src/**"]`.
- Each workspace config: `defineProject({ test: { name: "<workspace>" } })`; the web's adds the `@` alias (moved from
  the root). Copy the shape from Vitest 5's `defineProject` docs in `node_modules/vitest`.
- `@vitest/coverage-v8` at the installed Vitest's version as a root devDependency; `"coverage": "vitest run --coverage"`.
- [ ] Make the change. `pnpm test` runs the same number of tests as before (794 plus Unit 1's), each named by project.
  `pnpm --filter @sportal/domain exec vitest run` runs only the domain's.
- [ ] `pnpm coverage`; copy `coverage/coverage-summary.json` to `$SCRATCH/coverage-before.json`. `coverage/` is in
  `.gitignore`.
- [ ] `pnpm check`; commit `chore: the testing standard in AGENTS.md; Vitest projects per workspace; v8 coverage`.

### Task 10: Test helpers by concept

**Files:** Delete `apps/hub/src/TestFeed.ts`; modify `TestSnapshotFeed.ts`; create `apps/hub/src/provider/TestDecoder.ts`,
`apps/hub/src/TestLiveSlate.ts`, `apps/hub/src/scenario/TestScenarios.ts`, `apps/hub/src/provider/espn/TestEspnArchive.ts`,
`packages/domain/src/TestSlate.ts`; modify `TestGame.ts`, `TestHubConfig.ts`, `corpus/TestCorpus.ts`,
`provider/espn/TestEspn.ts`; every importer; `.dependency-cruiser.cjs`; `knip.json` if needed;
`docs/technical-spec.md` (`:204`, `:233–235`, `:251`, `:258`, `:355`); `CONTEXT.md` (`:71`).

| From | Export | To |
| --- | --- | --- |
| `TestFeed.ts` | `polled`, `framed`, `pushed` | `TestSnapshotFeed.ts` |
| `TestFeed.ts` | `decodedFrames`, `listedBy`, `dyingAt` | `provider/TestDecoder.ts` (beside `Decoder.ts`) |
| `TestFeed.ts` | `slateFollowing`, `delivered`, `takenOf` | `TestLiveSlate.ts` (beside `LiveSlate.ts`) |
| `TestFeed.ts` | `writtenScenarios` | `scenario/TestScenarios.ts` |
| `TestGame.ts` | `polled` | `packages/domain/src/TestSlate.ts` |
| `TestCorpus.ts` | `inArchive`, `stepped`, `site`, `archivedSummary`, `scoreboardUrl`, `summaryUrl` | `provider/espn/TestEspnArchive.ts` |
| `TestHubConfig.ts` | `home`, `inEnv` | bottom of `HubConfig.test.ts` (one user) |
| `TestSnapshotFeed.ts` | `SnapshotPayload` | stays (also used by `pushed`) |
| `TestEspn.ts` | `recordedScoreboard` | bottom of `YouTubeTv.test.ts` |
| `TestEspn.ts` | `recordedCheckpoint` | bottom of `LiveSlate.replay.test.ts` |
| `TestCorpus.ts` | the URL constants with one user | bottom of `EspnArchive.test.ts` |

- Exports move unchanged; doc comments move with them.
- `.dependency-cruiser.cjs`: each `test-*-is-for-tests` rule and the two allow-lists (`:34–39`, `:48–53`) name the new
  paths; the stale `test-database-is-for-tests` rule (its `TestDatabase.ts` does not exist) is removed; a rule for
  each new `Test*.ts` (`TestDecoder`, `TestLiveSlate`, `TestScenarios`, `TestEspnArchive`, domain `TestSlate`) allows
  only tests and the other `Test*.ts` that use it. `ScenarioScript.ts`'s allowed import of `TestGame` stays.
- [ ] Move; `pnpm check` (depcruise and both knip runs pass); commit `test: test helpers named for the concept they build, beside it`.

### Tasks 11–16: Each test file to the standard

Procedure for every file (the same in each task):

1. Read the file. For each test: if it checks more than one behaviour (several act/assert pairs, a loop over inputs
   that are different behaviours, or a name joining behaviours with "and", ";" or ","), split it into one test per
   behaviour. One act checked from several angles is one behaviour and stays one test.
2. Name each test `should …`, in the house's plain words (`CONTEXT.md` terms). The `describe` names the unit:
   `describe("LiveGame#take, a snapshot")`, `describe("EspnDecode.decode")`.
3. Lay each test out as Arrange, blank line, Act, blank line, Assert. Repeated arrangement becomes a builder at the
   bottom of the file (or in the concept's `Test*.ts` if a second file needs it).
4. Every old assertion survives in some new test. Write the file's mapping (old name → new names) in the commit body.
5. `pnpm vitest run <file>` passes; the file's test count is at least its old count.

One commit per file, or per group of files under 150 lines in one folder:
`test(<area>): <Module>'s tests, one behaviour each`.

- [ ] **Task 11 — domain:** `Game`, `LiveGame`, `Stage`, `Guide`, `Situation`, `Delivery`, `GameEvent` tests
  (`Play`, `Slate`, `Stage`'s new cases already done in Unit 1; finish the rest of `Stage.test.ts`).
- [ ] **Task 12 — the live slate:** `LiveSlate.test.ts` and `LiveSlate.replay.test.ts`. `LiveSlate.replay.test.ts`
  folds into `LiveSlate.test.ts` as `describe("LiveSlate following the feed log")`,
  `describe("LiveSlate, a covered game's fallback")` and `describe("LiveSlate, a recorded game")`; the two game-day
  boundary tests that only re-check `Slate.dayStart` through a span stay, as they check the replay's start, not the
  arithmetic. Builders for the repeated `slateFollowing` + frames setup go to `TestLiveSlate.ts`.
- [ ] **Task 13 — the Hub core:** `Ingest`, `FeedLog`, `GameHistory`, `HubServer`, `LiveStage`, `Telemetry`,
  `DecodeTelemetry`, `HubConfig`, `HubMode`, `HubStopping`, `Database`, `LanAddresses`, `main` tests.
- [ ] **Task 14 — ESPN and YouTube TV:** `EspnDecode`, `FastCast`, `FastCastMessage`, `EspnSummary`, `EspnProvider`,
  `EspnScript`, `EspnArchive`, `EspnEvent`, `YouTubeTv` tests (`EspnPlay` done in Task 1).
- [ ] **Task 15 — scenarios and the corpus:** `ScenarioProvider`, `ScenarioScript`, `Scenarios`, `written/Scripts`,
  `ScenarioClock`, `ScenarioSource`, `TestSnapshotFeed`, `CorpusBuild`, `CorpusRun`, `CorpusDay`, `CorpusInput`,
  `CorpusWorker`, `Synthesis`, `corpus` tests.
- [ ] **Task 16 — api, web and desktop:** `Hotkey`, `Display`, `TileRects`, `LiveStream`, `StripCards`,
  `TileActions`, `HubClient`, `Score`, `GameStatus`, `Brand`, `TileViews`, `ProviderSession`, `GuideReader`,
  `Navigation`, `Transition` tests.

### Task 17: Unit 2 holds

- [ ] `rg -n --glob '*.test.ts' 'it(\.effect|\.live|\.each|\.effect\.each)?\("(?!should )' apps packages` (with
  `--pcre2`) prints nothing.
- [ ] `pnpm coverage`; compare `coverage/coverage-summary.json` to `$SCRATCH/coverage-before.json` with a scratch
  script: no file's `lines.pct` or `branches.pct` is lower. Paste its summary in the final report.
- [ ] No commit unless a fix was needed.

## Unit 3: code layout

### Tasks 18–21: Each source file to the code layout standard

Procedure for every file (the same in each task):

1. Run the nested `yield*` check on the file; give each hit its own `const` line (rule 2). An object literal of
   `yield*`s (`HubConfig.ts`) becomes a list of `const`s, then the object of plain fields.
2. Name each calculation inside a constructor or call, and each pipe deeper than two levels (rule 3).
3. Separate the phases of each generator block and long function with one blank line each (rule 1).
4. Pull a long chain that does one thing into a named function below its user, or a method of its concept (rule 4).
   Search first: the function may already exist.
5. Touch nothing else: no renames, no behaviour, no tests. `pnpm vitest run` over the file's folder passes unchanged.

One commit per file, or per group of small files in one folder: `style(<area>): <Module> reads as steps`.

- [ ] **Task 18 — the densest Hub files:** `HubConfig.ts`, `corpus/CorpusBuild.ts`, `corpus/CorpusDay.ts`,
  `provider/espn/FastCast.ts`, `hub-server/HubServer.ts`.
- [ ] **Task 19 — the rest of the Hub:** every other source file under `apps/hub/src` that Unit 1 did not already lay
  out (`FeedLog.ts`, `Ingest.ts`, `LiveSlate.ts`, `LiveSlateTelemetry.ts`, `GameHistory.ts`, `Telemetry.ts`, the
  ESPN and YouTube TV adapters, scenarios, the corpus), largest first.
- [ ] **Task 20 — the domain and api:** `packages/domain/src`, `packages/api/src`.
- [ ] **Task 21 — the web and the desktop shell:** `apps/web/src` (not `design/`), `apps/desktop/src`
  (`GuideReader.ts`, `ShellConfig.ts`, `TileViews.ts` have nested `yield*`).

### Task 22: Unit 3 holds

- [ ] The nested `yield*` check over `apps packages` prints nothing.
- [ ] `pnpm check`. No commit unless a fix was needed.

## Task 23: The branch

- [ ] Re-run Task 8's events comparison against `corpus-before` with the final code: no difference.
- [ ] Update `docs/history.md` with the branch's row once merged (as the previous rows do), and delete
  "Readability pass" from `docs/Scratch.md` only if the user asks.
- [ ] `pnpm check`; then `plannotator review` on the branch; act on the feedback; merge after approval.
