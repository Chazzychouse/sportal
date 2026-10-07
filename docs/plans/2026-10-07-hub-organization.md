# Hub organization: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry out `docs/specs/2026-10-07-hub-organization-design.md`. The evidence behind it is in
`docs/specs/2026-10-07-hub-organization-findings.md`.

**Architecture:**
- The work is a unit of the `readability` branch in `../sportal-readability`. It runs after the readability plan's
  Task 17 and replaces that plan's Tasks 18–19, the Hub's code layout.
- Tasks H0–H12 run in order, with one commit each unless a task says otherwise, and every commit passes `pnpm check`.
- Each file a task touches is also laid out to the code layout standard (AGENTS.md "Inside a file", rules 8–11).
- The readability plan's Tasks 20–23 run after this unit as planned.

**Tech Stack:** Effect 4 (`effect`, `effect/sql`, `effect/schema` `Model`, `@effect/platform-node`), Vitest with
`@effect/vitest`, Biome, dependency-cruiser, knip, pnpm workspaces.

## Global constraints

- **Read first.** Read `AGENTS.md`, `CONTEXT.md`, the spec and the findings before any task. The spec's "The
  convention" is the rule for every line written in this unit, even before H0 writes it into AGENTS.md.
- **Effect 4 is newer than training data.** Read `node_modules/.pnpm/effect@4.0.0/node_modules/effect/ai-docs/src/`
  before writing Effect code, and never write Effect from memory. The examples to copy:
  - services and layers: `01_effect/03_services/01_service.ts`, `20_layer-composition.ts`, `20_layer-unwrap.ts`;
  - `Effect.fn`: `01_effect/01_basics/02_effect-fn.ts`;
  - test layers: `09_testing/20_layer-tests.ts`;
  - SQL rows and repositories: `40_sql/10_basics.ts` (`Model.Class`, `SqlSchema` built inside the layer);
  - wire unions: `Schema.TaggedUnion` in `effect/dist/Schema.d.ts`, with `Delivery.ts` as the house example.
- **No bodies in this plan.** It gives signatures, behaviour, test names and the existing code to follow.
- **Behaviour is preserved,** except for what the spec removes or renames. A test whose assertion changes for any other
  reason is a defect in the change.
- **Metric ids, span names and log prefixes stay as they are,** so the Grafana dashboard
  (`telemetry/dashboards/live-games.json`) keeps working. A const may be renamed; its id string may not.
- **The testing standard** (AGENTS.md "Tests") applies to every test written or touched. A test that is moved keeps
  every assertion it had. The commit body lists, per test file, each test that moved or was deleted and why.
- **Nested `yield*` check** (code layout rule 9). Both commands print nothing for a file once it is done:
  - `rg -n 'yield\*' -g '*.ts' -g '!*.test.ts' <paths> | rg -v '^\S+:\d+:\s*((const|let) [^=]+ = |\w+ = |return )?yield\* '`
  - `rg -n 'yield\*.*yield\*' -g '*.ts' -g '!*.test.ts' <paths>`
- **Glossary:** a new, renamed or deleted exported type name changes its `CONTEXT.md` row in the same commit.
- **Comments:** doc comments go on major exports. Inline comments are only for a non-obvious why. Trim restating comments
  in code you move.
- **TypeScript:** no `any`, non-null assertions, enums, default exports, or casts outside decoding.
- **Commands:**
  - `pnpm check` before every commit;
  - `pnpm vitest run <path>` for one file;
  - `pnpm vitest run --project hub` for the Hub.
- **Commits:**
  - Conventional prefixes, as in `git log`.
  - Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - **The peer session.** Another session (`sportal-e3`) runs the readability plan on this branch. Before the first
    commit of each task, send it a message (SendMessage to `sportal-e3`) and wait until it confirms it has nothing in
    flight. After the last commit of the task, tell it so.
- **Ledger:** log progress in `"$(git rev-parse --git-path sdd)/hub-organization.md"`. The readability ledger
  (`progress.md`) belongs to the peer; read it only for the baseline paths (`corpus-before`, `events-before.jsonl`,
  `dump-events.ts`).
- **The main checkout:** never edit `../sportal`.

## File map

| File | Task | Change |
| --- | --- | --- |
| `AGENTS.md`, `knip.json`, `.dependency-cruiser.cjs` | H0 | the convention; `ignoreMembers: ["^layerTest"]`; the stale `ChannelStore` path |
| `GameHistory.ts`, `GameHistory.test.ts` | H1 | deleted |
| `Database.ts`, `main.ts`, `HubMode.ts`, `Ingest.test.ts`, `Database.test.ts`, `main.test.ts` | H1 | no `sportal.sqlite` |
| `scenario/ScenarioScript.ts`, `scenario/written/`, `scenario/TestScenarios.ts`, `provider/espn/EspnScript.ts` (with tests) | H2 | deleted |
| `scenario/fixtures/two-minute-drill-tie.frames.jsonl.gz`, `scenario/fixtures/a-drive.frames.jsonl.gz` | H2 | new: frozen frames for tests |
| `scenario/Scenarios.ts`, `Scenario.ts` | H2 | `layer`, `layerFrom(dir)`; `Scenario` folds in |
| `feed-log/FeedLog.ts`, `feed-log/FeedLogWriter.ts`, `feed-log/FeedFrameTable.ts` | H3 | split of `FeedLog.ts` |
| `TestFeedLog.ts` | H3 | deleted (`FeedLog.layerTest`) |
| `provider/Decoder.ts`, `provider/Provider.ts`, `provider/TestDecoder.ts` | H4 | `Decoded` and `DecodeObservation` move; `ProviderUnavailable`; `Decoder.layerTestDying` |
| `corpus/Archive.ts` → `provider/Archive.ts` | H4 | moved; `retry` gone |
| `provider/espn/EspnPayload.ts` | H5 | new: ESPN's spellings |
| `provider/espn/EspnEvent.ts`, `EspnPlay.ts`, `EspnSummary.ts`, `EspnDecode.ts` | H5 | transforms only; one decoder table |
| `provider/espn/FastCastTopic.ts`, `FastCastMessage.ts`, `FastCastDocument.ts`, `FastCast.ts` | H6 | `Owner` moves; `CheckpointUnread`; `reset` pure |
| `provider/espn/EspnArchive.ts`, `EspnProvider.ts` | H6 | short layers over `Effect.fn` helpers |
| `LiveSlate.ts`, `LiveSlateTelemetry.ts`, `DecodeTelemetry.ts` (deleted), `Ingest.ts`, `HubStopping.ts` | H7 | demand to Ingest; telemetry moments |
| `packages/api/src/LiveMessage.ts`, `packages/domain/src/SlateObservation.ts`, `apps/web/src/hub/LiveStream.ts` | H8 | `games`; `after` |
| `hub-server/` → `HubServer.ts`, `HubServer.test.ts` | H8 | flattened; `LanAddresses` folds in |
| `corpus/CorpusInput.ts` → `CorpusLine.ts`, `corpus/GameDay.ts`, `CorpusRun.ts`, `CorpusWorker.ts` (deleted), `corpus.ts`, `CorpusDay.ts`, `CorpusBuild.ts`, `Synthesis.ts` | H9 | |
| every other Hub source file | H10 | the convention's spellings, plus layout |
| `packages/domain/src/Stage.ts`, `Stream.ts`; `packages/api/src/*`; `apps/web`, `apps/desktop` | H11 | outside the Hub |
| `CONTEXT.md`, `docs/technical-spec.md`, `docs/game-day-checklist.md` | every task | rows and paths for what it moves |

---

## H0: The convention in AGENTS.md

**Files:** `AGENTS.md`, `knip.json`, `.dependency-cruiser.cjs`.

- `AGENTS.md` "Where code goes" gains **Module shapes**: the spec's table, in AGENTS.md's terse voice.
- `AGENTS.md` "How code is written" gains **One spelling per kind**: the spec's table, its hoisting note, and its
  "Order inside a class module". These rules are reversed:
  - "Nothing indexes a service's type with `X["Service"]`" becomes "`S["Service"]` is allowed; a port still names the
    member types other modules need".
  - "Private helpers go below … as hoisted `function` declarations" becomes "pure helpers as hoisted functions;
    effectful helpers as `Effect.fn` consts".
  - "Inside a file" rule 5 ("service declaration, its layer, then private helpers") points to the new order.
- The **Tests** section: "a fake of one service is a `layerTest…` static on that service; it takes its data as
  arguments and imports no fixture or `Test*.ts`. Everything else a test needs stays in `Test*.ts`."
- `knip.json`: top-level `"ignoreMembers": ["^layerTest"]`. Check knip 6's schema
  (`node_modules/knip/schema.json`, `ignoreMembers`) for the exact form.
- `.dependency-cruiser.cjs:53`: drop `^apps/hub/src/source/ChannelStore\\.ts$`.
- [ ] `pnpm check`. Commit `docs: one spelling per kind, Effect's where it differs`.

## H1: Game history goes

**Files:**
- Delete `apps/hub/src/GameHistory.ts` and `GameHistory.test.ts`.
- Modify `Database.ts`, `Database.test.ts`, `main.ts`, `main.test.ts`, `HubMode.ts:35-55` (`live()`), `Ingest.test.ts`
  (around `:653`), `.dependency-cruiser.cjs` (`only-main-opens-the-database`), `CONTEXT.md` (`:91-92`),
  `docs/technical-spec.md`, and `docs/game-day-checklist.md` if it names `sportal.sqlite`.

**Interfaces:**
- `Database.ts` becomes a namespace module of the SQLite plumbing the feed log needs:
  - `layerFile(name: string): Layer.Layer<SqlClient.SqlClient, SqlError, HubConfig | FileSystem.FileSystem | Path.Path>`,
    today's `fileInDataDir`;
  - `layerMemory: Layer.Layer<SqlClient.SqlClient, SqlError>`, today's `at(":memory:")`;
  - `migrate(table: string, migrations)`, unchanged.
- `inDataDir` and `at(path)` go. `at` has no other caller; check with
  `rg -n "Database\.at\(" apps`.

**Steps:**
- [ ] Delete the files. Remove the `Layer.effectDiscard(Layer.build(GameHistory.layer))` line from `HubMode.live`,
  together with its comment "Nothing reads the history yet". Remove `Layer.provide(Database.inDataDir)` from `main.ts`.
  Remove the "The game history stays out of a scenario" sentence from `HubMode.scripted`'s comment.
- [ ] Remove the history from `Ingest.test.ts`'s layer. Delete any test whose only subject is the history, and list it
  in the commit body.
- [ ] `Database.test.ts`:
  - drop the `inDataDir` test;
  - rename the remaining describes to `Database.layerFile` and `Database.layerMemory`;
  - keep every `migrate` assertion.
- [ ] Rename the callers of `fileInDataDir` and `at` (`FeedLog.ts`, `corpus/corpus.ts`, `TestLiveSlate.ts`,
  `corpus/TestCorpus.ts`).
- [ ] `main.test.ts`: a test that checks `sportal.sqlite` is created becomes one that checks it is **not** created:
  `it("should open no sportal.sqlite in the data directory")`. Keep the `feed.sqlite` assertions.
- [ ] `CONTEXT.md`: delete the **Game history** and **Game history error** rows. `rg -n "game history" CONTEXT.md
  docs/technical-spec.md AGENTS.md` finds nothing outside history notes.
- [ ] `pnpm check`. Commit `refactor(hub): no game history; nothing read it`.

## H2: Written scenarios go

**Files:**
- **Delete:**
  - `scenario/ScenarioScript.ts` and its test;
  - `scenario/written/`, the five scripts, `Scripts.ts` and `Scripts.test.ts`;
  - `scenario/TestScenarios.ts`;
  - `provider/espn/EspnScript.ts` and its test.
- **Modify:**
  - `scenario/Scenarios.ts`, `scenario/Scenario.ts` (folds into `Scenarios.ts`), `HubMode.ts`;
  - `scenario/ScenarioProvider.test.ts`, `Scenarios.test.ts`, `corpus/CorpusRun.test.ts:268`, `provider/espn/TestEspn.ts:34`;
  - `HubMode.test.ts`, `main.test.ts`, `HubConfig.test.ts`, `Telemetry.test.ts`;
  - `.dependency-cruiser.cjs`: the `test-scenarios-is-for-tests` rule, and the `test-game-is-for-tests` exception for
    `ScenarioScript`;
  - `CONTEXT.md` (the **Scenario script** row; **Scenario**);
  - `AGENTS.md` (the `SPORTAL_SCENARIO` paragraph);
  - `docs/game-day-checklist.md:42`, `docs/technical-spec.md`.
- **Create:** `apps/hub/src/scenario/fixtures/two-minute-drill-tie.frames.jsonl.gz` and `a-drive.frames.jsonl.gz`.

**Freeze the test frames first, before deleting anything:**
- [ ] Write a scratch script, not committed, in `$SCRATCH`. It writes `EspnScript.scenarioOf(twoMinuteDrillTie).frames`,
  and the frames of `aDrive` (built as `ScenarioScript.test`'s neighbour `ScenarioProvider.test.ts:635` builds it), as
  gzip'd JSON lines in the recorded format. Use `Scenarios`' own decoder (`decodeFrame`) and `Gzip.compress`, so that
  the format matches what `Scenarios` reads.
- [ ] Load each file back through `Scenarios.in(dir, [])` and check that `frames` equals the written scenario's frames
  (`assert.deepStrictEqual`). Record the result in the ledger.

These two fixtures are test data, not dev scenarios: they live in `scenario/fixtures/`, not `fixtures/scenarios/`. So
`SPORTAL_SCENARIO=two-minute-drill-tie` no longer plays.

**Interfaces:**
- `Scenario`, now in `Scenarios.ts`: `class Scenario extends Data.Class<{ name: string; frames: ReadonlyArray<FeedFrame> }>`,
  with `origin()` unchanged. It is exported, because `ScenarioProvider` reads it.
- `Scenarios`:
  - `static readonly layer: Layer.Layer<Scenarios, never, FileSystem.FileSystem | Path.Path>` is the committed
    recordings in `fixtures/scenarios/`.
  - `static layerFrom(folder: string): Layer.Layer<Scenarios, never, FileSystem.FileSystem | Path.Path>` is the
    recordings in `folder`.
  - `names: Effect.Effect<ReadonlyArray<string>, ScenarioUnreadable>` and
    `load(name): Effect.Effect<Scenario, ScenarioUnknown | ScenarioUnreadable>`. There is no `ScenarioDuplicate`,
    since one folder cannot hold a name twice.
  - `written()` goes.
- `HubMode.scripted` → `scenario`, providing `Scenarios.layer`.

**Tests:**
- `Scenarios.test.ts`:
  - The duplicate tests (`:160-200`) are deleted; list them in the commit body as gone with `ScenarioDuplicate`.
  - Tests that listed written names now list the recordings only: `it("should list the committed recordings, sorted")`.
  - `load("two-minute-drill-tie")` tests become `load` of a recording in a temp folder, as `:246` already builds one.
- `ScenarioProvider.test.ts`:
  - `playing("two-minute-drill-tie")` and `scenario(...)` read `scenario/fixtures/` through `Scenarios.layerFrom`.
    The frame timings in the `:108` comment hold, because the frames are the same.
  - The `a-drive` test reads `a-drive` from the same folder.
  - The `written` option goes.
- `HubMode.test.ts:21`, `main.test.ts:108`, `HubConfig.test.ts:40,163` and `Telemetry.test.ts:88-99` name
  `bogus-clock-two-minute`, the smallest committed recording, because they need a scenario that `Scenarios.layer`
  lists. `HubConfig.test` only parses the name, so any string works there; keep it a real recording anyway, for the
  reader.
- `corpus/CorpusRun.test.ts:268` and `provider/espn/TestEspn.ts:34`: `Scenarios.in(fixtures, [])` →
  `Scenarios.layerFrom(fixtures)`.

**Docs:**
- `docs/game-day-checklist.md` row 33 plays `bogus-clock-two-minute`, with its expected text adjusted to what that
  recording shows. Run it once to word the row, and say in the commit body that the row was reworded.
- `AGENTS.md`'s `SPORTAL_SCENARIO` paragraph:
  - it describes recorded scenarios only;
  - "A name that is both stops the Hub" goes;
  - "a written one (a script in …)" goes.

**Steps:**
- [ ] `rg -n "ScenarioScript|EspnScript|TestScenarios|written|ScenarioDuplicate|scripted" apps/hub/src AGENTS.md
  CONTEXT.md docs/technical-spec.md .dependency-cruiser.cjs` shows nothing but unrelated words. Check each hit of
  `written`.
- [ ] `pnpm check`. Commit `refactor(hub): scenarios are recordings; the written scripts go`.

## H3: The feed log, by concept

**Files:**
- `git mv apps/hub/src/FeedLog.ts apps/hub/src/feed-log/FeedLog.ts`, and its test likewise.
- Create `feed-log/FeedLogWriter.ts` and `feed-log/FeedFrameTable.ts`.
- Delete `TestFeedLog.ts`.
- Modify every importer of `FeedLog.ts` and `TestFeedLog.ts` (`rg -l "FeedLog" apps/hub/src`), `HubMode.ts`,
  `corpus/corpus.ts:85`, `.dependency-cruiser.cjs` (paths to `FeedLog.ts`, and `test-feed-log-is-for-tests`),
  `docs/technical-spec.md` (the tree), `AGENTS.md` (`SPORTAL_SCENARIO_FEED_LOG`, if a path is named).

**Interfaces:**
- **`FeedFrameTable.ts`**, a class module of `FeedFrameRow`:
  - `class FeedFrameRow extends Model.Class<FeedFrameRow>("sportal/hub/feed-log/FeedFrameRow")({…})`, one per
    `feed_frame` column, with the columns as they are in the table today:
    - `seq`, `received_at`, `sent_at` (nullable), `source_id` (nullable), `feed` (nullable), `channel` (nullable),
      `kind` (`response | message | checkpoint | unchanged | gap`), `body` (nullable bytes), `body_hash` (nullable);
    - `static readonly columns` (today's `storedColumns`, derived from the fields);
    - `static frame(row, body: string): Frame`, which maps a non-gap row to a `Frame` and reads `unchanged` as
      `response`;
    - `static of(frame: Frame, hash: string, body: Uint8Array | null, unchanged: boolean)`;
    - `static gap(behind: Writer.Behind)`, which is today's `gapRow`.
  - `export const migrations`, the same two entries byte for byte (the migrator keys on their names).
  - The `Gap` body schema.
  - The queries as functions of a captured `sql`: `export function queries(sql: SqlClient.SqlClient)`. It returns
    `lastSeq`, `lastHashes`, `firstAt`, `lookback`, `page`, `lastBody` and `firstReceived`, each a `SqlSchema` built
    once.

  `Row`, `Stored`, `storedColumns`, `absentWhenNull` and the gap literal go. A replayed row is decoded once, through
  `FeedFrameRow`.
- **`FeedLogWriter.ts`**, a namespace module:
  - `export type Writer = Data.TaggedEnum<…>` with `export const Writer`, unchanged;
  - `export const start = Effect.fn("FeedLog.writer")(function* (pending: Queue.Queue<Frame, Cause.Done>, queries) …)`;
  - `write`, `store` (span `FeedLog.store`, unchanged) and `closeGap` as private `Effect.fn`s;
  - the four metrics, with their ids unchanged.
- **`FeedLog.ts`**:
  - The port, unchanged.
  - `static readonly layer: Layer.Layer<FeedLog, never, SqlClient.SqlClient | Crypto.Crypto>`. It builds the queries
    once, starts the writer, adds the finalizer, then returns `append`, `subscribe`, `replay` and `days`. The members
    use the captured queries, so the `provideService` re-injection goes. `replay` and `days` are private `Effect.fn`s
    below the class that take the queries.
  - `static readonly layerInDataDir`, today's `inDataDir`, over `Database.layerFile("feed.sqlite")`.
  - `static readonly layerMemory`, over `Database.layerMemory`.
  - `static layerTest(frames: ReadonlyArray<FeedFrame>): Layer.Layer<FeedLog>`, today's `TestFeedLog.logged`: in
    memory, with `frames` appended in order. Read `TestFeedLog.ts` for the exact behaviour and keep it.
  - `forScenario` goes.
- **`HubMode.ts`**: the scenario's feed log is a `Layer.unwrap` over `HubConfig.scenarioFeedLog`, choosing
  `FeedLog.layerMemory` or `FeedLog.layer` over `Database.layerFile(name)`.

**Tests:**
- `FeedLog.test.ts` keeps every test, moved beside the file. Any test that reached into `Row` or `Stored` now goes
  through `FeedFrameRow`.
- New, in `feed-log/FeedFrameTable.test.ts` (one behaviour each):
  - `it("should read an unchanged row as a poll response")`
  - `it("should round-trip a frame with no sentAt or sourceId as null columns")`
  - `it("should write a gap row at the last lost seq with no feed or channel")`
- The 20 s timeout on the interrupted-appends test (`65d766a`) stays.

**Steps:**
- [ ] Write the `FeedFrameTable` tests first, against today's behaviour; run them to fail on the missing module.
- [ ] Split, move and wire. Then run `pnpm vitest run apps/hub/src/feed-log apps/hub/src/Ingest.test.ts
  apps/hub/src/LiveSlate.test.ts`.
- [ ] Run the corpus build once over the peer's `corpus-before` source. Read the paths from the readability ledger,
  and build into `$SCRATCH/corpus-h3`. Then run `dump-events.ts` and diff against `events-before.jsonl`: no
  difference. The feed log is the corpus's only input, so this proves replay unchanged.
- [ ] `pnpm check`. Commit `refactor(hub): the feed log is its port, its writer and its table`.

## H4: The ports

**Files:**
- `provider/Decoder.ts`, `provider/Provider.ts`, `provider/TestDecoder.ts`.
- `git mv corpus/Archive.ts provider/Archive.ts`.
- Every importer: `rg -l "Decoded|DecodeObservation|ProviderError|Archive\.ts|dyingAt" apps/hub/src`.
- `CONTEXT.md`, `.dependency-cruiser.cjs` (`test-decoder-is-for-tests`, if `dyingAt` was its only reason).

**Interfaces:**
- **`Decoder.ts`**: `Decoder` first, then `Decoded` (with `of` and `undecodable`), then `DecodeObservation`.
  - One doc comment on `decode` states the contract once: one `Decoded` per frame, in order, never waiting on a later
    frame, never failing. `Decoded`'s and `EspnDecode.layer`'s comments drop what it now says.
  - `static layerTestDying(body: string): Layer.Layer<Decoder>`, today's `TestDecoder.dyingAt`, with the same
    behaviour.
- **`Provider.ts`**: `Provider`, `LiveFeed`, `LiveFeedDemand`, `Polling`, and
  `ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("ProviderUnavailable", {…})`, with the fields
  of today's `ProviderError` and no other change. Its tag string is in no stored data
  (`rg -n "ProviderError" fixtures telemetry` should find none; if it finds any, stop and ask).
- **`provider/Archive.ts`**: `Archive` without `retry`; `ArchivedGame`; `ArchivedPlay` as an `interface`;
  `ArchiveFetchFailed`.
- `EspnArchive.ts:216` stops exporting `retry` on the port. The private `retry` stays.
- **`TestDecoder.ts`** keeps `listedBy`, `decodedFrames` and `FramesDecoded`.
  - `FramesDecoded.layer<E>(frames)` → `static layerOf(frames)`, because a static function is a `layer…` variant.
  - `listedBy` and `decodedFrames` become `Effect.fn`.

**Tests:**
- Tests of `ProviderError` rename. `ProviderError` in a test name becomes `ProviderUnavailable`, and every assertion
  is kept.
- `dyingAt` users (2 files) call `Decoder.layerTestDying`.

**Steps:**
- [ ] `CONTEXT.md`:
  - the **Provider error** row → **Provider unavailable** (`ProviderUnavailable`); the old name goes to Avoid;
  - **Decoded** and **Decode observation** name `Decoder.ts`;
  - **Archive** names `provider/`.
- [ ] `pnpm check`. Commit `refactor(hub): the Decoder owns what it emits; ports without dead members`.

## H5: ESPN's wire spelling apart from its decoding

**Files:**
- Create `provider/espn/EspnPayload.ts`.
- Modify `EspnEvent.ts`, `EspnPlay.ts`, `EspnSummary.ts`, `EspnDecode.ts`, `EspnArchive.ts` (the decoder only),
  `FastCastDocument.ts` (imports only), and their tests.
- Update `.dependency-cruiser.cjs` `provider-payloads-are-private`, which already matches `*Payload.ts`: check that it
  lets every ESPN module that needs `EspnPayload` import it.

**`EspnPayload.ts`** (a payload module, exempt from the glossary) holds every struct that spells ESPN's JSON as ESPN
writes it, and no `decodeTo` into a domain type:
- `SiteEvent`, today's `EspnEvent.Raw` minus its transforms;
- `FastCastEvent`, today's anonymous inline struct at `EspnEvent.ts:39-60`;
- `Competitor`;
- `EspnSituation`, today's `EspnEvent.Situation`;
- `EspnStatus`, the wire half of `Status`;
- `Scoreboard`;
- `PlayEntity`, today's `EspnPlay.Entity`;
- `PlayType`, `SummaryPlay`, `Summary` (the wire half of `EspnSummary.Raw`), and `TeamRef`, one struct for today's
  `Key` and `TeamRef`.

Each has an `export type` pair only if a module outside the file names the type.

**Transforms:**
- `EspnEvent.ts` keeps the transform schema: `EspnEvent(league)`, from `SiteEvent | FastCastEvent` to
  `GameSnapshot`. It also keeps `snapshot`, `broadcast`, `situation` and `statusOf`, plus `teamId` and its inverse
  `espnId` (moved from `EspnScript`; drop `espnId` if H2 left it without a caller).
  - `statusOf` is derived from `espnStatuses`: one table, with the lookup computed from it.
  - Its `Situation` import is no longer aliased.
- `EspnPlay.ts` keeps `EspnPlay.FootballPlay(league)` (today's `Play(league)`; the rename removes the shadow), `read`,
  `fields`, `typeOf`, `unknownTypes`, and the type table. `Alike` goes: use the domain-side shape `read` takes.
- `EspnSummary.ts` keeps the `Summary(league)` transform. `plays` is inlined into its one caller (`EspnArchive.ts:189`)
  as `EspnSummary.decode(league)`.
- **One decoder table.** In `EspnDecode.ts`, `decoders` is built with `Record.fromIterableWith(LeagueId.literals, …)`.
  It holds each league's `decodeEvent`, `decodePlay`, `decodeSummary` and `decodeScoreboard`. It replaces the
  hand-written `{nfl, fbs}` objects at `EspnDecode.ts:151`, `:219` and `EspnSummary.ts:98`, and the archive's ad-hoc
  decoder (`EspnArchive.ts:121`, `:254`). `EspnArchive` imports it from `EspnDecode`. If that creates a cycle, put it
  in `EspnEvent.ts` and say why in the commit body.
- `DecodeObservation.EventUndecoded.feed` is typed `FeedFrame["feed"]`. `"Gap" | "Unapplicable"` is declared once,
  beside `DecodeObservation.Reset`, and imported by `FastCastDocument`.
- `EspnDecode.test.ts:881` uses `FastCastMessage.Envelope` instead of its own envelope decoder.

**Tests:**
- Every ESPN test passes unchanged, apart from import paths.
- Add `EspnDecode.test.ts`: `it("should have a decoder for every league")`. It asserts that the table's keys equal
  `LeagueId.literals`.

**Steps:**
- [ ] `rg -n "\bRaw\b|Situation as DomainSituation|\bAlike\b|\{ *nfl:" apps/hub/src/provider` finds nothing.
- [ ] `pnpm check`. Commit `refactor(espn): ESPN's spelling in EspnPayload; decoding beside it; one decoder table`.

## H6: FastCast, the archive and the provider layers

**Files:** create `provider/espn/FastCastTopic.ts`; modify `FastCastMessage.ts`, `FastCastDocument.ts`, `FastCast.ts`,
`EspnArchive.ts`, `EspnProvider.ts`, their tests, and `CONTEXT.md`.

**Interfaces:**
- **`FastCastTopic.ts`**, a class module:
  - `export type Owner = Data.TaggedEnum<{ Scoreboard: {…}; Game: {…} }>` with `export const Owner`, both as today;
  - `topic(owner)` → `export function topicOf(league, game?)`;
  - `owner(topic)` → `ownerOf(topic)`.

  A `Data.taggedEnum` cannot carry statics, so these stay functions beside it. AGENTS.md allows the constructors and
  `$match` of a `Data.taggedEnum` as its operations; put these two directly below `Owner` and say so in their doc.
  `CONTEXT.md`'s **Topic owner** row names this file.
- **`FastCastMessage.ts`** is pure wire: `checkpointOf(owner)` → `Checkpoint(owner)`, a PascalCase schema factory.
- **`FastCastDocument.ts`**:
  - `reset(owner, reason, detail)` loses `next`. It is pure and returns the `Topic.AwaitingCheckpoint()` change.
  - Every `owner._tag === "Scoreboard"` becomes `Owner.$is("Scoreboard")(owner)`, and
    `documents.get(...)?._tag === "Synced"` becomes `Topic.$is("Synced")`.
- **`FastCast.ts`**:
  - `CheckpointError` → `CheckpointUnread`, with the same fields. Its glossary row moves.
  - `connect` becomes `Effect.fn("FastCast.connect")`, keeping the `sportal.topics` attribute through
    `Effect.annotateCurrentSpan`. It drops `Effect.withSpan`.
  - The nested `yield*` at `:50` and `:164` are unnested.
- **`EspnArchive.ts`**: `layer` yields its services and returns the port over private `Effect.fn` helpers below it:
  `write`, `fetch` (span `EspnArchive.fetch`), `kept`, `exists`, `gamesOf` (span `EspnArchive.games`) and `refusalOf`.
  The spans keep their names and attributes. `Failed` becomes an inline type.
- **`EspnProvider.ts`**:
  - `poll` is `Effect.fn("EspnProvider.poll")`, keeping its `sportal.league` attribute.
  - The frame is built with `new FeedFrame`.
  - `receivedAt` is bound to its own `const` first.
- **`ScenarioProvider.ts`**:
  - `poll`, the same, with span `ScenarioProvider.poll`.
  - Its `"fastcast"` and `noEvents` move under a doc comment that names them as ESPN's spelling of a push and of an
    empty scoreboard.

**Tests:**
- FastCast, FastCastDocument and EspnArchive tests pass unchanged, except for renames.
- `TestTelemetry.recordingSpans` assertions on span names and attributes still pass. That is the check that spans
  were kept.

**Steps:**
- [ ] `rg -n "withSpan|CheckpointError|checkpointOf|_tag ===" apps/hub/src/provider apps/hub/src/scenario` finds
  nothing.
- [ ] `pnpm check`. Commit `refactor(espn): topic owners in FastCastTopic; layers over named steps`.

## H7: The live slate reads as following, timer, publication

**Files:**
- `LiveSlate.ts`, `LiveSlateTelemetry.ts`.
- Delete `DecodeTelemetry.ts` and fold its tests into `LiveSlateTelemetry.test.ts`.
- `Ingest.ts`, `HubStopping.ts` and their tests.
- `CONTEXT.md` (**Live slate**, **Live feed demand**).

**Interfaces:**
- **`LiveSlate` service:**
  - `demand` goes.
  - A new member, `readonly resyncs: Stream.Stream<string>`: each channel a decoded frame asked to resync, as it was
    taken, live only (not in replay).
  - Every other member is unchanged. `events` stays.
- **`Ingest.layer`** builds the live feed's demand with a private `Effect.fn`, `demandOf(slate)`, below the layer. It
  merges the following, which leave `LiveSlate`:
  - `LiveFeedDemand.Games` on each change of the current games' ids (today's `currentGames` and `sameIds`);
  - `LiveFeedDemand.Resync` per resync.

  It then calls `provider.push(demand)`. Read `LiveSlate.ts:249-318` and move that logic, unchanged in behaviour.
- **`LiveSlate.layer`:**
  - Its body is three phases, separated by blank lines: following (`step`, `replay`, `take`, `goLive`, `follower`),
    the timer (`wake`), and publication (`publication`).
  - Closures that need the layer's refs stay inside it. Each one becomes an `Effect.fn` const when it is reused or
    traced. `take` keeps the span `LiveSlate.take`, and `replay` moves to `Effect.fn("LiveSlate.replay")`.
  - `sleepUntil` is inlined.
  - The stop-logging block (`:187-199`) calls `HubStopping.loggedUnlessStopping`.
- **`LiveSlateTelemetry`** exports exactly:
  - `told: (following: Following, frame: Frame, before: Slate, taken: Taken) => Effect.Effect<void>`. It is
    everything a take tells: decode observations (today's `DecodeTelemetry.observed`), slate observations, events
    (live only; quiet in replay), and the state gauges and counts that today's `step` calls. It owns the
    replay-quiet rule.
  - `wentLive: (slate: Slate) => Effect.Effect<void>`, today's `gaugeHeld` over every game plus `countByState`, as
    `goLive` calls them.
  - `timerDefect`, unchanged.
  - `timedTake: <A, E, R>(take: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>`, which wraps
    `Effect.trackDuration(takeDuration)`.
  - Every metric is private. The consts are renamed for what they measure (`snapshotsTaken`, `playsCounted`,
    `deliveriesDropped`, `liveGamesByState`, `gameDefects`, `gameStateGauge`, `transitionsCounted`, `staleDuration`,
    `gameEventsCounted`), with their ids unchanged.
  - `Match.valueTags` → `Following.$match`, and `_tag === "Played"` → `GameEvent…$is` (whatever the event union
    offers; read `packages/domain/src/GameEvent.ts`).
  - The "Played" count in LiveSlate's replay summary reuses one helper with the telemetry, a static on the domain
    type if one fits.
- **`HubStopping`** keeps `isStopping` and `loggedUnlessStopping`, now with two callers.

**Tests:**
- `LiveSlate.test.ts`:
  - The `demand` tests move to `Ingest.test.ts`, keeping every assertion, under `describe("Ingest.layer")`:
    - `it("should ask the live feed to follow the current games")`
    - `it("should ask again only when the games' ids change")`
    - `it("should ask the live feed to resync a channel the decoder dropped")`
  - New: `it("should emit each resync a live frame asks for")` and `it("should emit no resync during replay")`.
- `DecodeTelemetry.test.ts` moves into `LiveSlateTelemetry.test.ts` under `describe("LiveSlateTelemetry.told")`. Each
  test drives `told` with a frame's `Decoded`, with the same assertions.
- `withMetrics`/`counted`/`gauged` assertions on metric ids are unchanged. That is the check that the ids held.

**Steps:**
- [ ] `rg -n "currentGames|sameIds|LiveFeedDemand|DecodeTelemetry|gaugeHeld|countByState|takeDuration" apps/hub/src --glob '!Ingest*' --glob '!provider/**'`
  finds nothing.
- [ ] `pnpm check`. Commit `refactor(hub): the live slate follows, times and publishes; Ingest asks the feed`.

## H8: No mirror, and the server flattened

**Files:**
- `packages/api/src/LiveMessage.ts`, `packages/domain/src/SlateObservation.ts`, `apps/hub/src/LiveSlate.ts`,
  `LiveSlateTelemetry.ts`.
- `git mv apps/hub/src/hub-server/HubServer.ts apps/hub/src/HubServer.ts`, its test likewise. Fold in
  `hub-server/LanAddresses.ts` and its test, then delete the folder.
- `main.ts`, `apps/web/src/hub/LiveStream.ts:104`, the web tests that build a `SlateChanged`
  (`rg -l SlateChanged apps/web`), `CONTEXT.md`, `docs/technical-spec.md`, `.dependency-cruiser.cjs` if it names
  `hub-server`.

**Interfaces:**
- **`LiveMessage`:**
  - It becomes `Schema.TaggedUnion({ SlateChanged: { games: …, recentPlays: … }, … })`, with its type pair, matched
    with `LiveMessage.match`.
  - Its other cases are unchanged.
  - `export type SlateChanged = typeof LiveMessage.cases.SlateChanged.Type`. Check the exact accessor in `Schema.d.ts`.
- **`LiveSlate.published: Effect.Effect<SlateChanged>`** and `changes: Stream.Stream<SlateChanged>`. `Published`
  goes, and LiveSlate builds the case with `LiveMessage.cases.SlateChanged.make`, or whatever constructor
  `TaggedUnion` gives.
- **`SlateObservation.Started` and `Stopped`** carry `after: LiveGame`, as `Changed` does. `afterOf` goes. Update
  every reader (`rg -n "liveGame" packages/domain/src apps/hub/src`).
- **`HubServer.ts`**, a namespace module:
  - `export const layer`, today's `serve`;
  - `export const layerListen`, today's `listen`, if `main.ts` or a test uses it apart from `layer`;
  - the handler layers as private consts, below `layer`'s builder and lazily referenced: a const used inside a
    `Layer.unwrap` body is safe; one used in an eager top-level expression must move above it;
  - `lanAddresses` as a private function below its user;
  - `sessions` → `stage`.
- **SSE framing:** read `effect/dist/encoding/Sse.d.ts`. If its encoder writes both `data:` events and a comment line
  for the keep-alive, use it. Otherwise leave the hand-written framing and note it in the ledger.
- **The web:** `LiveStream.ts:104` reads `message.games` into `live.slate`. The web's own `live.slate` field is outside
  this unit; leave it.

**Tests:**
- `HubServer.test.ts` gains `LanAddresses.test.ts`'s tests under `describe("HubServer.lanAddresses")`. They test it
  through the endpoint that serves the addresses if that endpoint is in the test file already. Otherwise export
  nothing new: test through `GET /api/hosts` (or whatever route `hostHandlers` serves; read it).
- Every SlateChanged assertion, in Hub and web tests, reads `games` where it read `slate`.
- `SlateObservation` and `LiveSlateTelemetry` tests read `after`.

**Steps:**
- [ ] `rg -n "Published|afterOf|hub-server|sessions" apps packages --glob '!node_modules'` finds nothing but history.
- [ ] `pnpm check`. Commit `refactor: SlateChanged carries games; the server is one module`.

## H9: The corpus

**Files:**
- `git mv corpus/CorpusInput.ts corpus/CorpusLine.ts`, its test likewise.
- Create `corpus/GameDay.ts`.
- Fold `corpus/CorpusWorker.ts` into `corpus/CorpusRun.ts`, and its test into `CorpusRun.test.ts`.
- Modify `corpus/corpus.ts`, `CorpusDay.ts`, `CorpusBuild.ts`, `Synthesis.ts`, `worker.ts`, `TestCorpus.ts`,
  `provider/Archive.ts`, `CorpusDay.test.ts`, `CONTEXT.md`, `knip.json` (the entry list is unchanged).

**Interfaces:**
- **`GameDay.ts`**, a class module:
  - `export const GameDay = Schema.String.check(<YYYY-MM-DD>).pipe(Schema.brand("GameDay"))` with its type pair;
  - `GameDay.bounds(day, zone)` → `{ from: DateTime.Utc, until: DateTime.Utc }`, today's `CorpusDay.bounds`;
  - `GameDay.dates(from, to)`, today's `CorpusDay.dates`.

  A branded schema cannot carry statics. Make it `class GameDay extends Schema.Class` only if a single-field class
  reads better at its call sites. Otherwise export `bounds` and `dates` as functions beside the schema, the spec's
  allowance for operations on a value type. Choose one, and say which in the commit body.
- Every `date: Schema.String` in `CorpusDay`, `CorpusDayUnreadable`, `CorpusBuildFailed`, `RunDay`, `DayRun` and
  `ArchiveFetchFailed` becomes `GameDay`. corpus.ts's private `GameDay` refinement goes.
- **`CorpusLine.ts`:**
  - `CorpusLine` first, then `CorpusInput`.
  - `CorpusLine.ofDecoded(decoded: Stream.Stream<Decoded>): Effect.Effect<{ poll: ReadonlyArray<CorpusLine>; push: ReadonlyArray<CorpusLine> }>`
    replaces the `mapAccumEffect(() => Had.empty, …)` threading in `CorpusBuild.ts:49-55,86-87` and
    `Synthesis.ts:73-83`.
  - `CorpusLine.decodedOf(lines)` replaces the read-side twin at `CorpusDay.ts:172`.
  - `Had` stays in the file, unexported.
- **`CorpusRun.ts`:**
  - `day` and `Subject` (an `interface`), and `events`;
  - `RunDay`, `DayRun` and `runDays` from `CorpusWorker.ts`, as `Effect.fn` where they return effects.

  `worker.ts` imports `RunDay` from `CorpusRun.ts`.
- **`DaysFailed`** moves to `corpus.ts`, its only thrower. Check with `rg -n DaysFailed`. If `runDays` raises it, it
  stays in `CorpusRun.ts`.
- **`CorpusBuild.captured` and `backfilled`** become `Effect.fn("CorpusBuild.captured")` and so on. Their bodies follow
  AGENTS.md rules 9–10, the ones the AGENTS examples quote: `leaguesOf(deliveries)` and the games count are named
  before `new CorpusDay`.
- `TestCorpus.inCorpus`'s unused decoder argument (readability ledger, Task 15 minor) is dropped if it is unread.

**Tests:**
- `CorpusInput.test.ts` → `CorpusLine.test.ts`. Its tests are unchanged; add, under `describe("CorpusLine.ofDecoded")`:
  - `it("should split a day's lines into poll and push")`
  - `it("should write a line only for what changed since the last")`

  Read today's threading for the exact semantics, and assert what it does today.
- `GameDay.test.ts`:
  - `it("should accept a YYYY-MM-DD date")`
  - `it("should refuse a date that is not YYYY-MM-DD")`
  - the `bounds` and `dates` tests from `CorpusDay.test.ts`, moved with their assertions.
- `CorpusWorker.test.ts` → `CorpusRun.test.ts` under `describe("CorpusRun.runDays")`.

**Steps:**
- [ ] Run the events comparison as in H3: build into `$SCRATCH/corpus-h9`, dump, diff. No difference.
- [ ] `pnpm check`. Commit `refactor(corpus): a game day, a line, a run`.

## H10: The rest of the Hub, to the convention

This task absorbs the readability plan's Tasks 18–19. It covers every file under `apps/hub/src` that H1–H9 did not
already bring to the convention. Go folder by folder, with one commit per folder (`root`, `provider/espn`, `corpus`,
`scenario`, `source`): `refactor(<area>): <area> to the house spellings`.

For each file:
- [ ] **Service id.** `"sportal/hub/<dir>/Name"`, the path from `src/` (`"sportal/hub/provider/Provider"`, or
  `"sportal/hub/LiveSlate"` at the root).
- [ ] **Layers.**
  - Every static layer is `layer` or `layer…`, with its type written out (`LiveStage.layer`, `HubConfig.layer`).
  - `HubConfig.layerTest(env: Record<string, string>)` replaces `TestHubConfig.withEnv` (16 files). `TestHubConfig.ts`
    keeps `home`, or loses it if `home` is used by one test file only: move it there.
  - `main.ts`'s `Hub` const keeps its name, because an entry point is not a module.
  - `TestSnapshotFeed` exports `layer(…)` (today's `provider` and `polled`, merged into one options object) and
    `layerDecoder`. Its poll reuses `framed`, `encodePayload` goes, and `SnapshotPayload` gets its type pair.
  - `TestLiveSlate`'s helpers with one user file (`slateOn`, `slateFollowingFramesFrom`, `takenInTime`) move into
    `LiveSlate.test.ts`. The `{ decoder?, zone? }` bag is written once.
- [ ] **Effects.** Every `function` that returns `Effect.gen`, or is typed `: Effect.Effect<…>` and builds one,
  becomes an `Effect.fn("Module.name")` const. A hot path, or a helper with no reason for a span, uses
  `Effect.fnUntraced`. The pure ones stay `function`. Mind the hoisting note: an `Effect.fn` const used by an eager
  top-level expression goes above it.
- [ ] **Unions.** Every remaining `_tag ===` / `_tag !==` in `apps/hub/src` non-test code becomes `X.$is` for a
  `Data.TaggedEnum`, `X.guards` for a `Schema.TaggedUnion`, or a `Predicate` over an Effect error's own guard (an
  `HttpClientError` reason, for example; read its module for the guard).
- [ ] **Shapes.** Every `type X = { … }` object alias becomes `interface X`.
- [ ] **Errors.** No `…Error` names remain.
- [ ] **Comments.** Every service has a doc comment (`Source`, `LiveStage`). Restating comments are trimmed.
- [ ] **Layout.** The code layout standard: phases, every `yield*` on its own line, named calculations, named chains.
  Run the nested `yield*` check over the folder; it prints nothing.
- [ ] Run `pnpm vitest run --project hub`, then `pnpm check`, then commit.

After the last folder:
- [ ] `rg -n "_tag ===|_tag !==|Match\.valueTags|withSpan|class \w+Error\b|^(export )?type \w+ = \{" apps/hub/src -g '!*.test.ts'`
  prints nothing. The nested `yield*` check over `apps/hub/src` prints nothing.
- [ ] `rg -n "return Effect\.gen" apps/hub/src -g '!*.test.ts'` prints only what is inside a `Layer.effect` or an
  `Effect.fn` body.

## H11: Outside the Hub

**Files:** `packages/domain/src/Stage.ts`, `Stream.ts`, `packages/api/src/Hotkey.ts`, and the domain, api and web tests
that build or match them. `packages/domain/src/Slate.ts` (`Taken`), `apps/web/src/hub/LiveStream.ts` (`Live`),
`apps/web/src/display/OverlayHost.tsx` (`Rect`), `apps/desktop/src/main/TileViews.ts` (`Entry`),
`apps/desktop/src/main/GuideReader.ts`, `main/main.ts`, and every `Context.Service` id outside the Hub.

- **Wire unions:** `Tile`, `Tile`'s `why`, `StageCommand`, `StreamLocator` and `Hotkey` become `Schema.TaggedUnion`,
  with their type pairs, each case's fields unchanged.
  - Check that the wire shape is identical. Each schema's existing round-trip test passes unchanged. Where a schema has
    none, add one first:
    - `it("should decode what it encodes")`, over one value of each case.
    - `it("should encode … as today")`, against a literal JSON written before the change.
  - Existing `_tag ===` tests on these in domain and web code stay. The spec moves nothing else outside the Hub.
- **Object aliases** → `interface`: `Taken`, `Live`, `Rect`, `Entry`. `SourceEvent` stays a union.
- **Desktop:** `readGuide`, `forward` and `listen` become `Effect.fn`.
- **Service ids:** `"sportal/<app>/<dir>/Name"`; the desktop's are `"sportal/desktop/main/TileViews"` and so on.
- [ ] `pnpm check`. Commit `refactor: the house spellings outside the Hub`.

## H12: The unit holds

- [ ] Run the events comparison over `corpus-before` with the final code: no difference.
- [ ] `pnpm dev:golden` starts, and the Hub logs `LiveSlate: replayed …`. Do not judge rendering from the agent shell
  (memory: Electron GPU evidence). Ask the user to look if anything visible changed.
- [ ] `pnpm check`. `rg -n "GameHistory|ScenarioScript|EspnScript|DecodeTelemetry|ProviderError|CheckpointError|hub-server" apps packages AGENTS.md CONTEXT.md docs/technical-spec.md`
  prints nothing.
- [ ] Tell the peer the unit is done, and add a ledger line to its `progress.md` through it (it owns that file).
  Readability Tasks 20–23 resume.
- [ ] Run `plannotator review` on the unit's commits (`git diff <unit base>..HEAD`), act on the feedback, then hand
  back.
