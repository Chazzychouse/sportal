# Hub organization: findings

Status: investigation, 2026-10-07. Not yet a spec. It comes from five read-only audits of `apps/hub/src`: core and
storage, live slate and server, provider and ESPN, corpus/scenario/source, and the conventions Effect 4 documents.
Where the repo's habits conflict with Effect's own idiom, Effect's idiom is chosen, as the user directed.

## 1. Why the Hub reads as haphazard

The trouble is not one bad file. The Hub spells each kind of declaration several ways, so a reader cannot tell from a
name or a position what a thing is.

1. **Two module shapes, mixed and unmarked.**
   - Some files are *class modules*, named for a `Context.Service` or a `Schema`/`Data` class and imported by name.
   - Others are *namespace modules* of loose functions plus `layer`, imported with `import * as` (109 such imports,
     against 0 in every other package): `Gzip`, `Database`, `Ingest`, `EspnDecode`, `CorpusBuild`.
   - Nothing says which a file is. The lowercase entry points (`main.ts`, `corpus/corpus.ts`, `corpus/worker.ts`)
     are knip's entry list, but nothing says so either.
2. **Layers have six spellings.**
   - `static readonly layer`, with its type written out (`FeedLog`) or inferred (`LiveStage`).
   - Statics named for where the data lives: `FeedLog.inDataDir`, `FeedLog.forScenario`.
   - A static *function* named `layer`: `Scenarios.layer(written)`, beside `Scenarios.in()`.
   - A module `export const layer`: the adapters, `Ingest`, `HubMode`, `Telemetry`.
   - Module consts with other names: `HubServer.serve` and `listen`, `Database.inDataDir`, `main.ts`'s `Hub`.
   - Zero-argument private functions that return layers, so they can sit below their user
     (`HubServer.stageHandlers` and siblings).
3. **Effectful functions have four spellings.**
   - `Effect.fn` consts: 13.
   - `function` returning `Effect.gen`: 18. Effect's AGENTS.md says: "Avoid creating functions that only wrap and
     return an `Effect.gen`."
   - Plain `function …: Effect.Effect`: about 21.
   - Bare `Effect.gen` consts, and arrow closures inside layer bodies.
   - As a result, pure helpers and effects look the same, and spans are added by hand (`Effect.withSpan`) in some
     places and through `Effect.fn` in others.
4. **Unions have four spellings.**
   - In memory: `Data.TaggedEnum`, which is consistent.
   - On the wire there are three: `Schema.TaggedUnion` (`CorpusInput`); `Schema.Union([TaggedStruct…])`
     (`LiveMessage`, `FastCastMessage`); and a union discriminated on `kind`, not `_tag` (`FeedLog.Stored`).
   - They are tested three ways: `$match`/`$is`, `Match.valueTags` (one use), and raw `_tag ===`.
5. **Wire schemas carry no marker.**
   - `YouTubeTvPayload.ts` keeps the provider's spelling apart from decoding.
   - ESPN's wire structs are scattered through `EspnEvent`, `EspnPlay` and `EspnSummary` beside the transforms, under
     names that collide with domain ones: `Raw` (twice), `Play`, `Situation` (three in one file), `Scoreboard` (four
     meanings).
6. **Service files are junk drawers.**
   - `FeedLog.ts` (585 lines) holds about seven concepts: the port, the intake, the writer state machine, replay,
     game days, the `feed_frame` table with its codecs, queries and migrations, four metrics, and a generic schema
     combinator.
   - `LiveSlate.ts` holds following, the timer, publication and live feed demand.
   - `Provider.ts` holds the Decoder's types.
7. **SQL has two shapes.**
   - `GameHistory` builds its `SqlSchema` consts once, over a captured `sql`, inside the layer. That is Effect's
     documented shape (`ai-docs/src/40_sql/10_basics.ts`).
   - `FeedLog` rebuilds each query per call from module functions, then injects the client back with
     `provideService`.
8. **The same name means different things.**
   - `writeFailures` is two metrics.
   - `day` is two functions.
   - `inDataDir` is a static layer on `FeedLog` and a module const on `Database`, for different files.
   - `Published.games` becomes `SlateChanged.slate` on the wire, so "slate" names both a class and an array.
   - Metric consts are named like data (`plays`, `snapshots`).

## 2. The house convention: one spelling per kind

Effect is the tiebreaker. ⚠ marks a change from current repo rules or habits.

### Module shape

- **A class module** exports one class named for the file: a service, a `Schema.Class` or a `Data.Class`. It may also
  export that class's member types, its errors, and the schemas its fields read. It is imported by name.
- **A namespace module** has no main class. It is an adapter (`EspnProvider`), a layer-only module (`Ingest`,
  `HubMode`), or a set of functions (`Gzip`). It is imported `import * as X`. An adapter exports `layer`, as Effect's
  own `FetchHttpClient.layer` does.
- **A lowercase file** is a process entry point and nothing else.
- **A `*Payload.ts` file** is a provider's wire spelling, with no transforms to domain types. This restores
  `EspnPayload.ts`, which reverses the 2026-10-06 cleanup's merge, so that "is this wire?" is answered by the import
  path.

### Kind → spelling

| Kind | Spelling | Name |
|---|---|---|
| Port | `class P extends Context.Service<P, {…}>()("sportal/hub/<dir>/P") {}` ⚠ the id includes the subfolder, per `01_service.ts` | glossary noun |
| Service with its own implementation | the same, plus `static readonly layer: Layer.Layer<…> = Layer.effect(…)`, with its type always written out; members as `Effect.fn("S.member")` | `layer` |
| Layer variant | `static readonly layerX` or `static layerX(args)` ⚠ | `layerInDataDir`, `layerMemory`, `layerFor(folder)` |
| Test layer | `static readonly layerTest…` on the service it fakes ⚠ (`09_testing/20_layer-tests.ts`); needs a knip exemption for `layerTest*`. Fixtures and data stay in `Test*.ts` | `layerTest` |
| Layer that provides nothing | a namespace module's `export const layer` | `layer` |
| Effectful operation | `const f = Effect.fn("Module.f")(…)`, or `Effect.fnUntraced` on hot paths ⚠ replaces "function returning Effect.gen" | span name = `Module.f` |
| Pure helper | a hoisted `function`, below its first user | camelCase |
| Wire value schema | `export const X = Schema.…` then directly `export type X = typeof X.Type` | glossary noun, or provider word in `*Payload.ts` |
| Wire entity with behaviour | `Schema.Class` | glossary noun |
| Wire union | `Schema.TaggedUnion({…})` with type pair; `X.match` / `X.guards` ⚠ replaces `Union([TaggedStruct…])` | |
| Wire union, cases with behaviour | `Schema.TaggedClass` per case, then `Schema.Union` | (`Play`) |
| In-memory entity | `Data.Class` | |
| In-memory state | `type X = Data.TaggedEnum<…>` plus `const X = Data.taggedEnum<X>()`; always `$match`/`$is`, never `_tag ===` or `Match.valueTags` | |
| Expected error | `Schema.TaggedError`, named for the outcome (`ScenarioUnknown`, `ArchiveFetchFailed`), never `XError` | |
| Object shape type | `interface` ⚠ (Effect: 1311 interfaces against 39 object aliases) | |
| Other alias (function, Schedule, literal union) | `type` | |
| SQL row | `Model.Class` from `effect/sql`, the same shape as `40_sql/10_basics.ts`; queries are `SqlSchema` consts built inside the layer | |
| Metric | private const at the end of the file; the name says what it measures (`snapshotsTaken`, not `snapshots`) | `sportal_snake` id |
| Service type access | `S["Service"]` allowed ⚠ (`01_service.ts:44`); AGENTS.md's ban is lifted | |

**Hoisting caveat.** An `Effect.fn` const is not hoisted. It may sit below its user only when that user calls it
lazily, inside a generator or a layer body, never in an eager top-level expression.

### Order inside a class module

1. The schemas the class's fields read, which must come first.
2. The class: interface, `layer`, then the `layer*` variants.
3. The concept's member types and errors.
4. Private helpers, in first-use order.
5. Codecs.
6. Metrics.

Storage (rows, queries, migrations) that outgrows its service moves to a sibling file, never to the bottom of the
service file.

## 3. Removals (verified)

| What | Evidence | Size |
|---|---|---|
| **`GameHistory`**, `sportal.sqlite`, `Database.inDataDir`, `GameHistoryError` | Nothing reads `plays` or `latest` outside its tests. `HubMode.ts:38`: "Nothing reads the history yet." | 229 lines plus tests, two CONTEXT rows |
| **The written scenarios**: `ScenarioScript`, `EspnScript`, `written/`, `TestScenarios`, `ScenarioDuplicate`, two dependency-cruiser carve-outs | Only `two-minute-drill-tie` is used outside its own tests, by HubMode, main, HubConfig, Telemetry and ScenarioProvider tests, and checklist row 33. Recordings cover the other four. They are football-only and import `TestGame` into production | about 1,190 production and 530 test lines |
| `Archive.retry` | No reader; EspnArchive uses its private `retry` | 1 member |
| `FastCastDocument.reset`'s `next` parameter | All three callers pass `AwaitingCheckpoint()` | |
| `TestSnapshotFeed.polled` | A wrapper over `provider`; merge the two | |
| The stale `source/ChannelStore.ts` dependency-cruiser rule | The file does not exist | |
| `LiveSlate.events` | No production reader; it waits for the Director. **Kept** unless the user says otherwise (Director-ahead code is left alone) | |

## 4. Restructures

**Storage and the core**
- **`feed-log/`**, a folder because the concept has three private files:
  - `FeedLog.ts`: the port and its layers.
  - `FeedLogWriter.ts`: the `Writer` state, write, store, gap, and its metrics.
  - `FeedFrameTable.ts`: one `Model.Class` row instead of `Row`, `Stored`, `storedColumns` and the gap literal, the
    queries, and the migrations.
- `FeedLog.forScenario` moves into `HubMode`, the only module allowed to know about scenarios.
- **`Decoded` and `DecodeObservation` move into `Decoder.ts`.** `Provider.ts` keeps poll, push, schedules and the
  error. One doc comment replaces the three that overlap.
- **`DecodeTelemetry` folds into `LiveSlateTelemetry`** (one caller). `Telemetry.ts` then means only exporter setup.
- `loggedUnlessStopping` is used by both its call sites, or by neither.

**The live slate and the server**
- **Live feed demand moves from `LiveSlate` to `Ingest`.** LiveSlate exposes `resyncs`, and Ingest builds
  `LiveFeedDemand` from `changes` and `resyncs`. About 70 lines and a provider import leave LiveSlate.
- **`LiveSlateTelemetry` is organized around its moments:** `told`, `wentLive`, `timerDefect`. All of its metrics
  become private, and the replay-quiet rule lives in one place.
- **No mirror:**
  - Rename LiveMessage's `slate` field to `games`.
  - LiveSlate publishes that case's type.
  - `SlateObservation.Started`/`Stopped` say `after`, and `afterOf` goes.
  - `sessions` → `stage` in HubServer.
- **`hub-server/` flattens:** `LanAddresses` folds into `HubServer.ts`. The handler layers become `const`s, not
  zero-argument functions.

**The provider**
- **`EspnPayload.ts`** holds ESPN's spellings, named for what they are: `SiteEvent`, `FastCastEvent`, `PlayEntity`,
  `SummaryPlay`, `Summary`, `Scoreboard`. `EspnEvent`, `EspnPlay` and `EspnSummary` keep only the transforms.
- **`FastCastMessage.ts` becomes pure wire.** `Owner`, `topic` and `owner` become statics of `Owner`, in
  `FastCastTopic.ts`.
- **`EspnArchive.layer`** (one 180-line generator with six closures) becomes hoisted `Effect.fn` helpers below it.
- **One league-keyed decoder table** over `LeagueId.literals` replaces the three hand-written `{nfl, fbs}` tables and
  the archive's ad-hoc one. A new league, MLB, would otherwise get no decoder, silently.

**The corpus**
- **`CorpusInput.ts` → `CorpusLine.ts`.** `CorpusLine` gains the poll/push threading that `CorpusBuild`, `Synthesis`
  and `CorpusDays` each repeat, and `Had` stops being exported.
- **A `GameDay` schema** (YYYY-MM-DD, `bounds`, `dates`) replaces corpus.ts's private refinement,
  `CorpusDay.bounds`/`dates`, and six bare-string `date` fields.
- **`CorpusWorker.ts` merges into `CorpusRun.ts`.** `worker.ts` stays as the thread entry. `DaysFailed` moves to the
  CLI.
- **`Archive.ts` moves to `provider/`**, so that `provider/espn` stops importing `corpus/`.

## 5. Duplicates to collapse

- The `feed_frame` row is spelled six times: `Row`, `Stored`, `storedColumns`, `gapRow`, and the DDL twice. Replay
  decodes each row twice.
- `decodeScoreboard` is in both `EspnArchive` and `EspnDecode`.
- `statusOf` and `espnStatuses` are one table, written twice.
- `Key` and `TeamRef` are the same unwrap.
- `teamId` and `espnId` are inverses, kept in different files.
- `"poll" | "fastcast"` and `"Gap" | "Unapplicable"` are re-spelled beside their source types.
- The "Played" filter is in both `LiveSlate` and `LiveSlateTelemetry`.
- `FeedFrame` is built three ways: `new`, a plain literal, and `as const`.
- The stop-logging block is written out inline in `LiveSlate.ts:187` and again in `HubStopping`.

## 6. Decisions for the user

1. **Delete `GameHistory`?** It is write-only today. The alternative is to keep it for the Director.
2. **Delete the written scenarios?** Recordings replace them, and tests and checklist row 33 move to a recorded name.
3. **`layerTest` statics on services (Effect) or `Test*.ts` functions (today)?** Effect's way needs a knip exemption.
4. **Restore `EspnPayload.ts`?** This reverses the 2026-10-06 merge.
5. **Sequencing with the readability branch.** Unit 3 is "touch nothing else: no renames", and Tasks 18–19 would lay
   out Hub files that this work moves or deletes. The proposal:
   - Insert this as a new unit before Tasks 18–19, on the same branch, and lay out each file as it is restructured.
   - Tasks 20–21 (domain, api, web, desktop) can run as planned. The wire-union and `interface` rules would reach
     domain and api too.
