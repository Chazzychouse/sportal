# Game Actors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every game the Hub follows has an `effect/cluster` entity that alone decides its live state (upcoming, live,
stale, over) from the snapshots sent to it. Ingest sends each poll through those actors and publishes the slate from
what they hold. Nothing a person sees changes.

**Architecture:** Two pure domain additions, both written test-first: `GameSnapshot.gameTime`, an `Order`, and
`LiveGame`, a `Data.Class` with a `Data.taggedEnum` state. In the Hub, `game/GameActors.ts` holds the `Game` entity
(one volatile `Receive` RPC), a single-process cluster composed from cluster's public layers with no-op message
storage, a private `LiveGames` registry, and the `GameActors` service that Ingest calls. Each entity keeps its live
game in a `SubscriptionRef` and runs three reactions to its changes: the staleness timer, keep-alive, and the registry
write.

**Tech Stack:** Effect 4 (`effect/cluster` `Entity`, `Sharding`, `Runners`, `MessageStorage`, `RunnerStorage`,
`RunnerHealth`, `ShardingConfig`; `effect/rpc` `Rpc`; `Data.taggedEnum`, `Data.Class`, `Order`, `SubscriptionRef`,
`Stream`, `Metric`, `Logger`), `@effect/vitest`, `effect/testing` `TestClock`.

**Spec:** `docs/specs/2026-10-04-game-actors-design.md`. **Decision:** `docs/adr/0006-live-games-are-actors.md`.

**Starts after [Hub telemetry](./2026-10-04-telemetry.md) is merged to `main`.** This plan uses its `Ingest.poll` span,
its OTLP export, and its `telemetry/dashboards/hub.json`. Then create the worktree with
`git worktree add ../sportal-game-actors -b game-actors main` and run `pnpm install --frozen-lockfile --prefer-offline`
inside it. Copy the spec, the ADR, and this plan into it from `.worktrees/game-actors-design` as the first commit
(`docs: game actors design, ADR 0006, and plan`). Never touch the main checkout. Stop any stray Hub on port 4400 before
running one.

## Global Constraints

- Read `AGENTS.md` first. Effect 4 is newer than most training data: read
  `node_modules/effect/ai-docs/src/80_cluster/10_entities.ts`, then the sources it names under
  `node_modules/effect/src/cluster/` (`Entity.ts`, `Sharding.ts`, `TestRunner.ts`, `ShardingConfig.ts`), before
  writing cluster code. `TestRunner.ts` is the recipe the Hub's composition copies. No new dependency.
- The spike on branch `spike/game-actors` (worktree `../sportal-actor-spike`) is a source of findings, not of code. Do
  not copy from it: it uses `let` state, casts, and `process.env`.
- Every exported type name is a `CONTEXT.md` term. This plan adds **Game time**, **Live game** (whose state type is
  `LiveGameState`), **Stale**, and **Game actor**, each in the commit that introduces its type.
- Main export first; private helpers below as hoisted `function` declarations; no type aliases for options bags,
  return shapes, or callbacks; no `any`, casts outside decoding, non-null assertions, enums, default exports, or
  `index.ts` barrels.
- State is a `Data.taggedEnum` with `$match`, never booleans or `let` flags. No `for` loops, `throw`, or `Effect.try` in
  new code. Every operation on `LiveGame` or `GameSnapshot` is a method or static on its class.
- Time comes from `Clock` (`DateTime.now`). No `Date.now()`.
- Comments: a doc comment on each major export; an inline comment only where the why is not clear from the code.
- Constants: stale after `90 seconds`; current from `30 minutes` before kickoff; entity `maxIdleTime` `5 minutes`.
- Metric names: `sportal_game_actors` (gauge), `sportal_live_games` (gauge, attribute `state`), `sportal_snapshots`
  (counter, attribute `outcome`: `taken` or `behind`), `sportal_transitions` (counter, attributes `from`, `to`),
  `sportal_game_defects` (counter), `sportal_receive_duration` (`Metric.timer`).
- Log annotations on everything an entity logs: `game`, `league`, `matchup` (`"UGA at BAMA"`, away at home).
- The Hub's graceful shutdown stays within its 3-second bound.
- Tests sit beside their file as `Name.test.ts`. Run one file with `pnpm vitest run <path>`. `pnpm check` must pass
  before every commit.
- Commit messages are conventional and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Spec refinements found while planning

Reading `effect/cluster`, `Cadence`, and the shutdown bound changed these details. Task 7 writes them into the spec.

| Spec says | What the code does | This plan |
| --- | --- | --- |
| An actor "goes away 5 minutes after it stops being current" | `maxIdleTime` counts from an entity's last message, and Ingest sends every game on the slate on every poll. On a live slate (10 s polls) no actor idles out, final games included. On a quiet slate (15 min polls) every actor idles out between polls and starts again on the next one | Accepted as the lifecycle: an actor runs while its game is polled often or while it is current. Entity start and stop log at **Debug** for a game that is not current, and at **Info** for one that is, so a quiet slate does not fill the logs. **Open question for the user (below).** |
| Entity state is a `Ref<Option<LiveGame>>`; the timer restarts on every transition | Three things react to every change: the timer, keep-alive, and the registry | A `SubscriptionRef<Option<LiveGame>>`. The timer is `changes` through `Stream.switchMap` (a new change cancels the old sleep); keep-alive is `changes` mapped to `isCurrent`, deduplicated, each value sent to `Entity.keepAlive`; the registry write is `changes` too. Each is a stream forked in the entity's scope |
| Keep-alive while `isCurrent` | `isCurrent` depends on the time (kickoff within 30 minutes), and nothing changes when time passes | Re-evaluated on every change, which includes every snapshot taken. An upcoming game is polled at least every minute once a kickoff is within 30 minutes (`Cadence`), so it becomes current within a minute of the window opening |
| `Entity.keepAlive` with `MessageStorage.layerNoop` | Proved in Task 1: it does not work. `keepAlive(true)` sends `KeepAliveRpc`, which is `Persisted`, and `Sharding.sendOutgoing` dies with "Persisted messages require MessageStorage" when storage is the no-op one (`Sharding.ts` 1172). The handler dies: by default the entity restarts and the caller waits forever; with `disableFatalDefects` the caller gets the defect. Either way the entity idles out at 5 minutes. With `MessageStorage.layerMemory` it works: the entity outlives 10 idle minutes and stops 5 minutes after `keepAlive(false)`. Volatile messages never touch memory storage (50 pings left it unchanged); each `keepAlive(true)` adds one stored request that is never cleared | **Blocked on the user.** The smallest fix is `MessageStorage.layerMemory` in place of `layerNoop`. It grows by one small entry each time a game becomes current, since keep-alive is sent only on a change of `isCurrent` |
| Composition: `ShardingConfig.layer({…})` with explicit values | `entityTerminationTimeout` defaults to 15 s, which alone would break the Hub's 3 s shutdown bound | `entityTerminationTimeout: "1 second"`, and `simulateRemoteSerialization: false` (one process, so snapshots pass as they are). Proved in Task 1: with a handler that never finishes, closing the cluster's scope takes exactly 1 s of `TestClock` time. A volatile request with the no-op runners and storage replies. Task 6 proves the Hub still stops within the bound |
| (Not in the spec) Time per request on the `TestClock` | Proved in Task 1: a volatile request replies with no `TestClock` time passing, the first one that starts the entity included. The spike's 100 ms per request came from persisted messages, which wait on storage polling | Tests send a snapshot and assert at once, with no `TestClock.adjust` to let delivery happen |
| (Not in the spec) Scenario time drives idling | Proved in Task 1: with `ScenarioClock.layer(10)` provided to the composition, an entity idles out after 30 s of `TestClock` time (5 scenario minutes). The reaper checks every `min(30 s, maxIdleTime)`, at least 5 s, on the clock it was built with. So an entity stops at the first check after 5 idle minutes: between 5:00 and 5:30 | `HubMode` provides the scenario clock to `GameActors.layer`, as planned. Lifecycle tests allow the 30 s check interval: not stopped at 4:59, stopped by 5:30 |
| `GameActors.receive(snapshot): Effect<void>` | A client call can fail with cluster errors (`MailboxFull`, `EntityNotAssignedToRunner`, and others) | `receive` logs a cluster error at Error with the game's annotations, counts it in `sportal_game_defects`, and succeeds. The game keeps its last good live game and the next poll sends again. An error from one game never fails Ingest's poll |
| Glossary: four rows | `LiveGameState` is an exported type | The **Live game** row names its state type, `LiveGameState`, so the export is covered without a fifth row |
| "Over, refreshed" for an over game | A postponed game is `over`. If ESPN later reschedules it (`scheduled`), that snapshot is behind and ignored | Accepted: the game comes back as upcoming once its actor has idled out. Noted in "Restarts and failures" |

### Open question for the user

The lifecycle row above is a real change from the approved spec. The plan builds the recommended option:

- **(Recommended) Accept it.** An actor lives while its game is polled often. On quiet days, actors start and stop
  with each 15-minute poll, logged at Debug. No new code.
- Ingest sends only games that are current or whose actor is running. This puts actor lifecycle knowledge in
  Ingest, and a game that goes final would still have to reach its actor once.
- Keep every actor on the slate alive for the whole day. No churn, but nothing ever idles out, so `maxIdleTime` and
  keep-alive would do nothing.

## Files

| File | Responsibility |
| --- | --- |
| `packages/domain/src/Game.ts` (modify) | `GameSnapshot.gameTime`; `progress()` counts a delayed game that has started as live; `matchup()` |
| `packages/domain/src/Game.test.ts` (modify) | Game time, delayed mid-game, matchup |
| `packages/domain/src/LiveGame.ts` (create) | `LiveGame` and `LiveGameState`: start, receive, tick, staleAt, isCurrent |
| `packages/domain/src/LiveGame.test.ts` (create) | Every cell of the transition table, the 90 s and 30 min edges |
| `apps/hub/src/game/GameActors.ts` (create) | The `Game` entity, the cluster composition, the `LiveGames` registry, the `GameActors` service, its telemetry |
| `apps/hub/src/game/GameActors.test.ts` (create) | Delivery, ordering, staleness, lifecycle, defects, restart, logs, metrics, and pins for each cluster setting |
| `apps/hub/src/ingest/Ingest.ts` (modify) | Sends a poll's snapshots through `GameActors` and publishes each game as its actor has it |
| `apps/hub/src/ingest/Ingest.test.ts` (modify) | Provides `GameActors.layer`; new cases for order and taking snapshots from live games |
| `apps/hub/src/HubMode.ts` (modify) | Provides `GameActors.layer` to Ingest in both modes, on the scenario clock in a scenario |
| `telemetry/dashboards/hub.json` (modify) | The "Game actors" row |
| `CONTEXT.md`, `docs/technical-spec.md`, `docs/game-day-checklist.md`, `docs/adr/0006-live-games-are-actors.md`, the spec (modify) | As the spec's "Documents that change", plus the refinements above |

`game/` holds one source file. The spec puts it there so that FastCast's adapter (piece 2) and the Director's lull
work have a home beside it. If the reviewer reads AGENTS.md's folder rule as forbidding that, the file moves to
`apps/hub/src/GameActors.ts` and nothing else in this plan changes.

---

### Task 1: Prove the single-process cluster

A proof, not a deliverable: its code is deleted at the end of the task. Its findings decide whether Task 4 can be
built as specified.

**Files:**
- Create, then delete: `apps/hub/src/game/ClusterProof.test.ts`
- Modify: this plan's "Spec refinements" table (record the findings)

- [ ] **Step 1: Write the proof as tests** in `ClusterProof.test.ts`. Define a probe entity in the file:
  `Entity.make("Probe", [Rpc.make("Ping", { payload: { n: Schema.Int }, success: Schema.Int })])`, with a handler that
  replies with `n` and logs its start and its finalizer. Compose the cluster exactly as Task 4 will:
  `Sharding.layer` with `Runners.layerNoop`, `MessageStorage.layerNoop`, `RunnerStorage.layerMemory`,
  `RunnerHealth.layerNoop`, `ShardingConfig.layer({ entityTerminationTimeout: Duration.seconds(1),
  simulateRemoteSerialization: false })`. Every case runs under `it.effect` on the `TestClock`:
  - A volatile `Ping` replies. Record how much `TestClock` time must pass before the reply arrives (adjust in 1 ms
    steps up to 5 s, or race the call against `TestClock.adjust`). The spike saw about 100 ms per persisted request.
  - With `maxIdleTime: "5 minutes"`, the entity's finalizer runs after 5 idle minutes and not at 4:59.
  - A handler that calls `Entity.keepAlive(true)` outlives 10 idle minutes; after `Entity.keepAlive(false)` it stops
    5 minutes later.
  - With `disableFatalDefects: true`, a handler that dies fails the caller with the defect instead of leaving it waiting,
    and the next `Ping` to the same id is served.
  - With `ScenarioClock.layer(10)` provided to the composition instead of the `TestClock`, idle passivation happens
    after 30 s of `TestClock` time (5 minutes of scenario time). This is what lets the actors run on scenario time.
  - Closing the layer's scope with a running entity takes no longer than `entityTerminationTimeout`.
- [ ] **Step 2: Run** `pnpm vitest run apps/hub/src/game/ClusterProof.test.ts`. Expected: each case either passes or
  shows what cluster does instead.
- [ ] **Step 3: Record the findings** in the "Spec refinements" table: time per request, whether keep-alive works with
  no-op storage, and whether scenario time drives idling. **If keep-alive does not work, or a volatile request does not
  reply, stop here and bring the finding to the user.** The design depends on both.
- [ ] **Step 4:** Delete `ClusterProof.test.ts`. Commit only the plan change:
  `docs: game actors plan records the cluster composition proof`.

---

### Task 2: Game time orders two snapshots of one game

**Files:**
- Modify: `packages/domain/src/Game.ts`, `packages/domain/src/Game.test.ts`
- Modify: `CONTEXT.md` (Game state section: **Game time**)

**Interfaces:**
- Produces, on `GameSnapshot`:
  - `static readonly gameTime: Order.Order<GameSnapshot>`, beside `watchOrder`. Doc comment: how far a game has
    got (before kickoff, in play, or over), then the period, then less time left on the clock. Orders two snapshots
    of one game.
  - `progress()` returns `"live"` for `delayed` when `period >= 1`. Its doc comment changes to say a delay before
    kickoff is upcoming and a delay during the game is live.
  - `matchup(): string`, `"<away abbreviation> at <home abbreviation>"`. Search the web app first
    (`grep -rn '" at "' apps packages`): if it already builds this string, move that code here and use it there.

`gameTime` is `Order.combine` of three `Order.mapInput`s: progress rank (upcoming 0, live 1, over 2), which is
not the same as `watchOrder`'s `progressRank`, so it is a second private constant beside it; `period`; and
`secondsLeft()` reversed.

- [ ] **Step 1: Write the failing tests** in `Game.test.ts`, with `snapshot()` and `team()` from `TestGame.ts`, in a
  `describe("gameTime")`:
  - An upcoming game is behind the same game live, and live is behind over.
  - Period 2 at 14:00 is ahead of period 1 at 0:30.
  - Within period 3, 2:00 left is ahead of 9:00 left.
  - Two snapshots with the same status, period, and clock compare as equal (`0`), even when their scores differ.
  - Halftime (period 2, 0:00) is ahead of period 2 at 0:10 and behind period 3 at 15:00.
  - A `delayed` game in period 2 at 5:00 is live, and ahead of a live period 1 snapshot.
  - A `delayed` game in period 0 is upcoming.
  And in the existing `describe` for `progress()` (or a new one beside it if there is none): `delayed` in period 0 is
  upcoming; `delayed` in period 2 is live.
  `matchup()`: away `UGA`, home `BAMA` gives `"UGA at BAMA"`.
- [ ] **Step 2: Run** `pnpm vitest run packages/domain/src/Game.test.ts`. Expected: the new cases FAIL (`gameTime`
  and `matchup` do not exist; the delayed case returns upcoming).
- [ ] **Step 3: Implement** the three members to the signatures above.
- [ ] **Step 4: Run** the domain and web tests: `pnpm vitest run packages/domain apps/web`. Expected: PASS. The
  `progress()` change also moves a delayed mid-game game into the live section of `watchOrder` and the strip, and lets
  the Remote's stage map show its score (`StageMap.tsx:103`). If a web test pinned the old behaviour, change its
  expectation, not the code: the new behaviour is the spec's.
- [ ] **Step 5:** `CONTEXT.md`, Game state section, after **GameSnapshot**: the spec's **Game time** row.
- [ ] **Step 6:** `pnpm check`, then commit
  `feat(domain): game time orders two snapshots of one game; a game delayed mid-game is live`.

---

### Task 3: `LiveGame` decides one game's state

**Files:**
- Create: `packages/domain/src/LiveGame.ts`, `packages/domain/src/LiveGame.test.ts`
- Modify: `CONTEXT.md` (Game state section: **Live game**, **Stale**)

**Interfaces:**
- Consumes: `GameSnapshot.gameTime`, `GameSnapshot#progress()`.
- Produces, in `LiveGame.ts`:

```ts
/** One game as the Hub follows it: its latest snapshot and its state. */
export class LiveGame extends Data.Class<{ readonly snapshot: GameSnapshot; readonly state: LiveGameState }> {
  /** A live game no snapshot has reached for this long is stale. */
  static readonly staleAfter: Duration.Duration // 90 seconds
  /** An upcoming game is current from this long before kickoff. */
  static readonly currentBefore: Duration.Duration // 30 minutes
  /** A game's first snapshot, always taken. */
  static start(snapshot: GameSnapshot, now: DateTime.Utc): LiveGame
  /** The live game after `snapshot` arrives at `now`, or none when it is behind in game time. */
  receive(snapshot: GameSnapshot, now: DateTime.Utc): Option.Option<LiveGame>
  /** The live game once `now` has passed its stale time, or none when nothing changes. */
  tick(now: DateTime.Utc): Option.Option<LiveGame>
  /** When a live game goes stale; none in every other state. */
  staleAt(): Option.Option<DateTime.Utc>
  /** Live, stale, or upcoming with kickoff within `currentBefore` of `now`. */
  isCurrent(now: DateTime.Utc): boolean
}

/** Where a live game is: upcoming, live (last updated at), stale (last updated at), or over. */
export type LiveGameState = Data.TaggedEnum<{
  Upcoming: {}
  Live: { readonly updatedAt: DateTime.Utc }
  Stale: { readonly lastUpdatedAt: DateTime.Utc }
  Over: {}
}>
export const LiveGameState = Data.taggedEnum<LiveGameState>()
```

`LiveGameState` is declared above the class because the class's field type reads it. `start` and `receive` share a
private `stateOf(snapshot, now)` below the class: `progress()` upcoming → `Upcoming`, live → `Live { updatedAt: now }`,
over → `Over`. `tick`, `staleAt`, and `isCurrent` are each one `LiveGameState.$match`, so a state added later is a
compile error in each of them. Follow `GameEvent.ts` for the `Data.taggedEnum` idiom.

- [ ] **Step 1: Write the failing tests** in `LiveGame.test.ts`. Build snapshots with `snapshot()` from `TestGame.ts`,
  and times from `DateTime.makeUnsafe`. One `it` per cell of the spec's transition table, named for the cell
  (`"Live + live snapshot: Live, refreshed"`):

  | Current | Behind | Upcoming | Live | Over | Tick past `staleAt` |
  | --- | --- | --- | --- | --- | --- |
  | `Upcoming` | none | `Upcoming` | `Live { updatedAt: now }` | `Over` | none |
  | `Live` | none | (behind) none | `Live { updatedAt: now }` | `Over` | `Stale { lastUpdatedAt: updatedAt }` |
  | `Stale` | none | (behind) none | `Live { updatedAt: now }` | `Over` | none |
  | `Over` | none | (behind) none | (behind) none | `Over`, new snapshot | none |

  Also:
  - `start` with an upcoming, a live, and a final snapshot gives `Upcoming`, `Live { updatedAt: now }`, and `Over`.
  - A taken snapshot replaces `snapshot` (the new score is there).
  - A behind snapshot leaves `updatedAt` alone: `receive` is none, so the caller keeps the old live game.
  - An identical snapshot is taken and refreshes `updatedAt`.
  - `tick` at `updatedAt + 89 s` is none; at exactly `+ 90 s` it is `Stale`.
  - `staleAt` is `updatedAt + 90 s` for `Live` and none for the other three states.
  - `isCurrent`: `Live` and `Stale` are current; `Over` is not; `Upcoming` with kickoff exactly 30 minutes after
    `now` is current, and 30 minutes and 1 second after is not.
- [ ] **Step 2: Run** `pnpm vitest run packages/domain/src/LiveGame.test.ts`. Expected: FAIL (module does not exist).
- [ ] **Step 3: Implement** `LiveGame.ts` to the signatures above.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5:** `CONTEXT.md`, Game state section: the spec's **Live game** row (its meaning names the state type:
  "…its state (`LiveGameState`): upcoming, live, stale, or over") and **Stale** row.
- [ ] **Step 6:** `pnpm check` (knip will report `LiveGame` as unused until Task 4; if it fails the check, fold this
  task's commit into Task 4's instead of weakening knip). Commit
  `feat(domain): a live game decides its state from game time and staleness`.

---

### Task 4: `GameActors` delivers each snapshot to its game's actor

**Files:**
- Create: `apps/hub/src/game/GameActors.ts`, `apps/hub/src/game/GameActors.test.ts`
- Modify: `CONTEXT.md` (Data and video, or Game state, section: **Game actor**)

**Interfaces:**
- Consumes: `LiveGame.start`, `liveGame.receive`, `GameSnapshot`, `GameId`.
- Produces, in `GameActors.ts`:

```ts
/** The game actors: one cluster entity per game, each deciding its game's live state from the snapshots sent to it. */
export class GameActors extends Context.Service<
  GameActors,
  {
    /** Sends a snapshot to its game's actor and waits until the actor has taken or ignored it. */
    readonly receive: (snapshot: GameSnapshot) => Effect.Effect<void>
    /** Every running actor's live game, by game id. */
    readonly liveGames: Effect.Effect<ReadonlyMap<GameId, LiveGame>>
    readonly changes: Stream.Stream<ReadonlyMap<GameId, LiveGame>>
  }
>()("sportal/hub/GameActors") {
  /** The actors on a single-process cluster that stores nothing. */
  static readonly layer: Layer.Layer<GameActors>
}
```

File layout, in this order (AGENTS.md "a service file reads: service declaration, its layer, then private helpers"):

```
GameActors (service class, static layer)
  layer = Layer.effect(GameActors, <client: Game.client, liveGames, changes from LiveGames>)
          .pipe(Layer.provide(gameEntity), Layer.provideMerge(LiveGames.layer), Layer.provide(cluster))
Game         = Entity.make("Game", [Receive])          Receive = Rpc.make("Receive", { payload: { snapshot: GameSnapshot } })
gameEntity   = Game.toLayer(<activate>, { maxIdleTime: "5 minutes", disableFatalDefects: true })
LiveGames    private Context.Service: a SubscriptionRef<ReadonlyMap<GameId, LiveGame>>, with set(id, liveGame) and remove(id)
cluster      the Task 1 composition
```

Entity activation (one per game id, from `Entity.CurrentAddress`):

```
state ← SubscriptionRef.make<Option<LiveGame>>(none)
fork in scope: changes(state) → each Some(liveGame) → LiveGames.set(id, liveGame)
finalizer: LiveGames.remove(id)
Receive({ snapshot }):
  snapshot.id ≠ entity id → Effect.die (routing makes this a bug)
  SubscriptionRef.update(state, current → match current: none → some(start(snapshot, now)),
                                                       some(g) → g.receive(snapshot, now) orElse some(g))
  the step runs under Effect.catchDefect: log at Error with the cause and the encoded snapshot, keep the state, reply
```

`now` is read with `DateTime.now` before the update; the update itself is pure. `receive` on the client side maps any
cluster error to the logged, counted, succeeding path in "Spec refinements".

- [ ] **Step 1: Write the failing tests** in `GameActors.test.ts`. Every case provides `GameActors.layer` and runs
  under `it.effect` on the `TestClock`. If Task 1 found a request needs `TestClock` time to reply, a private
  `send(snapshot)` helper in the test file forks `receive`, adjusts the clock by that amount, and joins. Snapshots
  come from `snapshot()` in `TestGame.ts`, with distinct ids per game.
  - "a game's snapshots reach its live game": receive an upcoming then a live snapshot of game `1`; `liveGames` has
    game `1` in `Live`, with the live snapshot's score.
  - "a behind snapshot is ignored": receive period 2, then period 1; the live game still holds period 2.
  - "each game has its own live game": receive snapshots of games `1` and `2`; both are in `liveGames` with their own
    snapshots.
  - "changes publishes each new live game": collect `changes` while receiving two snapshots; the last value has the
    second snapshot.
  - "a defect in one game leaves the others, the sender, and its last good live game alone": receive good snapshots
    for games `1` and `2`; then send game `2`'s snapshot straight to game `1`'s entity with `Game.client` (exported
    for the test only if no other route reaches it; prefer reaching it through the test layer's `Sharding`). The
    call succeeds; game `1` still holds its last good snapshot; game `2` is unchanged; a further good snapshot for
    game `1` is taken.
  - "after the layer is rebuilt a game is current on its next snapshot": receive in one `Effect.provide(GameActors.layer)`,
    then in a fresh one; the second starts with an empty `liveGames` and has the game after one snapshot.
  - Pin, "requests are volatile": receive 100 snapshots; this needs no `MessageStorage` beyond the no-op one (the
    layer has no other), so it passes only while `Receive` is not persisted.
- [ ] **Step 2: Run** `pnpm vitest run apps/hub/src/game/GameActors.test.ts`. Expected: FAIL (module does not exist).
- [ ] **Step 3: Implement** to the shape above. Reuse nothing from the spike.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5:** `CONTEXT.md`: the spec's **Game actor** row, in the Game state section after **Stale**.
- [ ] **Step 6:** `pnpm check`, then commit `feat(hub): each game's snapshots go to its own game actor`.

---

### Task 5: Actors go stale on their own, and live as long as their game is current

**Files:**
- Modify: `apps/hub/src/game/GameActors.ts`, `apps/hub/src/game/GameActors.test.ts`

**Interfaces:**
- Consumes: `liveGame.tick`, `liveGame.staleAt`, `liveGame.isCurrent`, `Entity.keepAlive`.
- Produces: no new exports. Two more streams forked in each entity's scope, both over `SubscriptionRef.changes(state)`:

```
timer:      changes → filterMap(staleAt) → switchMap(at → sleep until at (Clock), then
                                                 SubscriptionRef.update(state, g → g.tick(now) orElse g))
keep-alive: changes → map(isCurrent(now)) → changes (dedupe) → Entity.keepAlive(current)
```

`switchMap` is what restarts the timer on every change: a refresh cancels the old sleep. `tick` checks `now` against
the current state's `staleAt`, so a sleep that finishes just after a refresh changes nothing. Find the exact
`Stream` combinators in `node_modules/effect/ai-docs/src/03_stream/` before writing; if `switchMap` has another name in
Effect 4, use that.

- [ ] **Step 1: Write the failing tests**, in a `describe("over time")`:
  - "a live game nobody updates is stale at 90 seconds": receive a live snapshot; `TestClock.adjust("89 seconds")`, still
    `Live`; adjust 1 more second, `Stale` with `lastUpdatedAt` the receive time.
  - "a refreshed game's timer moves with it": receive live at 0 s and again at 60 s; at 120 s still `Live`; at 150 s
    `Stale`.
  - "a stale game is live again on its next snapshot": stale at 90 s, receive at 100 s, `Live` with `updatedAt` 100 s.
  - "an upcoming or over game never goes stale": each sits for 10 minutes of `TestClock` time without a timer change
    (the over game's actor may idle out; assert on what `changes` emitted, not on `liveGames`).
  - Pin, "a live game outlasts 5 idle minutes": receive a live snapshot, then adjust 10 minutes; it is still in
    `liveGames` (as `Stale`).
  - Pin, "a final game is gone 5 minutes after its last snapshot": receive a final snapshot; at 4:59 it is in
    `liveGames`; at 5:00 (plus any time Task 1 found idling needs) it is not.
  - Pin, "an upcoming game kicking off within 30 minutes is kept alive; one hours away is not": two games, kickoffs
    at +20 minutes and +3 hours, each sent one snapshot; after 10 minutes only the first is in `liveGames`.
- [ ] **Step 2: Run** the file. Expected: the new cases FAIL; Task 4's PASS.
- [ ] **Step 3: Implement** the two streams.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5:** `pnpm check`, then commit `feat(hub): a game actor goes stale on its own and stays while its game is current`.

---

### Task 6: Ingest publishes the slate from the actors, in both modes

**Files:**
- Modify: `apps/hub/src/ingest/Ingest.ts`, `apps/hub/src/ingest/Ingest.test.ts`
- Modify: `apps/hub/src/HubMode.ts`
- Modify: `apps/hub/src/main.test.ts` (only if Step 6 finds the shutdown bound broken)

**Interfaces:**
- Consumes: `GameActors.receive`, `GameActors.liveGames`.
- Produces: `Ingest.layer(leagues)` now requires `GameActors` as well as `Provider`. `Ingest`'s service shape is
  unchanged.

Inside the `Ingest.poll` span Task 3 of the telemetry plan made, after the successes are stored in `byLeague`:

```
games ← leagues.flatMap(byLeague)                  (as today: the slate's games and order)
Effect.forEach(the games this poll returned, gameActors.receive, { concurrency: "unbounded", discard: true })
live  ← gameActors.liveGames
slate = games.map(g → live.get(g.id)?.snapshot ?? g)  (Option.fromNullishOr + getOrElse, not ?.)
SubscriptionRef.set(current, slate)
```

Only the games this poll returned are sent; a failed league's kept games are not resent, so they go stale 90 s later.

- [ ] **Step 1: Change the test setup, not the tests.** Each existing case's layer gains `GameActors.layer`:
  `Ingest.layer(["fbs"]).pipe(Layer.provide([scripted(…), GameActors.layer]))`. Run the file; the existing cases fail
  only because `Ingest` does not yet use `GameActors` (an unused service is not an error, so they may pass: that is
  fine).
- [ ] **Step 2: Write the failing tests**:
  - "the slate keeps the poll's order": a poll returns games `3`, `1`, `2`; the slate's ids are `3`, `1`, `2`.
  - "the slate takes each game's snapshot from its live game": poll 1 returns game `1` live in period 2; poll 2
    returns game `1` in period 1 (behind). After poll 2 the slate's game `1` is still period 2.
  - "a poll's snapshots reach the actors": after one poll, `GameActors.liveGames` has every game it returned.
  - "a failed league's games are not resent": poll 1 returns a live game; poll 2 fails; 90 s after poll 1 the game's
    live game is `Stale` and the slate still shows its last snapshot.
- [ ] **Step 3: Run** `pnpm vitest run apps/hub/src/ingest/Ingest.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 4: Implement** the change above.
- [ ] **Step 5: Wire `HubMode.ts`.** In `live()`, `Ingest.layer(leagues)` gets
  `Layer.provide([EspnProvider.layer, GameActors.layer])`. In `scripted()`, the same with `ScenarioProvider.layer(name)`,
  inside the `Layer.provide(ScenarioClock.layer(speed))` that already covers Ingest, so the actors run on scenario
  time. Extend the comment there ("Ingest, the scenario, and Watch share one clock") to name the game actors.
- [ ] **Step 6: Run** `pnpm vitest run apps/hub`. Expected: PASS, including `main.test.ts`'s shutdown bound. If the
  Hub now takes longer than the bound to stop, the composition's `entityTerminationTimeout` is not applied: fix it
  there, not in the test.
- [ ] **Step 7:** `pnpm check`, then commit `feat(hub): Ingest sends each poll through the game actors and publishes the slate from them`.

---

### Task 7: A game's life can be read back from Grafana

**Files:**
- Modify: `apps/hub/src/game/GameActors.ts`, `apps/hub/src/game/GameActors.test.ts`
- Modify: `telemetry/dashboards/hub.json`
- Modify: `docs/specs/2026-10-04-game-actors-design.md`, `docs/adr/0006-live-games-are-actors.md`,
  `docs/technical-spec.md`, `docs/game-day-checklist.md`

**Interfaces:**
- Produces: the spans, logs, and metrics in the spec's Telemetry table, with the names in Global Constraints. Metrics
  are module-level constants below `GameActors`, their only user, as the telemetry plan did in `Ingest.ts`.

| Where | What |
| --- | --- |
| Entity activation | `Effect.annotateLogsScoped({ game })`; once the first snapshot is taken, `league` and `matchup` too (annotate each handler run and timer step from the live game, since the activation does not know the league yet) |
| Entity start and finalizer | Log "started" and "stopped": Info when the live game is current, Debug otherwise (see refinements). `sportal_game_actors` up and down |
| Each change of state tag | Info `"<from> → <to>"` with game time (period and clock) and seconds since the last update; `sportal_transitions{from,to}` |
| Each snapshot | Debug "taken" or "behind" with both game times; `sportal_snapshots{outcome}` |
| A defect | Error with the cause and `Schema.encodeSync(GameSnapshot)(snapshot)`; `sportal_game_defects` |
| `LiveGames` changes | `sportal_live_games{state}`, recomputed from the registry on every change |
| `GameActors.receive` | `Effect.fn("GameActors.receive")` span with `sportal.game`, timed into `sportal_receive_duration`. The entity's handler is a span `Game.receive` (check first whether cluster already makes one per RPC; if it does, annotate that one instead of adding a second) |

The from/to of a transition is the state tag before and after an update. Compute it where the update happens, from
the two `LiveGame`s, with `LiveGameState.$match`, not by comparing strings in several places.

- [ ] **Step 1: Write the failing tests** in a `describe("telemetry")`, capturing logs with a recording `Logger`
  provided with `Logger.layer([…], { mergeWithExisting: true })`, the same way the telemetry plan's
  `Telemetry.test.ts` does, and spans with its recording `Tracer`:
  - "a transition is logged with the game's annotations": upcoming then live; one Info message containing
    `Upcoming → Live`, annotated `game: "1"`, `league: "fbs"`, `matchup: "AWAY at HOME"`.
  - "going stale is logged": the 90 s case; one Info `Live → Stale`.
  - "a behind snapshot is logged at Debug and counted": `sportal_snapshots` with `outcome: "behind"` is 1.
  - "a defect is logged with the snapshot that raised it": the Task 4 defect case; one Error message whose
    annotations or message include the encoded snapshot's id.
  - "receive is a span under the caller's": inside `Effect.withSpan("caller")`, receive one snapshot; a
    `GameActors.receive` span has `caller` as its parent.
  - "live games are counted by state": two live games and one upcoming give `sportal_live_games` 2 for `Live` and 1
    for `Upcoming`.
- [ ] **Step 2: Run** the file. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the table above.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Dashboard.** `pnpm telemetry`, then in the worktree
  `SPORTAL_OTLP_URL=http://localhost:4318 SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_SCENARIO_SPEED=10 pnpm --filter @sportal/hub dev`.
  In Grafana, add a "Game actors" row to the Hub dashboard: live games by state over time; snapshots taken and behind;
  defects; receive latency p50 and p95; and a logs panel of transitions for a chosen game (a `game` variable over the
  Loki label). Export the JSON over `telemetry/dashboards/hub.json` as the telemetry plan's Task 4 did, then
  `pnpm format`.
- [ ] **Step 6: By hand.** With the scenario running, the row fills with transitions. Staleness needs a provider
  that stops answering. First read `ScenarioProvider.ts` to see what it returns after its timeline ends: if it keeps
  returning the last snapshots, every game is refreshed on every poll and never goes stale, so a scenario cannot show
  it. In that case, check staleness on the live day instead: with a game live, run the Hub against ESPN with
  telemetry on, cut the network for two minutes, and restore it. ESPN polls fail, the kept games are not resent, the
  row shows `Live → Stale` about 90 s in, and `Stale → Live` on the first poll after the network returns. Write
  whichever check you used into the checklist row in Step 7.
- [ ] **Step 7: Documents.**
  - The spec: apply the "Spec refinements" table (lifecycle, `SubscriptionRef` and its three streams, keep-alive
    re-evaluated on each change, the composition's two settings, `receive`'s cluster errors, the glossary note, the
    postponed edge), and Task 1's findings. Status line: "Approved 2026-10-04; refined while planning".
  - ADR 0006: status `Accepted`, and the composition's two settings under Decision.
  - `docs/technical-spec.md`: §3's diagram and §5.1 gain `GameActors` between Ingest and the slate; §4.2's tree gains
    `game/GameActors.ts` (the game actors: one cluster entity per game) and, under the domain package, `LiveGame.ts`
    (one game as the Hub follows it).
  - `docs/game-day-checklist.md`: a row "Run `pnpm telemetry` and the Hub with `SPORTAL_OTLP_URL=http://localhost:4318`,
    and open the Game actors row; then do the Step 6 staleness check" → "Live games by state fill; a game that stops
    updating turns stale about 90 seconds later and live again on its next snapshot; one game's transitions read in
    order in its logs panel".
- [ ] **Step 8:** `pnpm check`, then commit `feat(hub): a game's life reads back from its logs, spans, and metrics; docs for game actors`.

## Self-review

- Spec coverage: game time and the delayed fix (T2); `LiveGame` states, transitions, tick, queries, constants (T3);
  the entity, volatile messages, entity state, defects, registry, service (T4); timer and lifecycle (T5); the
  composition, proved first (T1), with each setting pinned (T4 volatile, T5 idle and keep-alive, T4 defects, T6
  shutdown); Ingest and Hub mode (T6); telemetry, dashboard, and the by-hand check (T7); restarts and failures (T4
  rebuilt layer, T6 failed league); documents that change (T2, T3, T4, T7). Not in this piece, per the spec: FastCast,
  showing staleness, watchability or lulls in actors, events, persistence, several processes.
- Names used across tasks: `GameSnapshot.gameTime`, `GameSnapshot#matchup`, `LiveGame.start`, `#receive`, `#tick`,
  `#staleAt`, `#isCurrent`, `LiveGame.staleAfter`, `LiveGame.currentBefore`, `LiveGameState` (`Upcoming`, `Live`,
  `Stale`, `Over`), `GameActors.layer`, `#receive`, `#liveGames`, `#changes`, `Game`, `Receive`, `LiveGames`.
