# Hub abstractions: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry out `docs/specs/2026-10-07-hub-abstractions-design.md`:
- the fold leaves the domain;
- one `Board` holds the slate;
- `Acknowledgement` replaces `LiveGame`;
- the Provider runs itself, as `{ frames, decode }`;
- `Frame` and `LoggedFrame` take the domain's words;
- `LiveStage` becomes `Switcher`;
- and the project is swept to Effect 4's idiom.

**Architecture:** The work happens on branch `hub-abstractions`, in a hand-made worktree at
`../sportal-hub-abstractions`. Tasks A0–A9 run in order. Every commit passes `pnpm check`. A task may take more than one
commit when it says so.

**Tech Stack:** Effect 4 (`effect`, `effect/sql`, `effect/schema` `Model`, `effect/socket`, `@effect/platform-node`),
Vitest with `@effect/vitest`, Biome, dependency-cruiser, knip, pnpm workspaces.

## Global constraints

- **Read first.** Before any task, read `AGENTS.md`, `CONTEXT.md` and the spec. Every line written follows AGENTS.md's
  spellings, and where they disagree with Effect 4's documented idiom, Effect wins.
- **Effect 4 is newer than training data.** Read `node_modules/effect/ai-docs/src/` (start at `index.md`) and
  `node_modules/effect/AGENTS.md` before writing Effect code, and never write Effect from memory. Examples to copy:
  - services and layers: `01_effect/03_services/01_service.ts`, `20_layer-composition.ts`;
  - `Effect.fn`: `01_effect/01_basics/02_effect-fn.ts`;
  - test layers: `09_testing/20_layer-tests.ts`;
  - streams: `Stream.mapAccum`, `Stream.scan`, `Stream.changesWith` and `Stream.debounce` in `effect/dist/Stream.d.ts`.
- **No bodies in this plan.** It gives signatures, state unions, behaviour, test names, and the existing code to follow.
- **The user's idiom rules apply to every line written.** These are not allowed:
  - state as booleans or flags; use a `Data.taggedEnum` with its transitions;
  - `_tag ===`, or `switch` over a union; use `match`, `$match` or `guards`;
  - conditional spreads; make the schema fit instead;
  - `node:` APIs where Effect has one;
  - hand-rolled loops over stream state, mutable `Map`s, `let`, or `throw`.
- **Behaviour is preserved,** except the one change the spec lists: FastCast follows ESPN's view of a game, and the
  poll cadence follows ESPN's last scoreboard. A test whose assertion changes for any other reason is a defect.
- **Metric ids, span names and log prefixes don't change,** so `telemetry/dashboards/live-games.json` keeps working.
  This includes the game-state gauge's label values `Upcoming | Live | Holding | Stale | Over`. A metric const may be
  renamed; its id string may not.
- **The testing standard** (AGENTS.md "Tests") applies to every test written or touched. A rewritten test keeps every
  assertion it had. The commit body lists, per test file, each old test name → the new test names that carry its
  assertions.
- **Glossary.** A new, renamed or deleted exported type name changes its `CONTEXT.md` row in the same commit.
- **Comments.** Doc comments go on major exports. Inline comments are only for a non-obvious why.
- **The real feed log is never migrated by a test or a check.** Migration 3 rewrites `feed_frame` irreversibly.
  - A0 copies `.sportal/feed.sqlite` into the ledger directory.
  - Every task that runs the Hub against a feed log uses a copy, or `SPORTAL_DATA_DIR` pointed at the scratchpad.
  - Never run `pnpm dev` in the worktree before A9.
- **Commands:**
  - `pnpm check`, before every commit;
  - `pnpm vitest run <path>` for one file;
  - `pnpm vitest run --project hub` / `--project domain`.

  Run one heavy check at a time, never two in parallel.
- **Commits:**
  - Conventional prefixes, as in `git log`.
  - Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Ledger:** `"$(git rev-parse --git-path sdd)/hub-abstractions.md"` in the worktree. Log progress, minor findings for
  the final review, and the sweep list there.

## File map

| File | Task | Change |
| --- | --- | --- |
| `apps/hub/src/Frame.ts` | A1 | `Frame` (from a provider) and `LoggedFrame` (with `seq`); `source`, `kind: whole \| change`, `number` |
| `feed-log/FeedFrameTable.ts`, `FeedLog.ts`, `FeedLogWriter.ts` | A1 | migration `3_frame_source`; queries by `source` and `kind` |
| `fixtures/scenarios/*.frames.jsonl.gz`, `fixtures/espn-recordings/**`, `provider/espn/fixtures/*.frames.jsonl.gz` | A1 | rewritten once to the new fields |
| `provider/espn/FastCast.ts`, `FastCastDocument.ts`, `EspnProvider.ts`, `EspnDecoder.ts`, `ScenarioProvider.ts`, `scenario/Scenarios.ts`, `TestSnapshotFeed.ts`, `corpus/TestCorpus.ts` | A1 | read and write the new fields |
| `packages/domain/src/{Slate,LiveGame,Delivery,SlateObservation}.ts` (+ tests) → `apps/hub/src/slate/` | A2 | moved, behaviour unchanged |
| `packages/domain/src/GameDay.ts` | A2 | `GameDay.dayStart` (was `Slate.dayStart`) |
| `slate/Acknowledgement.ts` (+ test) | A3 | new |
| `slate/Slate.ts`, `slate/SlateObservation.ts`, `LiveSlateTelemetry.ts`, `Ingest.ts`, `corpus/CorpusRun.ts` | A3 | games as snapshot + plays + acknowledgement |
| `slate/LiveGame.ts` (+ test) | A3 | deleted |
| `provider/espn/FastCast.ts` (+ test) | A4 | follows its own topics, resyncs and reconnects itself; `frames` |
| `provider/Provider.ts`, `provider/Decoder.ts` (deleted), `provider/TestDecoder.ts`, `provider/espn/{Espn,EspnProvider,ScenarioProvider,EspnDecoder}.ts`, `Ingest.ts`, `HubMode.ts`, `TestSnapshotFeed.ts`, `corpus/{corpus,CorpusBuild}.ts` | A5 | `Provider = { frames, decode }` |
| `feed-log/FeedLog.ts` | A6 | `follow(from)` |
| `slate/Board.ts`, `slate/BoardTelemetry.ts` (was `LiveSlateTelemetry.ts`), `TestBoard.ts` (was `TestLiveSlate.ts`) | A6 | new holder; telemetry as a service the board tells |
| `LiveSlate.ts`, `Following.ts` (+ tests) | A6 | deleted |
| `HubServer.ts`, `HubMode.ts`, `main.ts` | A6 | events and `SlateChanged` derived from `Board` |
| `Switcher.ts` (was `LiveStage.ts`) | A7 | renamed |
| `CONTEXT.md`, `AGENTS.md`, `docs/technical-spec.md` | A1–A7, A7 | rows changed with their code; prose in A7 |
| the whole project | A8 | Effect idiom sweep |

## A0: Worktree and baselines

**Steps:**
- [ ] In `../sportal`, run `git switch main`. Then run `git worktree add ../sportal-hub-abstractions hub-abstractions`,
  and `pnpm install` in the new worktree.
- [ ] Create the ledger, `"$(git rev-parse --git-path sdd)/hub-abstractions.md"`, with `BASE=<HEAD sha>`.
- [ ] Copy the baseline into `"$(git rev-parse --git-path sdd)/baseline/"`:
  - `../sportal/.git/worktrees/sportal-readability/sdd/baseline/corpus-before/` (one captured day, 2026-10-06);
  - `dump-events.ts`, with its `hub` const pointing at this worktree's `apps/hub`;
  - `../sportal/.sportal/feed.sqlite`, as `feed-before.sqlite`.
- [ ] From `apps/hub`, run `node <baseline>/dump-events.ts <baseline>/corpus-before > <baseline>/events-before.jsonl`.
  Record the event count; 118 is expected.
- [ ] Rebuild the day from `feed-before.sqlite` with the current code, and dump its events as `events-rebuilt-before.jsonl`.
  A1 and A5 need this to show that a rebuild from the migrated log gives the same events. Do it on a copy of the
  feed log, with `SPORTAL_DATA_DIR` and `SPORTAL_CORPUS_DIR` pointed into the baseline directory, then
  `pnpm --filter @sportal/hub corpus build --date 2026-10-06` (see `corpus/corpus.ts` for the exact flags).
- [ ] `pnpm check` passes on the base. Note the test count in the ledger.

## A1: Frame takes the domain's words

**Files:**
- `apps/hub/src/Frame.ts`.
- `feed-log/FeedFrameTable.ts`, `feed-log/FeedLog.ts`, `feed-log/FeedLogWriter.ts`, and their tests.
- Every producer and reader of frames:
  - `provider/espn/FastCast.ts`, `FastCastDocument.ts`, `EspnProvider.ts`, `EspnDecoder.ts`, `ScenarioProvider.ts`;
  - `scenario/Scenarios.ts`, `TestSnapshotFeed.ts`, `corpus/TestCorpus.ts`;
  - `provider/Provider.ts`, `provider/Decoder.ts`, `provider/TestDecoder.ts`;
  - their tests.
- Recordings: `fixtures/scenarios/*.frames.jsonl.gz`, `fixtures/espn-recordings/**`, and
  `provider/espn/fixtures/{a-drive,two-minute-drill-tie,nfl-2026-10-04-ne-buf}.frames.jsonl.gz`.
- `CONTEXT.md`: **Frame**, **Delivery source**, **Feed frame row**, and a new **Logged frame**.

**Interfaces:**
```ts
/** One thing a provider delivered, as received, before the log numbers it. */
export class Frame extends Schema.Class<Frame>("sportal/hub/Frame")({
  receivedAt: Schema.DateTimeUtcFromMillis,
  sentAt: Schema.optional(Schema.DateTimeUtcFromMillis),
  source: DeliverySource,
  channel: Schema.String,
  kind: Schema.Literals(["whole", "change"]),
  number: Schema.optional(Schema.Int),
  body: Schema.String
}) {}

/** A frame as the feed log numbered it. */
export class LoggedFrame extends Frame.extend<LoggedFrame>("sportal/hub/LoggedFrame")({ seq: Schema.Int }) {}
```
- **`DeliverySource`** is still imported from `@sportal/domain/Delivery` in A1; A2 moves it.
- **`Frame.isPollResponse` is deleted.** Its two callers (`FeedLog.ts:180`, `FeedLogWriter.ts:87`) test
  `frame.source === "poll"`, since every poll frame is `whole`.
- **`FeedLog.append(frame: Frame): Effect<LoggedFrame>`.** `subscribe` and `replay` yield `LoggedFrame`.
- **The `feed_frame` row** has `source TEXT CHECK (source IN ('push','poll'))` in place of `feed`, and
  `kind CHECK (kind IN ('whole','change','unchanged','gap'))`. `source_id` is renamed `number`. The gap check becomes
  `(kind = 'gap') = (source IS NULL AND channel IS NULL)`.
- **Migration `3_frame_source`,** in `FeedFrameTable.ts` beside `2_allow_snapshot_feed`. It rebuilds the table the way
  migration 2 does:
  - `fastcast` and `snapshot` become `push`, and `poll` stays `poll`;
  - `response` and `checkpoint` become `whole`, `message` becomes `change`, and `unchanged` and `gap` stay.
- **Queries:**
  - the last poll body per channel: `WHERE source = 'poll' AND kind IN ('whole','unchanged')`;
  - the last whole per channel: `WHERE kind = 'whole' AND source = 'push'` (today's checkpoint query, `:121`);
  - the body lookup at `:137`: `kind = 'whole'`.
- **The `framesWritten` metric** keeps its id. Its attributes become `{ source, kind }`. Check the dashboard
  (`telemetry/dashboards/*.json`) for a query on `feed`, and update the query in the same commit.
- **FastCast:** a socket message is `{ source: "push", kind: "change", number: envelope.mid }`, and a loaded checkpoint
  is `{ source: "push", kind: "whole" }`.
- **`FastCastDocument.advance`** branches on `kind`, using `whole` and `change`, with `match` rather than `===`.
- **`ScenarioProvider`'s `pushFeed`** const becomes a `source === "push"` filter.

**Recordings rewrite:**
- [ ] Write a throwaway script in the scratchpad, not the repo. It reads each `*.frames.jsonl.gz` line as JSON and maps:
  - `feed` → `source`: `fastcast` and `snapshot` become `push`;
  - `kind`: `response` and `checkpoint` become `whole`, `message` becomes `change`;
  - `sourceId` → `number`.

  It writes gzip back, using Effect's `FileSystem` and `Gzip.ts`, and runs over every file listed under "Files".
  Check that `zcat <file> | head -c 300` shows the new fields, and that the line count of each file is unchanged.

**Tests:**
- `FeedFrameTable.test.ts`:
  - New: `it("should migrate a version-2 table's feed and kind to source and kind")`. It seeds rows under migration 2
    with each old value, runs the migrations, and reads every row back.
  - New: `it("should keep a gap row a gap through the migration")`.
- `FeedLog.test.ts`:
  - Every test that builds a frame uses the new fields, with the same assertions.
  - `it("should store a repeated poll response without its body")` keeps its assertion, with `source: "poll"`.
- `FastCast.test.ts`: the frames asserted carry `source: "push"`, with `kind` `change` or `whole`, and `number`.
- `EspnDecoder.test.ts`, `ScenarioProvider.test.ts`, `Scenarios.test.ts`, `TestSnapshotFeed.test.ts`: fixtures and
  builders are updated, with no assertion changed.

**Steps:**
- [ ] Write the two migration tests, run them, and see them fail.
- [ ] Change `Frame.ts`, then the table, the migration, the queries and the writer. The tests pass.
- [ ] Change every producer and reader; `pnpm vitest run --project hub`.
- [ ] Rewrite the recordings. `pnpm vitest run --project hub` still passes.
- [ ] On a copy of `feed-before.sqlite`, rebuild 2026-10-06 and dump the events. The result must equal
  `events-rebuilt-before.jsonl` exactly (`diff`). Record this in the ledger.
- [ ] `rg -n '\bFeedFrame\b|"fastcast"|"response"|"checkpoint"|"message"|sourceId|isPollResponse' apps/hub/src` finds
  only FastCast's wire op names in `FastCastMessage.ts`, if any.
- [ ] `pnpm check`. Commit `refactor(hub): Frame and LoggedFrame, in the domain's words`.

## A2: The fold moves into the Hub

**Files:**
- Move each of these from `packages/domain/src/` to `apps/hub/src/slate/` with `git mv`, so history follows:
  - `Slate.ts`, `Slate.test.ts`;
  - `LiveGame.ts`, `LiveGame.test.ts`;
  - `Delivery.ts`, `Delivery.test.ts`;
  - `SlateObservation.ts`.
- Any domain `Test*.ts` used only by those tests moves with them; `TestGame.ts` stays if web or domain tests use it.
- `packages/domain/src/GameDay.ts` and `GameDay.test.ts`.
- Every importer, as listed by
  `rg -l 'domain/(Slate|LiveGame|Delivery|SlateObservation)"' apps packages`.
- `.dependency-cruiser.cjs`, if it names these paths.
- `CONTEXT.md`: **Slate**, **Live game**, **Delivery**, **Slate observation**, **Game day**. Each row now says where
  the type lives.

**Interfaces:**
- `GameDay.dayStart(now: DateTime.Zoned): DateTime.Utc`, the same function, moved off `Slate`. `GameDay` stops
  importing `Slate`.
- Imports inside the moved files become relative (`./Delivery.ts`). Domain imports become `@sportal/domain/Game` and
  so on.
- Service and class ids don't change in A2, apart from the `Schema.Class` identifier strings the moved schemas carry.
  Leave those as they are unless a test pins them.

**Tests:** the moved tests run unchanged under the hub project. `GameDay.test.ts` gains the `dayStart` tests that were
in `Slate.test.ts`, moved with their assertions.

**Steps:**
- [ ] `git mv` the files, fix the imports, and move `dayStart`.
- [ ] Check that `rg -n 'Slate|LiveGame|Delivery|SlateObservation' packages/domain/src` finds nothing but prose that
  needs no change.
- [ ] `pnpm check`. The test count is unchanged. Commit `refactor: the slate's fold moves into the Hub`.

## A3: Acknowledgement replaces LiveGame (test-first)

**Files:**
- New: `slate/Acknowledgement.ts`, `slate/Acknowledgement.test.ts`.
- `slate/Slate.ts`, `slate/Slate.test.ts`, `slate/SlateObservation.ts`.
- `LiveSlateTelemetry.ts` and its test.
- `Ingest.ts` (`currentGames`), `LiveSlate.ts` (`slate.live.size` in the summary), `corpus/CorpusRun.ts`, and any other
  reader of `slate.live`. List them with `rg -n '\.live\b|LiveGame' apps/hub/src`.
- Delete `slate/LiveGame.ts` and `slate/LiveGame.test.ts`.
- `CONTEXT.md`:
  - delete **Live game**, **Covered** and **Took outcome** if they are no longer exported;
  - add **Acknowledgement**;
  - change **Slate**, **Stale**, **Slate observation**.

**Interfaces:**
```ts
/**
 * The Hub's acknowledgement of a game's latest word: which feed gave the snapshot the slate shows, when, and a poll held
 * back while the push covers the game. Never on the wire.
 */
export class Acknowledgement extends Data.Class<{
  readonly from: DeliverySource
  readonly heardAt: DateTime.Utc
  readonly held: Option.Option<{ readonly snapshot: GameSnapshot; readonly until: DateTime.Utc }>
}> {
  static readonly staleAfter: Duration.Duration       // 90 s
  static readonly currentBefore: Duration.Duration    // 30 min
  static readonly staleCurrentFor: Duration.Duration  // 30 min
  static readonly fallbackAfter: Duration.Duration    // 15 s
  static earliest(instants: Iterable<Option.Option<DateTime.Utc>>): Option.Option<DateTime.Utc>
}
```

The rules over a snapshot and its acknowledgement come next. Each is a method on `Acknowledgement` taking the game's
`snapshot` and `now`, or a static where no acknowledgement exists yet. They replace `LiveGame`'s rules one for one:

| `LiveGame` today | After |
|---|---|
| `LiveGame.start(snapshot, from, now)` | `Acknowledgement.first(from: DeliverySource, now): Acknowledgement` |
| `take(Snapshot)` → `{ liveGame, events, outcome }` | `acknowledgement.took(game: GameSnapshot, delivery: { snapshot; from }, now)` → `{ next: Option<{ snapshot: GameSnapshot; acknowledgement: Acknowledgement }>; events: ReadonlyArray<GameEventKind>; outcome: TookOutcome }` |
| `take(Plays)` | `Slate`'s own (plays are not acknowledged): `Play.eventsSince` over the sorted plays, unchanged |
| `tick(now)` → `{ liveGame, events, fellBack }` | `acknowledgement.ticked(game, now)` → `{ next: Option<{ snapshot; acknowledgement }>; events; fellBack: boolean }`. Only a fall back changes anything: going stale is derived, not stored |
| `isCovered()` | `acknowledgement.covers(game: GameSnapshot): boolean` |
| `dueAfter(now)` | `acknowledgement.dueAfter(game, now): Option<DateTime.Utc>` |
| `updatedAt()` | `heardAt` while the game is live; none while upcoming or over |
| `isCurrent(now)` | `acknowledgement.isCurrent(game, now): boolean` |
| `state` (stored) | `acknowledgement.state(game, now): "Upcoming" \| "Live" \| "Holding" \| "Stale" \| "Over"`. It is derived, for telemetry and the stale check, and is not stored. Its values are the gauge's labels |

- **`fellBack` stays a boolean.** It is a report, not state. If the sweep wants it gone, it becomes an `outcome` of
  `"fellBack"` on the same return shape as `took`.
- **A dueAfter subtlety.** Today a `Live` game's due time is `updatedAt + staleAfter`, and a tick at that time
  changes its state to `Stale`. Now that tick changes nothing stored. So that the timer does not spin, `dueAfter`
  must return the *next* deadline strictly after `now`: `heardAt` + 90 s, then `heardAt` + 30 min. `earliestDue`
  must still wake at the stale instant, so that telemetry sees the change and `changes` emits. Telemetry is told by
  comparing `state(game, before)` with `state(game, at)`.
- **`Slate`** holds:
  ```ts
  readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly games: ReadonlyMap<GameId, GameSnapshot>              // each current game, as the slate has it (was live[id].snapshot)
  readonly plays: ReadonlyMap<GameId, ReadonlyArray<Play>>       // in Play.order (was live[id].plays)
  readonly acknowledged: ReadonlyMap<GameId, Acknowledgement>    // same keys as games
  readonly finished: ReadonlyMap<GameId, GameSnapshot>
  readonly seq: Option.Option<number>                            // until A6
  readonly reached: Option.Option<DateTime.Utc>
  ```
  - **The key invariant is private to `Slate`'s `Advancing`.** `hold(id, snapshot, acknowledgement)` and `release(id)`
    write the maps together, and nothing else writes them.
  - **A game's plays leave with it,** as they do today with its `LiveGame`: `release` deletes its entry from all three
    maps.
- **`SlateObservation`'s** `Started`, `Changed` and `Stopped` carry `{ snapshot, acknowledgement }` before and after,
  in place of `LiveGame`. Its `Took` keeps `outcome: TookOutcome | "fellBack"`. `TookOutcome` moves here.
- **Telemetry** reads `acknowledgement.state(snapshot, at)` wherever it read `liveGame.state._tag`. The label values
  must not change.

**Tests:**
- **`Acknowledgement.test.ts`** receives every behaviour test in `LiveGame.test.ts` (95 tests), rewritten against the
  new shape with each assertion kept. Group them by member:
  - `describe("Acknowledgement.took")`
  - `describe("Acknowledgement.ticked")`
  - `describe("Acknowledgement.dueAfter")`
  - `describe("Acknowledgement.isCurrent")`
  - `describe("Acknowledgement.state")`
  - `describe("Acknowledgement.covers")`

  Plays tests move to `Slate.test.ts`. Tests of a stored `Stale` transition become `state` tests at the same instants.
- **`Slate.test.ts`** keeps its 43 tests, with each assertion on `slate.live` read through `games`, `plays` and
  `acknowledged`.
- **New tests:**
  - `it("should not change the slate when a live game's stale instant passes")`
  - `it("should report the game Stale from that instant")`
  - `it("should wake at the stale instant and then at the end of the current window")`
- **`LiveSlateTelemetry.test.ts`:** the label assertions are unchanged.

**Steps:**
- [ ] Write `Acknowledgement.test.ts` from `LiveGame.test.ts`, with the commit-body map from old to new test names, and
  see it fail.
- [ ] Implement `Acknowledgement`. Its tests pass.
- [ ] Reshape `Slate` and `SlateObservation`, and update the readers. Delete `LiveGame`.
- [ ] Run the corpus events comparison: dump `<baseline>/corpus-before` with this code and `diff` it against
  `events-before.jsonl`. It must show no difference.
- [ ] `pnpm check`. Commit `refactor(hub): Acknowledgement replaces LiveGame; the game is its snapshot and plays`. The
  body carries the test-name map.

## A4: FastCast runs itself

**Files:** `provider/espn/FastCast.ts`, `FastCast.test.ts`, `FastCastDocument.ts`, `EspnProvider.ts` (adapts in this
task only), `CONTEXT.md` (**FastCast**, **Checkpoint unread**).

**Interfaces:**
```ts
export class FastCast extends Context.Service<FastCast, {
  /**
   * Every socket text and checkpoint, as frames, for as long as it runs. It follows each league's scoreboard topic.
   * It follows a game's topic while that scoreboard shows the game live or within 30 minutes of kickoff, and leaves it
   * at final. When a topic's document resets (`Gap`, `Unapplicable`), it reads the checkpoint again. When the socket
   * closes, ends or goes silent, it reconnects on its backoff. Never fails.
   */
  readonly frames: Stream.Stream<Frame>
}>()("sportal/hub/FastCast") {
  static readonly make: (retry: {
    readonly checkpoint: Schedule.Schedule<unknown, CheckpointUnread>
    readonly reconnect: Schedule.Schedule<unknown, ProviderUnavailable>
  }) => Effect.Effect<FastCast["Service"], never, HttpClient.HttpClient | Socket.WebSocketConstructor | HubConfig>
  static readonly layer: Layer.Layer<FastCast, never, HttpClient.HttpClient | Socket.WebSocketConstructor | HubConfig>
}
```
- **What it follows comes from its own documents.** `connect` keeps the `FastCastDocument` state (`advance`, which is
  pure) over the frames it emits, in a `Stream.mapAccum`. From the scoreboard documents it derives the wanted game set:
  - each game live, or upcoming within 30 minutes of kickoff;
  - the time check uses `DateTime.now`, read when each frame is received.

  A change of the set subscribes to or leaves game topics. This replaces `wanted` and `LiveFeedDemand.Games`.
- **A reset in `advance`'s observations** (`DecodeObservation.Reset`, or the reset that `FastCastDocument` returns)
  enqueues that topic's checkpoint follow. This replaces `resync` and `LiveFeedDemand.Resync`.
- **Reconnect moves inside `frames`.** It is `Stream.retry(reconnect)` over `connect`, with today's
  `EspnProvider.reconnect` backoff moved here: exponential from 1 s, jittered, capped at a minute. Each failure is
  logged at Warning with the prefix `Ingest: the live feed failed (<reason>); subscribing again`, unchanged so log
  queries keep working. It updates `sportal_live_feed_errors` with `{ reason }`.
- **`frames` never fails.** If it would end, it logs `Ingest: the live feed stopped; …` and stays quiet. That is the
  behaviour of `HubStopping.loggedUnlessStopping` today.
- **`EspnProvider.push` adapts in this task** to `() => fastCast.frames`, ignoring the demand, and `reconnect` to
  `Schedule.recurs(0)`. A5 removes both.

**Tests (`FastCast.test.ts`):**
- The existing tests that drive `demand` become tests that drive scoreboard frames. Each keeps its assertions on what
  is subscribed to:
  - `it("should follow a game's topic once its scoreboard shows it live")`
  - `it("should follow a game's topic from 30 minutes before kickoff")`
  - `it("should leave a game's topic when its scoreboard shows it final")`
  - `it("should read a topic's checkpoint again after a gap")`
  - `it("should read a topic's checkpoint again after a message that will not apply")`
  - `it("should reconnect after the socket closes")`
  - `it("should count a failed live feed by its reason")`
  - `it("should keep running when the socket goes silent")`
- Use the recorded `nfl-fastcast-*` fixtures and the test socket that `FastCast.test.ts` already builds.

**Steps:**
- [ ] Rewrite the tests and see them fail. Implement. `pnpm vitest run apps/hub/src/provider/espn`.
- [ ] `pnpm check`. Commit `refactor(espn): FastCast follows its own topics, resyncs and reconnects`.

## A5: Provider is `{ frames, decode }`

**Files:**
- `provider/Provider.ts`.
- Delete `provider/Decoder.ts`; `Decoded` and `DecodeObservation` move into `Provider.ts`.
- `provider/TestDecoder.ts` becomes `provider/TestProvider.ts`, if it still builds anything; otherwise it is deleted.
- `provider/espn/Espn.ts`, `EspnProvider.ts`, `EspnDecoder.ts`, `ScenarioProvider.ts`, and their tests.
- `Ingest.ts`, `Ingest.test.ts`.
- `HubMode.ts`, `TestSnapshotFeed.ts`, `LiveSlate.ts` (`yield* Provider` in place of `Decoder`).
- `corpus/corpus.ts`, `corpus/CorpusBuild.ts`.
- `CONTEXT.md`:
  - change **Provider**, **Decoded**, **Ingesting**, **Provider unavailable**;
  - delete **Decoder**, **Live feed demand**, **Polling**, **Live feed** (it is FastCast's own word now; keep it if
    `FastCast.ts` still uses it in prose).

**Interfaces:**
```ts
export class Provider extends Context.Service<Provider, {
  readonly frames: Stream.Stream<Frame>
  decode(frames: Stream.Stream<LoggedFrame>): Stream.Stream<Decoded>
}>()("sportal/hub/provider/Provider") {}

export class Decoded extends Data.Class<{
  readonly seq: number
  readonly at: DateTime.Utc
  readonly deliveries: ReadonlyArray<Delivery>
  readonly observations: ReadonlyArray<DecodeObservation>
}> { static of(…); static undecodable(…) }   // as today, less `resyncs`
```
- **Deleted:** `LiveFeed`, `LiveFeedDemand`, `Polling`, `Decoder`, `Decoded.resyncs`, `LiveSlate.resyncs`, and Ingest's
  `demandOf`, `currentGames` and `sameIds`.
- **`ProviderUnavailable` moves to `provider/espn/ProviderUnavailable.ts`,** a class module of its own. Both
  `EspnProvider.ts` and `FastCast.ts` raise it, and `EspnProvider` imports `FastCast`, so neither can own it without
  a cycle.
- **`EspnProvider.layer: Layer<Provider, never, FastCast | HttpClient.HttpClient | HubConfig>`:**
  - `frames` merges the poll loop and `fastCast.frames`.
  - The poll loop polls each league, then sleeps for `interval(games, now, anyFailed)`. `games` comes from decoding
    the scoreboards it just fetched with `byLeague[league].decodeScoreboard` and `EspnEvent`, from `EspnDecoder.ts`.
    Export what's needed from there; do not duplicate it.
  - Each failed league is logged and counted as Ingest does now: the warning prefix `Ingest: provider failed; …` and
    `sportal_provider_errors {league}`. The span `Ingest.poll` and the `sportal_poll_duration` timer stay, so the
    dashboards hold.
  - `decode` is `EspnDecoder`'s.
- **`Espn.layer`, `layerScenario` and `layerArchival`** each provide `Provider` (plus `Archiver` for archival).
  `layerArchival` requires `Socket.WebSocketConstructor`, and `corpus/corpus.ts` provides
  `NodeSocket.layerWebSocketConstructorWS`.
- **`ScenarioProvider.layer: Layer<Provider, ScenarioUnknown | ScenarioUnreadable, HubConfig | Scenarios>`:**
  - `frames` plays every recorded frame, poll and push, in `receivedAt` order. Each is moved to `start + offset`, slept
    to on the clock, and then concatenated with `Stream.never`.
  - `decode` is `EspnDecoder`'s.
  - Deleted: `pollingAt`, `longest`, `noEvents`, and the per-league current-poll lookup.
- **`TestSnapshotFeed`:** its provider's `frames` is the stream it is given, and its `decode` is the snapshot decode.
- **`Ingest.layer: Layer<never, never, Provider | FeedLog>`** forks
  `provider.frames.pipe(Stream.runForEach(feedLog.append))`, wrapped in `HubStopping.loggedUnlessStopping`. It no
  longer reads `HubConfig` or the slate.

**Tests:**
- **`Ingest.test.ts`:** the 28 tests split three ways.
  - Polling cadence moves to `EspnProvider.test.ts`, under `describe("EspnProvider.frames")`, keeping its assertions on
    delays:
    - `it("should poll every 10 seconds while a game is live")`
    - `it("should poll every minute within 30 minutes of a kickoff")`
    - `it("should poll every 15 minutes otherwise")`
    - `it("should poll again within 30 seconds after a league fails")`
    - `it("should log and count a league that fails")`
  - Demand tests are deleted, since their behaviour moved to A4's tests. The commit body names each one.
  - What remains is `it("should append every frame the provider delivers to the feed log")` and
    `it("should log when the provider's frames stop")`.
- **`ScenarioProvider.test.ts`:** tests of the emulated poll schedule become
  `it("should play each recorded frame at its offset")`, `it("should play polls and pushes in their recorded order")`
  and `it("should play at the scenario's speed")`. They keep the assertions on which body is delivered when. Tests of
  behaviour that no longer exists are deleted and named in the commit body.
- **`EspnDecoder.test.ts`:** resync assertions become assertions that a `Reset` observation is present.
- **`CorpusBuild.test.ts`:** it uses `Provider` in place of `Decoder`, with no assertion changed.

**Steps:**
- [ ] Move the tests and see them fail. Change the port and the adapters, then Ingest, then HubMode and the corpus.
- [ ] Check that `rg -n 'Decoder\b|LiveFeedDemand|Polling\b|resyncs|demandOf|currentGames' apps/hub/src` finds
  nothing, apart from `EspnDecoder` as a module name.
- [ ] Run the rebuild check from A1 again: a rebuild of 2026-10-06 from the copied feed log gives
  `events-rebuilt-before.jsonl` exactly.
- [ ] `pnpm check`. Commit `refactor(hub): the provider runs itself; Provider is frames and decode`.

## A6: Board holds the slate

**Files:**
- `feed-log/FeedLog.ts` and its test.
- New: `slate/Board.ts`, `slate/Board.test.ts`.
- `LiveSlateTelemetry.ts` becomes `slate/BoardTelemetry.ts`, with its test.
- `TestLiveSlate.ts` becomes `TestBoard.ts`.
- `HubServer.ts`, `HubMode.ts`, `main.ts`, `LiveStage.ts`, and their tests.
- `slate/Slate.ts`: `seq` is dropped.
- Delete `LiveSlate.ts`, `LiveSlate.test.ts` and `Following.ts`.
- `CONTEXT.md`:
  - delete **Live slate**, **Following**;
  - add **Board**;
  - change **Slate changed**, **Taken**, **Corpus run** (if it names LiveSlate).

**Interfaces:**
```ts
// FeedLog
/**
 * Subscribes, then reads where the log stands. The frames from `from` up to `last` are logged already, and each frame
 * after `last` follows as it is appended. `last` is none when nothing at or after `from` is logged.
 */
follow(from: DateTime.Utc): Effect.Effect<
  { readonly last: Option.Option<number>; readonly frames: Stream.Stream<LoggedFrame> },
  never,
  Scope.Scope
>
```
- **`FeedLog.follow`** is built from today's `subscribe` and `replay`, run in the order `LiveSlate.ts:157-173` does:
  subscribe first, then read `last` (`MAX(seq)` at or after `from`). Then it concatenates `replay(from)` up to `last`
  with the subscription filtered to `seq > last`.
- **`replay`** stays for `CorpusBuild`. `subscribe` leaves the interface if `follow` is its only user.

```ts
/** The one holder of the day's slate: it keeps it current from the feed log and the clock. */
export class Board extends Context.Service<Board, {
  readonly latest: Effect.Effect<Slate>
  /** The latest first, then each change; `reached` alone moving is not a change. */
  readonly changes: Stream.Stream<Slate>
  /** Every take and tick, in order, each marked replayed or not. */
  readonly taken: Stream.Stream<{ readonly taken: Taken; readonly replayed: boolean }>
}>()("sportal/hub/slate/Board") {
  static readonly layer: Layer.Layer<Board, never, FeedLog | Provider | DateTime.CurrentTimeZone>
  static layerTest(slate: Slate): Layer.Layer<Board>   // a still board, for the server and switcher tests
}
```
- **`Board.layer`** has three phases, separated by blank lines.
  - **Following:**
    1. `follow(GameDay.dayStart(now))`, then `provider.decode(frames)`, then `Stream.runForEach`.
    2. Each `decoded` is taken with `SubscriptionRef.modifyEffect`. The step is uninterruptible, as today's `step` is.
    3. The `Taken` is published to the `taken` PubSub as `{ taken, replayed: Option.exists(last, (l) => decoded.seq <= l) }`.
    4. Once `decoded.seq` reaches `last`, or at once when `last` is none, it completes the build's `Deferred`.
  - **The build:** `Effect.raceFirst(Deferred.await(caughtUp), Fiber.join(following) then never)`, as `LiveSlate.replay`
    is today. The span name `LiveSlate.replay` is kept.
  - **The timer:** as today's `wake`, started after the build, ticking through the same modify. It is published as
    `replayed: false`. Its defect is logged with today's message and counted, then it backs off for 1 s.
  - **The stop:** when the following ends other than by the Hub stopping, it logs today's `LiveSlate: frames are no
    longer taken…` message. The timer keeps running.
  - **Its only state** is one `SubscriptionRef<Slate>`, a `PubSub` and one `Deferred`. There is no `Following`,
    `readTo`, `replayRead`, `replayed` or `publication`.
- **`BoardTelemetry` is a service that `Board.layer` yields.** This deviates from the spec's "a subscriber of
  `taken`", for a reason: a subscriber layer could miss the replayed takes, which happen during the board's build,
  before anything outside could subscribe. A service the board calls is told every take, in order, by construction,
  and it still lives in its own module and owns every metric.
  ```ts
  export class BoardTelemetry extends Context.Service<BoardTelemetry, {
    /** What one take or tick did, told as its item says: quiet in replay, loud after. `before` is the slate it started from. */
    told(item: { readonly taken: Taken; readonly replayed: boolean }, frame: Option.Option<Decoded>, before: Slate): Effect.Effect<void>
    /** The boundary out of the replay: the state gauges, and the summary log with today's text. */
    wentLive(slate: Slate, replayed: { readonly frames: number; readonly deliveries: number; readonly plays: number }): Effect.Effect<void>
    timerDefect(defect: unknown): Effect.Effect<void>
    timedTake<A, E, R>(take: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
  }>()("sportal/hub/slate/BoardTelemetry") {
    static readonly layer: Layer.Layer<BoardTelemetry>
    static readonly layerTest: Layer.Layer<BoardTelemetry>   // tells nothing
  }
  ```
  - The replay counts for `wentLive` are a `Stream.mapAccum` over the replayed part of the following stream, inside
    `Board.layer`. They are not a ref.
  - `Board.layer`'s requirements gain `BoardTelemetry`.
- **`HubServer`:**
  - Game events: `board.taken.pipe(Stream.filter(({ replayed }) => !replayed), Stream.flatMap(({ taken }) => Stream.fromIterable(taken.events)))`,
    where the server needs them.
  - Published games: `board.changes.pipe(Stream.debounce("250 millis"), Stream.map((slate) => slate.published()))`.
    `published` is a new method, `Slate#published(): SlateChanged`, built from `games(LeagueId.literals)` and
    `recentPlays`.
- **`LiveStage`** reads `(yield* board.latest).published().games` in place of `slate.published`.
- **`Slate.seq` is dropped,** and `CorpusRun` no longer reads it.
- **`HubMode`** wires `Ingest.layer`, `Board.layer`, `BoardTelemetry.layer` and `FeedLog`, as it wires `LiveSlate` today.

**Tests:**
- **`LiveSlate.test.ts`'s 79 tests:**
  - The replay, timer, through-the-board and halting tests move to `Board.test.ts`, keeping their assertions.
  - Tests of `through` or `resyncs` are deleted, and named in the commit body, since their behaviour left in A4/A5.
  - Publication tests move to `HubServer.test.ts` or `Slate.test.ts` (`published()`).
- **New, in `Board.test.ts`:**
  - `it("should be built at once over an empty log")`
  - `it("should be built only once the frames logged before it are taken")`
  - `it("should mark the frames logged before it as replayed")`
  - `it("should fail its build when decode dies during the replay")`
  - `it("should keep ticking after decode dies once it is built")`
  - `it("should not emit a change for a tick that changes nothing")`
  - `it("should tell telemetry every replayed take")`, the ordering test
- **New, in `FeedLog.test.ts`:**
  - `it("should deliver a frame appended while following begins exactly once")`
  - `it("should report no last frame for a day with nothing logged")`
- **`LiveSlateTelemetry.test.ts`** becomes `BoardTelemetry.test.ts`, with the same assertions, driven by `taken` items.

**Steps:**
- [ ] `FeedLog.follow` test-first, then commit `feat(feed-log): follow(from)`.
- [ ] Move the tests to their new homes and see them fail. Build `Board` and `BoardTelemetry`, and rewire.
- [ ] Delete `LiveSlate.ts` and `Following.ts`. Check that `rg -n 'LiveSlate|Following\b|through\(' apps/hub/src`
  finds nothing.
- [ ] Run the corpus events comparison again; there must be no difference.
- [ ] `pnpm check`. Commit `refactor(hub): Board holds the slate; telemetry and publication subscribe`.

## A7: Switcher, and the docs

**Files:**
- `LiveStage.ts` becomes `Switcher.ts`, and `LiveStage.test.ts` becomes `Switcher.test.ts`.
- `HubServer.ts`, `main.ts`, and their tests.
- `CONTEXT.md`, `AGENTS.md`, `docs/technical-spec.md`.

**Interfaces:**
- `export class Switcher extends Context.Service<Switcher, { readonly stage; readonly changes; dispatch }>()("sportal/hub/Switcher")`,
  with its members unchanged. The span becomes `Switcher.dispatch`; check the dashboards for `LiveStage.dispatch` and
  update any query in the same commit.

**Docs:**
- **`CONTEXT.md`:**
  - **Live stage** becomes **Switcher**.
  - Under Planned, **Director** becomes **Producer**, with one line: "the Producer switches the Slate of games on the
    Board".
  - Re-read every row this unit touched, as one pass.
- **`AGENTS.md`:**
  - the service-id example `"sportal/hub/LiveSlate"` becomes `"sportal/hub/slate/Board"`;
  - the "only these files name concrete providers" rule is checked against the new files;
  - the "Polling, LiveFeed" example of named port member types is replaced with one that exists.
- **`docs/technical-spec.md`:** each section describing LiveSlate, LiveGame, the Provider/Decoder ports, Ingest or
  LiveStage is rewritten to the new design.

**Steps:**
- [ ] `git mv`, rename, update the docs.
- [ ] Check that `rg -n 'LiveStage|LiveSlate|LiveGame|Decoder\b|LiveFeedDemand' --glob '!docs/specs/**' --glob '!docs/plans/**' .`
  finds nothing outside `node_modules`.
- [ ] `pnpm check`. Commit `refactor(hub): LiveStage is the Switcher; docs follow the new design`.

## A8: Effect idiom sweep

**Scope:** `apps/hub/src`, `packages/domain/src`, `packages/api/src`, then `apps/web/src` and `apps/desktop/src`
outside React/Electron framework edges.

**Steps:**
- [ ] List the candidates into the ledger's sweep list, one line each, `file:line — pattern — fix or keep (why)`. Use:
  - `rg -n '_tag [!=]==' -g '*.ts' -g '*.tsx'`
  - `rg -n 'switch \(' -g '*.ts' -g '*.tsx'`
  - `rg -n '\.\.\.\(.* \? \{\} : ' -g '*.ts'`, the conditional spreads
  - `rg -n ' as [A-Z(]' -g '*.ts' -g '!*.test.ts'`, the casts; keep only those in decoding
  - `rg -n 'instanceof|\blet |\bthrow |for \(|while \(' -g '*.ts' -g '!*.test.ts'`
  - `rg -n 'new Map\(|new Set\(' -g '*.ts' -g '!*.test.ts'`; each must be an immutable build, not a mutation
- [ ] Known fixes:
  - **`Stage.ts`:**
    - `apply` becomes `StageCommand.match`;
    - `tileFor` becomes `ChannelAvailability.$match` (or its union's `match`), with `Tile`'s `NotYet` fields made
      `Schema.optionalKey` over `Option` so no conditional spread is needed;
    - `settle` builds `audioFocus` and `solo` as `Option` with `Schema.OptionFromOptional…`, whichever Effect 4
      offers (read `Schema.d.ts`), so its conditional spreads go;
    - `tile._tag === "Empty"` becomes `Tile.guards.Empty`.
  - **`Game.ts`, `Play.ts`, `HubConfig.ts`, `EspnDecoder.ts`:** each `_tag ===` becomes the union's `match` or `guards`.
  - **`EspnDecoder`'s `State` interface** becomes a `Data.Class`, and its `Set`s become `HashSet`, if that reads better.
- [ ] Do one commit per module touched, `refactor(<scope>): <module> to Effect idiom`, each passing `pnpm check`. A
  Stage change that alters a wire shape must keep the JSON identical; `Stage.test.ts`'s encode tests prove it.
- [ ] Mark every sweep-list line `fixed` or `kept: <why>`.

## A9: The unit holds

- [ ] `pnpm check` on the branch head.
- [ ] Run the corpus events comparison and the rebuild check one last time; record both in the ledger.
- [ ] Run the Hub against a scratch copy of the feed log: `SPORTAL_DATA_DIR=<scratch>` with `feed-before.sqlite` copied
  in as `feed.sqlite`. Check that migration 3 runs and the Hub serves `GET /api/health`.
- [ ] Ask the user to back up `.sportal/feed.sqlite` before running this branch on their machine. Then ask them to run
  the `pnpm dev:golden` eye-check.
- [ ] Final whole-branch review: `superpowers:requesting-code-review` over `BASE..HEAD`, then `plannotator review`
  for the user.
- [ ] Update the memory file `hub-abstractions.md` with the merge state.
