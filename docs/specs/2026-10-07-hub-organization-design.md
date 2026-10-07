# Hub organization — design

Status: decisions approved 2026-10-07 in the annotation of `2026-10-07-hub-organization-findings.md`, which holds the
evidence. This is a new unit on the `readability` branch, run after Unit 2 and before the Hub's code layout tasks
(18–19). Those two tasks are folded into this unit, and each file is laid out to the code layout standard as it is
restructured. Tasks 20–21 (domain, api, web, desktop layout) run as planned.

## Goal

A reader can tell what any declaration in the Hub is from its file, its name and its spelling, and each file holds one
concept. Where Sportal's habits and Effect 4's documented idiom disagree, Effect's idiom wins.

## Decisions

- **Behaviour is preserved,** except for what the removals below take away. The proof is the same as Unit 1's:
  - `pnpm check`;
  - the rewritten tests;
  - the events comparison over `corpus-before`, which must show no difference.
- **Metric names and the API's wire shape stay the same.** The one exception is LiveMessage's `slate` field, which is
  renamed `games` (see "No mirror"). The web decodes LiveMessage with the same schema, so no reader is left behind.
- **`GameHistory` is deleted.** Nothing reads it, and keeping it constrains the Director's design.
- **The written scenarios are deleted.** Recordings replace them.
- **Test fakes follow Effect** (`ai-docs/src/09_testing/20_layer-tests.ts`): a fake of one service is a `layerTest…`
  static on that service.
- **`EspnPayload.ts` is restored,** reversing the 2026-10-06 cleanup's merge, so that ESPN's wire spelling sits apart
  from its decoding, as YouTube TV's already does.

## The convention

These replace or extend `AGENTS.md`'s "Where code goes", "Inside a file" and "How code is written". The new text is
written there in this unit's first commit, as Unit 1 did for the layout rules. ⚠ marks a reversal of a current rule.

### Module shapes

Every `.ts` file is exactly one of these:

| Shape | What it exports | How it is imported |
|---|---|---|
| **Class module** | One class named for the file: a service, a `Schema.Class` or a `Data.Class`. Beside it, only that concept's member types, errors, and the schemas its fields read | By name |
| **Namespace module** | No class of its own: an adapter of a port defined elsewhere (`EspnProvider`), a layer that provides no service (`Ingest`, `HubMode`), or a set of functions (`Gzip`). An adapter or a layer-only module exports `layer`, as Effect's `FetchHttpClient.layer` does | `import * as X` |
| **Payload module** (`*Payload.ts`) | A provider's wire spelling: schemas in its own words, with no transform into domain types | By name |
| **Entry point** (lowercase name) | Nothing. It runs a process. The Hub has `main.ts`, `corpus/corpus.ts` and `corpus/worker.ts`, which are knip's entries | – |
| **Test module** (`Test*.ts`) | Fixtures, recorded payloads, builders of domain values, harnesses that compose several layers, and test-only adapters of a port (the snapshot feed) | Either, as its shape says |

### One spelling per kind

| Kind | Spelling |
|---|---|
| Service id | `"sportal/<app>/<dir>/Name"`, the path from the package root (`01_service.ts`). Today's ids leave out the folder ⚠ |
| Service layer | `static readonly layer: Layer.Layer<…> = …`, with its type always written out |
| Layer variant | `static readonly layerX`, or `static layerX(args)` when it takes arguments. Never a different word ⚠: `FeedLog.inDataDir` → `layerInDataDir`, `Scenarios.in(dir)` → `layerFrom(dir)` |
| Test layer | `static readonly layerTest` or `static layerTest…(args)` on the service it fakes ⚠. It takes its data as arguments and imports no fixture and no `Test*.ts`. knip's `ignoreMembers` exempts `^layerTest` |
| Layer that provides nothing | A namespace module's `layer`, or `layerX` for a variant. Never `serve`/`listen`, and never a zero-argument function that returns a layer |
| Effectful operation | `const f = Effect.fn("Module.f")(…)`, or `Effect.fnUntraced` on a hot path. A service member is `Effect.fn("Service.member")`. Never a `function` that only returns `Effect.gen`, and never a hand-added `Effect.withSpan` ⚠ |
| Pure helper | A hoisted `function`, below its first user |
| Wire value | `export const X = Schema.…`, then directly `export type X = typeof X.Type` |
| Wire union | `Schema.TaggedUnion({…})` with its type; matched with `X.match`, tested with `X.guards` ⚠. When the cases have behaviour, one `Schema.TaggedClass` per case, then `Schema.Union` (as `FootballPlay` is) |
| In-memory value | `Data.Class` |
| In-memory state | `type X = Data.TaggedEnum<…>` with `const X = Data.taggedEnum<X>()`. Matched with `X.$match` and tested with `X.$is`. Never `_tag ===`, and never `Match.valueTags` |
| Expected error | `Schema.TaggedError`, named for what happened, never `…Error` ⚠: `ProviderError` → `ProviderUnavailable`, `CheckpointError` → `CheckpointUnread` |
| Object shape | `interface` ⚠ (Effect writes 1311 interfaces against 39 object aliases). `type` stays for functions, schedules, unions and derived types |
| A service's type | `S["Service"]` is allowed ⚠ (`01_service.ts:44`). A port still names the member types other modules need |
| SQL row | `Model.Class` from `effect/schema`, one per table. Queries are `SqlSchema` consts built inside the layer from the `sql` it yields (`40_sql/10_basics.ts`), never rebuilt per call |
| Metric | A private const at the end of its file, named for what it measures (`snapshotsTaken`, not `snapshots`). Its id is unchanged |
| Codec | `const decodeX` / `encodeX` below its users |

**Hoisting.** An `Effect.fn` const is not hoisted. It may sit below its user only when that user runs it lazily
(inside a generator or a layer's effect), never when an eager top-level expression calls it.

### Order inside a class module

1. The schemas the class reads when it is defined.
2. The class: for a service, its interface, `layer`, the `layer…` variants, then the `layerTest…` statics; for a data
   class, its fields, statics, then methods.
3. Its member types and errors.
4. Private helpers, in first-use order.
5. Codecs.
6. Metrics.

When storage (rows, queries, migrations) or a second state machine outgrows its service, it moves to a sibling file in
the concept's folder. It never grows at the bottom of the service file.

## Removals

1. **Game history:**
   - `GameHistory.ts` and its test.
   - `GameHistoryError`.
   - `Database.inDataDir` and `sportal.sqlite`.
   - Its line in `HubMode.live` and `main.ts`.
   - Its use in `Ingest.test`.
   - CONTEXT's **Game history** and **Game history error** rows; "game history" in the technical spec.

   `Database` keeps `layerFile(name)`, `layerMemory` and `migrate` for the feed log.
2. **Written scenarios:**
   - `scenario/ScenarioScript.ts`, `provider/espn/EspnScript.ts`, `scenario/written/` and `scenario/TestScenarios.ts`,
     with their tests.
   - `ScenarioDuplicate`, and `Scenarios`'s `written` parameter and `written()` static.
   - The dependency-cruiser carve-outs for them, including the production import of `TestGame`.
   - CONTEXT's **Scenario script** row, and the written-scenario words in its **Scenario** row.

   Every test that names `two-minute-drill-tie` moves to a recorded scenario: `crowded-fourth-quarter`, or a smaller
   one if a test needs fewer frames. So do `docs/game-day-checklist.md` row 33 and AGENTS.md's `SPORTAL_SCENARIO`
   paragraph. A Scenarios test that needs a name collision gets it from two recordings.
3. **`Archive.retry`**, which nothing reads.
4. **`FastCastDocument.reset`'s `next` parameter**, which every caller passes as `AwaitingCheckpoint()`. `reset`
   becomes pure.
5. **The stale `source/ChannelStore.ts` dependency-cruiser rule.**

Kept on purpose:
- `LiveSlate.events`, which waits for the Director.
- The `FastCast` service, a decision of the 2026-10-06 DI cleanup.

## Restructures

### The feed log: `feed-log/`

This is a folder because the concept has three files private to it.

- **`FeedLog.ts`**:
  - The port.
  - `layer` (intake: seq, publish, queue; it starts the writer and adds the finalizer).
  - `layerInDataDir`, `layerMemory` and `layerTest(frames)`, which replaces `TestFeedLog.logged`.
  - `replay` and `days`, as `Effect.fn` members over queries built once.
- **`FeedLogWriter.ts`**: the `Writer` state, `write`, `store`, the gap row, `closeGap`, and the writer's four metrics.
- **`FeedFrameTable.ts`**:
  - One `Model.Class` row for `feed_frame`. Its `kind` includes `unchanged` and `gap`, and `feed`/`channel` are
    nullable.
  - Its queries and its migrations.

  The row replaces `Row`, `Stored`, `storedColumns`, `absentWhenNull` and the gap literal. A replayed row is decoded
  once.

`FeedLog.forScenario` moves into `HubMode`, the only module that knows scenarios, as a `Layer.unwrap` over
`scenarioFeedLog`. `Frame.ts` stays a class module beside the folder: `FeedFrame` and `Frame`.

### The ports: `Provider.ts` and `Decoder.ts`

- `Decoded` and `DecodeObservation` move to `Decoder.ts`, the port that emits them.
- `Provider.ts` keeps `Provider`, `LiveFeed`, `LiveFeedDemand`, `Polling` and `ProviderUnavailable`.
- One doc comment replaces the three that restate decode's contract: Decoder's, Decoded's and EspnDecode's layer.
- `Decoder.layerTestDying(body)` replaces `TestDecoder.dyingAt`. `FramesDecoded` and the other helpers stay in
  `TestDecoder.ts`.
- `Archive.ts` moves from `corpus/` to `provider/`, so `provider/espn` no longer imports `corpus/`.

### The live slate

- **Live feed demand moves to Ingest.**
  - LiveSlate exposes `resyncs` as a stream.
  - Ingest builds `LiveFeedDemand` from `changes` and `resyncs`.
  - `currentGames`, `sameIds` and the provider import leave LiveSlate.
- **The layer reads as following, then the timer, then publication.**
  - Its helpers are `Effect.fn`s below it.
  - The stop-logging block uses `HubStopping.loggedUnlessStopping`. This makes it the second caller, so `HubStopping`
    keeps both functions.
- **`LiveSlateTelemetry` absorbs `DecodeTelemetry`** and exports three moments:
  - `told(following, frame, before, taken)`, which holds the replay-quiet rule and the state counts;
  - `wentLive(slate)`;
  - `timerDefect`.

  Every metric is private, and `takeDuration` is applied through `told`'s caller as a timed wrapper the module
  exports. `gaugeHeld` → `gaugeState`. Metric consts are named for what they measure.
- **No mirror.**
  - LiveMessage's `SlateChanged.slate` becomes `games`.
  - LiveSlate publishes the case's type, which replaces `Published`.
  - HubServer adds only the tag.
  - `SlateObservation.Started`/`Stopped` carry `after`, like `Changed` does, so `afterOf` goes.
  - HubServer's `sessions` → `stage`.
- `LiveStage` gets its doc comment and a typed `layer`.

### The server

`hub-server/` flattens to `HubServer.ts`, with `LanAddresses` folded in below its user and its tests moved into
`HubServer.test.ts`. The handler layers become `const`s, and the module exports `layer` (today's `serve`). Hand-written
SSE framing moves to `effect/encoding/Sse` if it covers the keep-alive comment; otherwise it stays.

### ESPN

- **`EspnPayload.ts`** holds ESPN's spellings under names that say what they are: `SiteEvent`, `FastCastEvent`,
  `Competitor`, `EspnSituation`, `PlayEntity`, `SummaryPlay`, `Summary`, `Scoreboard`.
  - `EspnEvent`, `EspnPlay` and `EspnSummary` keep only their transforms into domain types.
  - The `Raw`, `Play` and `Situation` collisions go.
  - Schema factories are PascalCase functions throughout: `Checkpoint(owner)` replaces `checkpointOf`.
- **`FastCastMessage.ts`** becomes pure wire.
  - `Owner`, `topic` and `owner` become `Owner` with statics `Owner.topic(league, game?)` and `Owner.of(topic)`, in
    `FastCastTopic.ts`.
- **One league-keyed decoder table** over `LeagueId.literals` replaces the `{nfl, fbs}` tables in EspnDecode (two) and
  EspnSummary, and the archive's ad-hoc decoder. There is one `decodeScoreboard`.
- **`EspnArchive.layer`** becomes a short layer over `Effect.fn` helpers below it.
- Every `FeedFrame` is built with `new FeedFrame`.
- **Duplicates collapse:**
  - `statusOf` is derived from `espnStatuses`.
  - `Key` and `TeamRef` become one.
  - `teamId` and its inverse sit together in EspnEvent.
  - `EventUndecoded.feed` and `Reset.reason` reuse their source types.
  - `EspnDecode.test` uses `FastCastMessage.Envelope`.

### The corpus and scenarios

- **`CorpusInput.ts` → `CorpusLine.ts`.**
  - `CorpusLine` gains the poll/push threading that `CorpusBuild`, `Synthesis` and `CorpusDays` each repeat.
  - `Had` is no longer exported.
- **A `GameDay` schema** (YYYY-MM-DD, with `bounds` and `dates`) replaces corpus.ts's private refinement and
  `CorpusDay.bounds`/`dates`, and types every `date` field.
- **`CorpusWorker.ts` merges into `CorpusRun.ts`.** `worker.ts` stays as the thread entry, and `DaysFailed` moves to
  `corpus.ts`.
- **`Scenarios`:**
  - `Scenarios.in(dir)` → `layerFrom(dir)`.
  - `Scenario.ts` folds into `Scenarios.ts`.
  - `HubMode.scripted` → `scenario`.
- **`ScenarioProvider`'s ESPN knowledge** (`"fastcast"`, the empty scoreboard) is named as ESPN's, beside the
  recordings it plays.
- `Source` gets its doc comment. `HubConfig.layerTest(env)` replaces `TestHubConfig.withEnv`.

### The snapshot feed

`TestSnapshotFeed` stays a test module: it is a test-only adapter of `Provider` and `Decoder`.
- Its layers are `layer(…)` (today's `provider` and `polled`, merged) and `layerDecoder`.
- Its poll reuses `framed`.
- `SnapshotPayload` gets its type.

## Out of the Hub

The convention is repo-wide once it is in AGENTS.md. Its few violations outside the Hub are fixed in this unit's last
task:
- the wire unions `Tile`, `StageCommand`, `StreamLocator` and `LiveMessage`, which become `Schema.TaggedUnion`;
- about five object `type` aliases;
- the desktop's four `function`s returning `Effect.gen`;
- service ids.

Nothing else outside the Hub moves.

## Sequencing

The unit runs in this order. Each step leaves `pnpm check` green, and each file is laid out to the code layout
standard as it is touched:

1. AGENTS.md and knip;
2. the removals;
3. the feed log;
4. the ports;
5. ESPN;
6. the live slate and the server;
7. the corpus and scenarios;
8. the other Hub files' spellings;
9. outside the Hub;
10. the events comparison.

The other session on this branch commits through its own subagents. This unit tells it before each commit series, so
the two never interleave.
