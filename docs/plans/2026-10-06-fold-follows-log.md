# The fold follows the feed log — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry out `docs/specs/2026-10-06-fold-follows-log-design.md`. The Hub's `LiveGames` follows the feed log
itself and owns the replay boundary. `Decoded` is one value per frame, and the fold's watermark moves on every frame,
so an undecodable poll no longer stalls polling. The push takes one live feed demand stream and reconnects on its
port's Schedule. One snapshot feed replaces the two copies in `ScenarioProvider` and `TestProvider`, and no layer
provides `Provider | Decoder`.

**Architecture:** One branch `fold-follows-log` in the worktree `../sportal-fold-follows-log`, where the spec is
already committed. Tasks 1–8 run in order, one commit each, every commit passing `pnpm check`. Task 3 is the `fix:`
for the stall. Task 5 is the `fix:` for the written scenario's silent drop. The rest are `refactor:`.

**Tech Stack:** Effect 4 (`effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`), Vitest with `@effect/vitest`,
Biome, dependency-cruiser, knip, pnpm workspaces.

## Global constraints

- Read `AGENTS.md`, `CONTEXT.md`, and the spec before any task. Their rules apply to every line written here.
- Effect 4 is newer than training data. Before writing Effect code, read `node_modules/effect/ai-docs/src/index.md`
  and the example it points to for the API at hand (`03_stream` for streams, `06_schedule`, `09_testing` for the test
  clock). For a Schema tagged union, read the `TaggedUnion` doc comment in `node_modules/effect/dist/Schema.d.ts`
  (around line 5085). Copy the patterns of the file you are editing. Never write Effect from memory.
- This plan gives signatures, behaviour, and test cases. Write bodies from the code you are replacing; each task
  names that code.
- `pnpm check` passes before every commit. Run one test file with `pnpm vitest run <path>`.
- Existing tests keep their assertions. Only their setup changes, unless a step says otherwise.
- No export lives only for its tests (`knip --production`). `Test*.ts` files are outside knip's production project.
- Every new exported type name gets its `CONTEXT.md` row in the same commit. `SnapshotPayload.ts` is exempt, as a
  `*Payload.ts` wire schema.
- A service is yielded where it is used. Nothing indexes `X["Service"]`. A port's shared member types are named and
  exported beside it.
- States are tagged unions, never boolean flags. Effect abstractions over hand-rolled loops, `Map` mutation, or
  `throw`.
- Comments: doc comments on major exports. Inline comments only for a non-obvious why.
- No `any`, non-null assertions, enums, default exports, or casts outside decoding.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never edit the main checkout at `../sportal`. The user runs the app from it.

## Setup

- [ ] `cd ../sportal-fold-follows-log` (dependencies are installed).
- [ ] `pnpm check` should PASS. Every task below runs here.

## File map

| File | Task | Change |
|---|---|---|
| `packages/domain/src/Delivery.ts` | 1 | `Delivery` becomes a `Schema.TaggedUnion` |
| every `Delivery.X(...)` / `Delivery.$match` caller (11 files) | 1 | `Delivery.cases.X.make(...)` / `Delivery.match` |
| `apps/hub/src/provider/Provider.ts` | 2, 7 | `Decoded` is a per-frame class; + `LiveFeedDemand`, `reconnect`, new `LiveFeed` |
| `apps/hub/src/provider/Decoder.ts` | 2 | contract: exactly one `Decoded` per frame |
| `apps/hub/src/provider/espn/EspnDecode.ts` | 2 | builds one `Decoded` per frame |
| `packages/domain/src/LiveGames.ts` | 3, 6 | `step` → `take(frame)` + `tick(now)`; `publishesSameAs` ignores `seq` (6) |
| `apps/hub/src/LiveGames.ts` | 3, 6, 7 | takes a `Decoded`; then follows the log; + `through`, `demand`, `Following` |
| `apps/hub/src/Frame.ts` | 4 | `feed` gains `"snapshot"` |
| `apps/hub/src/provider/snapshot/{SnapshotPayload,SnapshotProvider,SnapshotDecode}.ts` | 4 | new |
| `apps/hub/src/scenario/ScenarioProvider.ts` | 5 | `written` and `recorded` Provider layers; `ofSlates` goes |
| `apps/hub/src/provider/espn/EspnProvider.ts` | 5, 7 | `Layer<Provider, …>` only; + `reconnect` |
| `apps/hub/src/HubMode.ts` | 5, 6 | pairs Provider and Decoder; one FeedLog to both |
| `apps/hub/src/provider/TestProvider.ts` → `apps/hub/src/TestFeed.ts` | 5, 6 | no decoder; helpers over the snapshot feed |
| `apps/hub/src/LiveGamesTelemetry.ts` | 6 | `reported` + `quiet` → `told(following, decoded, reports)` |
| `apps/hub/src/ingest/DecodeTelemetry.ts` → `apps/hub/src/DecodeTelemetry.ts` | 6 | moves |
| `apps/hub/src/ingest/Ingest.ts` → `apps/hub/src/Ingest.ts` | 3, 6, 7 | shrinks to poll, push, append, `through` |
| `apps/hub/src/provider/espn/FastCast.ts` | 7 | `push(demand)`; yields `HubConfig` for leagues |
| `CONTEXT.md`, `docs/technical-spec.md`, `telemetry/dashboards/hub.json` | each task, 8 | rows and docs |

---

### Task 1: `Delivery` is a Schema tagged union

`refactor(domain): Delivery is a Schema tagged union`

**Files:** `packages/domain/src/Delivery.ts` and every caller (`rg -l 'Delivery\.(Listing|Snapshot|Plays|\$match)' apps packages`).

**Interfaces:**
- Produces: `Delivery` is both the schema and its type. Its cases are `Listing { league: LeagueId; games: Array<GameSnapshot> }`,
  `Snapshot { snapshot: GameSnapshot; from: DeliverySource }`, and `Plays { game: GameId; plays: Array<Play> }`. It is
  built with `Delivery.cases.<Case>.make({...})` and matched with `Delivery.match(delivery, {...})`, or with whatever
  `TaggedUnion` exposes for these.
  `DeliverySource` is unchanged. `GameId`, `LeagueId`, `GameSnapshot`, and `Play` are already schemas; import them as
  values.

- [ ] **Step 1: Write the failing test.** In `packages/domain/src/Delivery.test.ts` (new), write a round trip for each case
  through `Schema.encodeSync(Schema.fromJsonString(Delivery))` and its decode, using `TestGame` snapshots and a
  `Play` from an existing play test. Run it with `pnpm vitest run packages/domain/src/Delivery.test.ts`. It should
  FAIL, because `Delivery` is not a schema.
- [ ] **Step 2: Convert `Delivery.ts`** to `Schema.TaggedUnion`, keeping the doc comment.
- [ ] **Step 3: Update every caller** to the new construction and matching spelling. The behaviour is unchanged.
- [ ] **Step 4: Run** `pnpm check`. It should PASS.
- [ ] **Step 5: Commit.**

---

### Task 2: `Decoded` is what one frame said

`refactor(hub): Decoded is one value per frame`

**Files:**
- Modify: `apps/hub/src/provider/Provider.ts`, `apps/hub/src/provider/Decoder.ts`, `apps/hub/src/provider/espn/EspnDecode.ts`.
- Modify: the two snapshot decoders that Task 5 replaces: `ofSlates` in `apps/hub/src/scenario/ScenarioProvider.ts`
  and `decoder`/`said`/`listedBy` in `apps/hub/src/provider/TestProvider.ts`.
- Modify: `apps/hub/src/ingest/Ingest.ts` (`route`).
- Modify: `apps/hub/src/LiveGames.replay.test.ts` (`deliveriesOf`).
- Tests: `apps/hub/src/provider/espn/EspnDecode.test.ts` and `CONTEXT.md` (the **Decoded** row).

**Interfaces:**
- Produces:
  ```
  class Decoded extends Data.Class<{
    readonly seq: number
    readonly at: DateTime.Utc
    readonly deliveries: ReadonlyArray<Delivery>
    readonly resyncs: ReadonlyArray<string>
    readonly notices: ReadonlyArray<Notice>
  }>
  Decoder.decode(frames: Stream<Frame>): Stream<Decoded>   // exactly one per frame, in order
  ```
  The `Decoded` tagged enum and its `Delivered`, `Resync`, and `Noted` cases are gone.
  `Notice.FrameUndecoded.feed` is typed `FeedFrame["feed"]`. That is a schema field type, not a service index, so the
  rule allows it.

- [ ] **Step 1: Write failing tests** in `EspnDecode.test.ts`:
  - A FastCast message that changes no document gives exactly one `Decoded`, and its three arrays are empty except
    for the `Received` notice.
  - An undecodable poll gives one `Decoded` with no deliveries and one `FrameUndecoded` notice.
  - A scoreboard push gives one `Decoded` whose deliveries are each pushed game's `Snapshot`, and whose notices
    include `Pushed`.
  - A dropped document gives a `Decoded` whose `resyncs` is `[topic]`.
  - N frames in give exactly N `Decoded`s out, with matching `seq`s.

  Run them. They should FAIL to compile.
- [ ] **Step 2: Reshape `Decoded` and the `Decoder` contract.** In `EspnDecode`, `listed` and `pushed` already return
  `[State, Said]` per frame through `Stream.mapAccumEffect`. Return `[State, Decoded]` instead, and delete `Said`,
  `delivered`, `noted`, and the flattening.
- [ ] **Step 3: Reshape the snapshot decoders** in `ScenarioProvider.ofSlates` and `TestProvider.decoder` to emit one
  `Decoded` per frame. Keep their current behaviour: the scenario copy still drops nothing it doesn't drop today,
  because Task 5 replaces it.
- [ ] **Step 4: Ingest's `route` takes a `Decoded`.**
  - At or before the replay boundary, each delivery goes to the replay queue as
    `{ delivery, at: decoded.at, seq: decoded.seq }`.
  - After the boundary, each delivery goes to `liveGames.take(delivery, decoded.at, Option.some(decoded.seq))`, each
    resync to the PubSub, and each notice to `DecodeTelemetry.noticed`.

  Update existing `EspnDecode` and Ingest test assertions to read the new shape. Their meaning is unchanged.
  `deliveriesOf` in `LiveGames.replay.test.ts` flattens `decoded.deliveries`.
- [ ] **Step 5: Update CONTEXT.md.** Replace the **Decoded** row with the spec §1 wording.
- [ ] **Step 6: Verify and commit.** `pnpm check` should PASS. Commit.

---

### Task 3: The fold takes a frame; every frame moves the watermark

`fix(hub): every frame moves the fold's seq, so a poll that does not decode no longer stalls polling`

**Files:**
- Modify: `packages/domain/src/LiveGames.ts` (and its test).
- Modify: `apps/hub/src/LiveGames.ts`, where `take` takes a `Decoded` and `replay` takes `Stream<Decoded>`.
- Modify: `apps/hub/src/ingest/Ingest.ts`, and every test caller of `liveGames.take`/`replay`, including `TestProvider.taken`.
- Test: `apps/hub/src/ingest/Ingest.test.ts`.

**Interfaces:**
- Produces, in the domain:
  ```
  LiveGames.take(frame: { readonly deliveries: ReadonlyArray<Delivery>; readonly at: DateTime.Utc; readonly seq: number })
    : Effect<{ readonly next: LiveGames; readonly reports: ReadonlyArray<FoldReport> }>
  LiveGames.tick(now: DateTime.Utc): Effect<{ readonly next: LiveGames; readonly reports: ReadonlyArray<FoldReport> }>
  ```
  `step` is gone. `take` ticks every game due after `reached` and at or before `at`, applies each delivery in order
  through today's `applied`, and sets `seq` and `reached`. `tick` ticks to `now` and leaves `seq` alone.
  `publishesSameAs` still compares `seq` here; Task 6 changes that.
- Produces, in the Hub (interim; Task 6 replaces these members):
  `take(decoded: Decoded): Effect<void>` and `replay(decoded: Stream<Decoded>): Effect<number>`. The count is
  deliveries, as today.
- Ingest's `route` calls `take(decoded)` once for every live frame, including frames with no deliveries. It offers
  every replayed `Decoded` to the replay queue.

- [ ] **Step 1: Write the failing regression test** in `Ingest.test.ts`. A provider's second poll answers a frame
  whose body does not decode, followed by good polls on a 1-second `Schedule.spaced` polling.
  - With the test clock advanced 1 s past the bad poll, the next poll has already happened. Today it waits the 5 s
    `takenWithin`.
  - Assert the provider's poll count.

  Run it. It should FAIL.
- [ ] **Step 2: Write failing domain tests** in `packages/domain/src/LiveGames.test.ts`:
  - `take` of a frame with no deliveries ticks a due game (a live game past 90 s goes `Stale`) and sets `seq`.
  - `take` of `[Listing, pushed Snapshot of a listed game]` reports `Took … taken` for the snapshot.
  - `tick(now)` never changes `seq`.
  - Two deliveries in one frame give the same `live` and `listed` as the same two in two frames at the same `at`.

  Run them. They should FAIL to compile.
- [ ] **Step 3: Replace `step` with `take` and `tick`** in the domain fold, from `step`'s body. Port the existing
  `step` tests to the method they exercise.
- [ ] **Step 4: Update the Hub's `LiveGames`.**
  - `take(decoded)` folds with `Fold.take(decoded)`, and the timer uses `Fold.tick(now)`.
  - The span is annotated with `sportal.seq` and `sportal.deliveries`.
  - `replay` runs `Fold.take` per `Decoded` and returns the delivery count.
  - The `seq: Option` parameter and the "scripted deliveries have none" doc go.
- [ ] **Step 5: Update the callers.**
  - Ingest takes every live `Decoded`. The `takenWithin` doc no longer says a frame moves no `seq`. Keep the timeout
    until Task 6 deletes it.
  - `TestProvider.taken(delivery, seq?)` builds a one-delivery `Decoded`, with `seq` defaulting to the next one it
    counts.
  - Update the test callers of `liveGames.take`/`replay`.
- [ ] **Step 6: Verify and commit.** `pnpm check` should PASS, including Step 1's test. Commit.

---

### Task 4: The snapshot feed

`feat(hub): the snapshot feed, a provider whose frames are our own deliveries`

**Files:**
- Create: `apps/hub/src/provider/snapshot/SnapshotPayload.ts`, `SnapshotProvider.ts`, `SnapshotDecode.ts`, and
  `SnapshotProvider.test.ts` and `SnapshotDecode.test.ts` beside them.
- Modify: `apps/hub/src/Frame.ts`, and `CONTEXT.md` (the **Snapshot feed** row).

**Interfaces:**
- Produces:
  ```
  // SnapshotPayload.ts — the frame body
  SnapshotPayload: Schema  // fromJsonString of: Delivery | TaggedStruct("Resync", {})  (resyncs the frame's channel)

  // SnapshotProvider.ts
  layer(options: {
    readonly games: (league: LeagueId) => Effect<ReadonlyArray<GameSnapshot>, ProviderError>
    readonly push?: Stream<FeedFrame, ProviderError>     // used until Task 7 gives LiveFeed its demand
    readonly polling: Polling
    readonly reconnect?: Schedule<unknown, ProviderError> // added to the port in Task 7; default Schedule.spaced("1 second")
  }): Layer<Provider>
  // a poll of `league` is a frame { feed: "snapshot", kind: "response", channel: league, body: Listing{league, games} }

  // SnapshotDecode.ts
  layer: Layer<Decoder>   // one Decoded per frame: its delivery, or a resync of frame.channel, or FrameUndecoded
  ```
  `FeedFrame.feed` is `Schema.Literals(["poll", "fastcast", "snapshot"])`.
  `Frame.isPollResponse` is unchanged: it still reads `feed === "poll"`.
- This task adds no production callers; Task 5's written scenario is the first. Nothing here is exported only for
  tests: a push frame for tests is built in `TestFeed.ts` (Task 5) from `SnapshotPayload`, which the adapter uses.

- [ ] **Step 1: Write failing tests.**
  - `SnapshotDecode.test.ts`: each of `Listing`, `Snapshot` (push and poll), and `Plays` round-trips through
    `SnapshotProvider`'s frame and `SnapshotDecode`.
  - A `Resync` body gives `resyncs: [channel]`.
  - A body that is not JSON gives one `Decoded` with a `FrameUndecoded` notice of feed `snapshot`.
  - N frames give N `Decoded`s.
  - `SnapshotProvider.test.ts`: a poll's frame is a `Listing` of `games(league)` on that channel; a failing `games`
    fails the poll with its `ProviderError`; `polling` is the given Schedule.

  Run them. They should FAIL.
- [ ] **Step 2: Implement the three files.** Build them from `TestProvider.polled`/`said` and `ScenarioProvider.ofSlates`.
  A service file reads: the service or layer first, then private helpers.
- [ ] **Step 3: Update CONTEXT.md.** Add the **Snapshot feed** row from spec §5.
- [ ] **Step 4: Verify and commit.** `pnpm check` should PASS. Commit.

---

### Task 5: Separate Provider and Decoder layers; written scenarios play as the snapshot feed

`fix(scenario): a written scenario plays as the snapshot feed, and a frame of it that does not decode is noted`

**Files:**
- Modify: `apps/hub/src/scenario/ScenarioProvider.ts`, `apps/hub/src/provider/espn/EspnProvider.ts`, and
  `apps/hub/src/HubMode.ts`.
- Move: `apps/hub/src/provider/TestProvider.ts` → `apps/hub/src/TestFeed.ts`.
- Modify: every test that imports `TestProvider` (`Ingest`, `Slate`, `GameHistory`, `LiveGames`, `HubServer`,
  `YouTubeTv`, `EspnProvider`, `ScenarioProvider`), and the **Decoder** and **Scenario** rows in `CONTEXT.md`.

**Interfaces:**
- Produces:
  ```
  EspnProvider.layer: Layer<Provider, never, FastCast | HttpClient>        // EspnDecode.layer is separate
  ScenarioProvider.written: Layer<Provider, ScenarioUnknown, HubConfig>    // SnapshotProvider driven by Scenario.slateAt
  ScenarioProvider.recorded: Layer<Provider, ScenarioUnknown | ScenarioUnreadable, HubConfig | RecordedScenarios>
  Scenario.isWritten(name: string): boolean   // static on Scenario, read by HubMode; the written map stays in written/Scenarios.ts
  ```
  `ofSlates` is deleted. `pollingAt`, `movedTo`, and `noEvents` stay.
- Produces, in `TestFeed.ts`:
  - `listedBy(league)`: polls the provided `Provider` and decodes with the provided `Decoder`; unchanged in purpose.
  - `taken(delivery, seq?)`: unchanged; Task 6 replaces it.
  - `polled(games, options)`: `SnapshotProvider.layer` with a 10 s `Schedule.spaced` default polling.

  `TestFeed.ts` exports no decoder. Tests provide `SnapshotDecode.layer`.
  `scripted` moves into `Ingest.test.ts`, its only user, as a `SnapshotProvider.layer` whose `games` reads a script.
  `pushed(payload, channel)` builds a snapshot push frame (kind `message`, received at the clock's now) from
  `SnapshotPayload`.
- Tests that relied on the old test decoder reading an empty push as a `Resync` now push an explicit `Resync` payload.
- `HubMode`:
  - `live()` provides `EspnProvider.layer` to Ingest and `EspnDecode.layer` beside it.
  - `scripted()` becomes a `Layer.unwrap` on `HubConfig.scenario`. When `Scenario.isWritten(name)` it uses
    `ScenarioProvider.written` with `SnapshotDecode.layer`; otherwise `ScenarioProvider.recorded` with
    `EspnDecode.layer`.
  - The compile-time check stays.
  - Ingest still yields `Decoder` until Task 6.

- [ ] **Step 1: Write failing tests** in `ScenarioProvider.test.ts`:
  - A written scenario's poll decodes through `SnapshotDecode` to the same listings as before.
  - A recorded scenario's layer no longer requires `Decoder`: a type-level check that it builds with
    `HubConfig | RecordedScenarios` only.
  - The recorded slices pass through `EspnDecode` unchanged.

  Run them. They should FAIL.
- [ ] **Step 2: Split the layers** in `EspnProvider`, `ScenarioProvider`, and `HubMode`, as above.
- [ ] **Step 3: Move `TestProvider.ts` to `TestFeed.ts`** and migrate every test's setup. Assertions are unchanged.
- [ ] **Step 4: Update CONTEXT.md.**
  - **Decoder:** *provided by its adapter as a layer of its own; `HubMode` pairs it with its provider.*
  - **Scenario:** a written one plays as the snapshot feed.
- [ ] **Step 5: Verify and commit.** `pnpm check` should PASS. `rg 'Provider \| Decoder' apps` should find nothing.
  Commit.

---

### Task 6: The Hub's `LiveGames` follows the feed log

`refactor(hub): the live games follow the feed log and decide the replay boundary`

**Files:**
- Modify: `apps/hub/src/LiveGames.ts` and `apps/hub/src/LiveGamesTelemetry.ts`.
- Modify: `packages/domain/src/LiveGames.ts`, where `publishesSameAs` ignores `seq`.
- Move: `apps/hub/src/ingest/DecodeTelemetry.ts` (and its test) → `apps/hub/src/`.
- Modify: `apps/hub/src/ingest/Ingest.ts`, `apps/hub/src/HubMode.ts`, and `apps/hub/src/TestFeed.ts`.
- Tests: `apps/hub/src/LiveGames.test.ts` and `LiveGames.replay.test.ts`, plus every test using `taken`.
- Docs: the **Live games** and **Following** rows in `CONTEXT.md`.

**Interfaces:**
- Produces:
  ```
  // LiveGames.ts
  type Following = Data.TaggedEnum<{ Replaying: {}; Live: {}; Stopped: {} }>; export const Following
  class LiveGames extends Context.Service<LiveGames, {
    readonly latest: Effect<Fold.LiveGames>
    readonly changes: Stream<Fold.LiveGames>     // seq or reached alone is not a change
    readonly events: Stream<Happened>
    through(seq: number): Effect<Fold.LiveGames> // first state with seq ≥ `seq`, or the latest once Stopped
  }>
  LiveGames.layer: Layer<LiveGames, never, FeedLog | Decoder | DateTime.CurrentTimeZone>

  // LiveGamesTelemetry.ts
  told(following: Following, decoded: Decoded, reports: ReadonlyArray<FoldReport>): Effect<void>
  ```
  `take` and `replay` leave the interface. `reported` and `quiet` are deleted, and their `$match` arms become `told`'s:
  - Replaying counts plays, kept in the following loop's state for the summary, and logs `Raised` with "in replay".
  - Live behaves as `reported` does today, and tells each notice through `DecodeTelemetry.noticed`.
  - Stopped tells nothing.

  `gaugeHeld`, `countByState`, and `timerDefect` stay.
- The layer's body follows spec §3:
  1. `dayStart` moves here from Ingest.
  2. Subscribe to the log first, then run one `decoder.decode` over `replay(from)` followed by the appended frames
     after the replay's last `seq`. This is Ingest's current construction; move it.
  3. Fold every replayed `Decoded` quietly, with the following in `Replaying`.
  4. At the boundary, set the gauges, log the summary, set `Live`, and fork the timer. The build returns here.
  5. A decode defect after the boundary sets `Stopped` and logs once at Error with today's message. A defect before
     the boundary fails the build: race the replay against the decode fiber, as Ingest does today.

  The state holds the fold and the `Following`, so `through` can wait on it. The `replaying` semaphore goes.
- `TestFeed.delivered(delivery)` appends one snapshot frame carrying `delivery` to the `FeedLog`, received at the
  clock's now, and returns `liveGames.through(seq)`. It replaces `taken`.
- `TestFeed.liveGames(frames?)` is a layer: an in-memory `FeedLog` (`FeedLog.layer` over `Database.at(":memory:")`,
  as the tests already build it) with `frames` appended before `LiveGames.layer`, plus `SnapshotDecode.layer`.
- Ingest no longer yields `Decoder` and no longer replays.
  - The polled Schedule input is `(yield* liveGames.through(last)).slate(leagues)`.
  - `taken`, `takenWithin`, `replayed`, `replayedUpTo`, `frames`, and `route` go.
  - Resyncs still need a path to the push until Task 7. For one commit, `LiveGames` exposes
    `readonly resyncs: Stream<string>` from a `PubSub` published on Live, and Task 7 folds it into `demand`. Note it in
    the doc comment as Task 7's.
- `HubMode` builds one `FeedLog` with `Layer.provideMerge` under both `LiveGames.layer` and `Ingest.layer`, and gives
  `DateTime.layerCurrentZoneLocal` to `LiveGames`.

- [ ] **Step 1: Write failing tests** in `LiveGames.test.ts` and `LiveGames.replay.test.ts`, from spec §9. Build them
  with `TestFeed.liveGames` and `TestFeed.delivered`.
  - The build returns only after the log's last frame is taken.
  - A frame appended during the build is told loudly, after the boundary.
  - A recorded day replayed gives the same live games as taken live. Rewrite the replay test through the layer; the
    hand-built pipeline and `deliveriesOf` go.
  - `through(n)` answers for a frame that decodes only to a notice.
  - `through` answers once Stopped. Use a `Decoder` that dies after the boundary.
  - No notice is told from a replayed frame. Assert the `sportal_frames_undecoded` metric.
  - `changes` does not emit when only `seq` moved.
  - A take during the catch-up cannot happen. Delete the test of the semaphore and say so in the commit body.

  Run them. They should FAIL.
- [ ] **Step 2: Implement** `LiveGames`, `Following`, `told`, and the move of `DecodeTelemetry`.
- [ ] **Step 3: Shrink Ingest** as above. Its test of the undecodable poll from Task 3 still passes, now with no
  timeout.
- [ ] **Step 4: Migrate tests.** Every `taken` becomes `delivered`, and every test of the fold builds `TestFeed.liveGames`.
  Assertions are unchanged except where a step says.
- [ ] **Step 5: Update CONTEXT.md.** Write the **Live games** row from spec §3 and add the **Following** row from
  spec §6.
- [ ] **Step 6: Verify and commit.** `pnpm check` should PASS. `rg 'takenWithin|replayedUpTo|replaying|quiet\(' apps`
  should find nothing. Commit.

---

### Task 7: Live feed demand and reconnect on the port

`refactor(hub): the live feed follows the live games' demand and reconnects on its provider's Schedule`

**Files:**
- Modify: `apps/hub/src/provider/Provider.ts`, `apps/hub/src/provider/espn/FastCast.ts`,
  `apps/hub/src/provider/espn/EspnProvider.ts`, `apps/hub/src/scenario/ScenarioProvider.ts`,
  `apps/hub/src/provider/snapshot/SnapshotProvider.ts`, and `apps/hub/src/LiveGames.ts`.
- Move: `apps/hub/src/ingest/Ingest.ts` and `Ingest.test.ts` → `apps/hub/src/`, deleting `ingest/`.
- Tests: `FastCast.test.ts`, `Ingest.test.ts`, `LiveGames.test.ts`, and `CONTEXT.md` (the **Live feed demand**,
  **Provider**, and **Ingesting** rows).

**Interfaces:**
- Produces:
  ```
  // Provider.ts
  type LiveFeedDemand = Data.TaggedEnum<{
    Games:  { readonly games: ReadonlyArray<GameSnapshot> }
    Resync: { readonly channel: string }
  }>; export const LiveFeedDemand
  type LiveFeed = (demand: Stream<LiveFeedDemand>) => Stream<FeedFrame, ProviderError>
  Provider: { poll; push: LiveFeed; polling: Polling; reconnect: Schedule<unknown, ProviderError> }

  // LiveGames.ts
  readonly demand: Stream<LiveFeedDemand>   // replaces Task 6's `resyncs`
  ```
- `demand`, per subscription:
  - First, `Games` of the current games: those where `LiveGame.isCurrent(now)`, deduped by id. Move this from
    Ingest's `wanted`, along with `sameIds`.
  - Then each change in which games are current, merged with each `Resync` taken while Live.
- `FastCast.push(demand)`:
  - Yields `HubConfig` in `FastCast.layer` for `leagues`.
  - Inside, splits the demand into today's `wanted` and `resync` streams, e.g. by `Stream.partition` or two
    `filterMap`s over one shared stream; pick what `03_stream` shows. Everything after `connect`'s arguments is
    unchanged.
- ESPN's `reconnect` is Ingest's `reconnect` Schedule, moved verbatim with its comment. The recorded scenario and the
  snapshot provider default to `Schedule.spaced("1 second")`.
- Ingest:
  - Runs `provider.push(liveGames.demand)`, logging and counting each failure by reason as today.
  - Retries on `provider.reconnect` and appends each frame.
  - Its `PubSub`, `wanted`, and `reconnect` go.

- [ ] **Step 1: Write failing tests.**
  - `LiveGames.test.ts`: `demand` starts with `Games` of the current games; follows a change of which games are
    current but not a change of their snapshots; carries a `Resync` from a live frame but not from a replayed one; and
    a second subscription starts with the current `Games` again.
  - `Ingest.test.ts`: a push failing twice is resubscribed on the provider's `reconnect`. Give it
    `Schedule.recurs(1)` and assert the feed ends logged after the second failure.
  - `FastCast.test.ts`: existing tests drive `push` with a demand stream (`Games` then `Resync`), with assertions
    unchanged.

  Run them. They should FAIL.
- [ ] **Step 2: Implement** the port change, `FastCast`, the adapters, `LiveGames.demand`, and the Ingest shrink.
- [ ] **Step 3: Move Ingest to `apps/hub/src/`** and delete `ingest/`. Update imports, `.dependency-cruiser.cjs`
  rules naming `ingest/` if any, and `HubMode`.
- [ ] **Step 4: Update CONTEXT.md** from spec §4 and §7:
  - Add the **Live feed demand** row.
  - **Provider:** add *and how its push is reconnected*.
  - **Ingesting:** rewrite it, and drop "in `ingest/`".
- [ ] **Step 5: Verify and commit.** `pnpm check` should PASS. Only `LiveGames.ts` yields `Decoder` in production
  (`rg 'yield\* Decoder' apps/hub/src --glob '!*.test.ts' --glob '!Test*'`). Commit.

---

### Task 8: Docs and dashboard

`docs: the technical spec and dashboard match the fold that follows the log`

**Files:**
- Modify: `docs/technical-spec.md` §3 (the Mermaid `ingest[...]` node), §4.2 (the tree: `ingest/` gone, plus
  `provider/snapshot/`, `TestFeed.ts`, `DecodeTelemetry.ts`), §5.1 (the `Decoder`, `Provider`, and `LiveGames`
  signatures), and §5.2 (who replays, the per-frame watermark).
- Modify: `telemetry/dashboards/hub.json`. The `sportal_take_duration` panel title and description say *frame*.
- Modify: `docs/game-day-checklist.md`, wherever it names Ingest's replay or `takenWithin`
  (`rg -n 'replay|takenWithin|Ingest' docs/game-day-checklist.md`).
- Modify: `AGENTS.md`, only if a path it names moved. It names no `ingest/` path today; check.

- [ ] **Step 1: Update the docs above** to describe the code as built. Use the glossary's words.
- [ ] **Step 2: Verify and commit.** `pnpm check` should PASS. Commit.

## Finish

- [ ] Run `pnpm check` on the branch head.
- [ ] Run `plannotator review` on the branch. Act on the feedback.
- [ ] Hand the user the manual checks from the spec's Verification:
  - a recorded and a written scenario at speed 10;
  - the desktop shell, which the user runs, because the agent shell misreports Electron here.
- [ ] Merge to main once the user approves, then `docs(history): fold-follows-log's merge commit`.
