# Learned Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a game on any network YouTube TV carries plays it in the desktop shell, without a hand-filled channel map: the first time a network is seen its tile opens YouTube TV's live guide, the user picks the channel once, and the Hub remembers it across restarts.

**Architecture:** Domain logic moves onto the domain types (`stage.apply`, `GameSnapshot.watchOrder`), and that becomes a rule. A new `ChannelLineup` holds the channel carriages one source has learned and resolves each game's `ChannelAvailability` (carried, unlearned, or not carried). The Hub gains a `Database` module (SQLite through `effect/sql`) whose stores each own their migrations; the first is the `ChannelStore`. The YouTube TV source keeps its lineup in a ref backed by that store and learns channels through a `channels` API group, decoding each picked address with a `LiveChannelUrl` schema. `stage.apply` turns availability into stream, picking, or data tiles, and `stage.refresh` re-resolves every Display's tiles whenever the lineup changes. The shell lays a guide view over each picking tile and reports the address the view lands on through the shell bridge; the web UI turns that report into `POST /api/channels/learn`.

**Tech Stack:** TypeScript 6, Effect 4.0.0 (`effect`, `effect/sql`, `effect/http-api`), `@effect/sql-sqlite-node` 4.0.0 on Node 24's `node:sqlite`, `@effect/platform-node` 4.0.0, React 19, Electron 44 (castlabs Widevine build), Vitest 5, Biome 2.5, dependency-cruiser 18, knip 6.

**Spec:** `docs/specs/2026-10-03-learned-channels-design.md` (approved 2026-10-03; revised with this plan's review).

**Status of the code in this plan:** proposed, not yet built. Every code block is written against the code on `main` at `c360d68` and has not been compiled or run. Per-file test counts are what each step should produce; if a step's output differs, stop and reconcile before moving on. The desktop shell's guide reporting can only be proven against real YouTube TV, which the game-day checklist rows added in Task 10 do.

## Global Constraints

- Read `AGENTS.md` before every task. Its rules on file layout and in-file order are requirements, not style.
- Effect is pinned to exactly `4.0.0`, and `@effect/sql-sqlite-node` to exactly `4.0.0`. Do not write Effect code from memory; consult `node_modules/effect/ai-docs/src/` (SQL: `40_sql`, HTTP: `51_http-server`) and the sources under `node_modules/effect/src/`.
- TypeScript stays on `^6`. Node 24 via `mise` (`mise exec -- <command>` if your shell has not activated mise).
- `pnpm check` must pass before every commit.
- Domain vocabulary is binding: every exported type name is a term in `CONTEXT.md`. A new term gets its row in the same commit. Channel concepts are named Channel-first (`ChannelCarriage`, `ChannelLineup`, `ChannelAvailability`, `ChannelUrlRefused`, `ChannelStore`). The word "answer" is not domain language.
- An operation on a domain type lives on the type, as a method or static of its class (from Task 1, an `AGENTS.md` rule). No exported loose functions over a domain type.
- Banned file and folder names: `utils`, `helpers`, `common`, `shared`, `misc`, `lib`, `types`, `constants`, `models`, `interfaces`, `index.ts`.
- In the Hub, only `main.ts` and tests name concrete adapters (`EspnProvider`, `YouTubeTv`, and from Task 3 `SqlChannelStore` and `Database`).
- Each SQL store owns its migrations and records them in its own table (`<store>_migrations`) through `Database.migrate`.
- Provider web players are loaded unmodified: no script injection, no request rewriting, no capture. The shell sets a view's address, bounds, and mute flag, and reads the address it navigated to; nothing else.
- The address stored for a channel is its live address, `https://tv.youtube.com/watch/<id>?vp=0gEEEgIwAQ%3D%3D`. A stored "from the beginning" address would replay every later game from its kickoff.
- A channel is remembered per network and source. If game-day checklist row 17 shows an old address plays the old programme, the key becomes game, network, and source; only the store's key and `ChannelLineup.availabilityOf` change.
- The Hub binds to `127.0.0.1`. Poll ESPN no faster than `Cadence` allows.

## Where this plan differs from the spec

Refinements made while planning, for review with the plan. None changes what the user sees.

- **Domain logic lives on the domain types, and existing logic is converted first** (Task 1). `Stage.apply(stage, …)` becomes `stage.apply(…)`, `Stage.initial` a static, `Game.isLive(game)` the method `game.isLive()`. Decided in review of this plan.
- **There is no `Slate.ts`.** Its only content, the watch order, compares two games, so it becomes the static `GameSnapshot.watchOrder: Order<GameSnapshot>`, used as `[...slate].sort(GameSnapshot.watchOrder)`. A slate is still a glossary term, but in code it is an array of snapshots, not a type, so there is nothing for a `Slate` class to own yet. `SlateWindow` (Tracker) is where a `Slate.ts` returns (Task 1).
- **`Network` lives in `Game.ts`, and the source concepts in a new domain `Source.ts`.** There is no `Broadcast.ts`: no type here is a Broadcast (Task 2).
- **Channel-first names.** The spec's channel answer is a `ChannelCarriage`, `Availability` is `ChannelAvailability`, and `NotAChannel` is `ChannelUrlRefused` (Task 2).
- **`ChannelLineup` resolves availability.** The carriages one source has learned, with its source name and guide, as a `Schema.Class` with `availabilityOf(game)`, `record(carriage)`, and `forget(network)`. The source keeps a `SubscriptionRef<ChannelLineup>`, and the Hub's `Source` port exposes `lineup: Effect<ChannelLineup>` rather than a lookup function (Tasks 2, 4, 5).
- **`ChannelAvailability` is a `Data.taggedEnum`**, not a schema: it never crosses the wire (tiles do), and the tagged enum gives it constructors on the type (Task 2).
- **One store per concept instead of one `Store` port.** A `Database` module owns the SQLite client and `migrate(store, migrations)`; the `ChannelStore` port (`carriages`, `record`, `forget`) sits in `apps/hub/src/source/` beside its only consumer, and its adapter `SqlChannelStore` owns its migration (Task 3).
- **The SQLite risk does not exist.** `@effect/sql-sqlite-node` 4.0.0 depends only on `effect` and runs on `node:sqlite`; nothing native is installed (Task 3).
- **`canonical(url)` is replaced by the `LiveChannelUrl` schema in `YouTubeTv.ts`**, which decodes any channel address to its live address; `learn` maps a decode failure to `ChannelUrlRefused` (Task 5).
- **A stream tile carries its whole `Channel`**, and a picking tile carries the `SourceName`. The UI needs the channel's network for **wrong channel** and the source's name for its labels. Tile variants stay `TaggedStruct`s: nothing operates on a single tile apart from the `Stage` that holds it (Task 4).
- **A guide view reports each distinct channel address**, not only the first, so a pick the Hub refused can be retried (Task 7).
- **Subframe guarding applies to the shell window only**, not provider views (Task 8, recorded in ADR 0002).
- **`WidevineUnavailable` carries the underlying error as its `cause`** rather than a code (Task 8).
- **`ChannelPick`** (`{ tile, url }`) is a named schema in the bridge contract, with a glossary row, because the preload, the shell, and the web UI all use it (Task 7).

## Out of scope

- The stream budget and what happens at the provider's concurrent-stream limit.
- Regional feeds: a learned CBS channel is the user's local CBS, which may be showing a different regional game from the one clicked. A known limitation; the Tracker's availability work handles it.
- Learning a channel in a plain browser.
- Saving the Stage across Hub restarts (only channel carriages are stored).
- Converting non-domain modules (Hub services, the ESPN adapter's payload helpers, web components) to the new rule: it governs domain types only.
- Every Tracker, Stage, Director, and Reach item in `docs/plans/2026-10-03-thin-vertical-slice.md`, other than the deferred findings this plan names.

## File map

```
sportal/
├── AGENTS.md, CONTEXT.md, .gitignore, .dependency-cruiser.cjs           Tasks 1–4, 7, 10
├── docs/game-day-checklist.md, docs/adr/0002-…, docs/plans/…slice.md  Task 10
├── packages/
│   ├── domain/src/
│   │   ├── Game.ts (+ test)             isLive(), watchOrder                         Task 1
│   │   │                                Network; broadcasts: Array<Network>          Task 2
│   │   ├── Slate.ts (+ test)            deleted (watch order moves to GameSnapshot)  Task 1
│   │   ├── Source.ts (+ test)           SourceName, Channel, ChannelCarriage,
│   │   │                                ChannelLineup, ChannelAvailability,
│   │   │                                ChannelUrlRefused                            Task 2
│   │   └── Stage.ts (+ test)            apply/initial on the class                   Task 1
│   │                                    PickingChannel tile, availability, refresh  Task 4
│   └── api/src/
│       ├── SportalApi.ts                channels group                               Task 6
│       └── ShellBridge.ts               role, ChannelPick, onChannelPicked           Task 7
└── apps/
    ├── hub/
    │   ├── package.json                 @effect/sql-sqlite-node 4.0.0                Task 3
    │   └── src/
    │       ├── database/Database.ts (+ test)   SQLite client, migrate()              Task 3
    │       ├── source/ChannelStore.ts          the port                              Task 3
    │       ├── source/SqlChannelStore.ts (+ test)  adapter; owns its migration       Task 3
    │       ├── source/Source.ts, YouTubeTv.ts (+ test)   lineup, LiveChannelUrl      Tasks 4–5
    │       ├── source/youtube-tv-channels.json   deleted                             Task 4
    │       ├── ingest/Cadence.ts                 game.isLive()                       Task 1
    │       ├── stage/StageSessions.ts (+ test)   stage.apply, availability, refresh  Tasks 1, 4–6
    │       ├── http/HubServer.ts (+ test)        channel handlers, /api/live test    Task 6
    │       └── main.ts                           data dir, database, store, source   Tasks 3–5
    ├── desktop/src/
    │   ├── preload/ShellBridge.ts                onChannelPicked                     Task 7
    │   └── main/TileViews.ts (+ test)            guide views report picks            Tasks 7–8
    │       ProviderSession.ts (+ test)           confine                             Task 8
    │       main.ts                               picks to the window; findings       Tasks 7–8
    └── web/src/
        ├── slate/SlateView.tsx                   watchOrder, isLive()                Task 1
        ├── hub/Live.ts (+ test)                  Stage.initial                       Task 1
        ├── hub/HubClient.ts                      channel commands                    Task 9
        └── stage/StageView.tsx                   picking tiles, wrong channel        Tasks 4, 7, 9
```

---

### Task 1: Domain logic lives on the domain types

This task changes no behaviour. It moves the existing domain functions onto the types they operate on, writes the rule into `AGENTS.md`, and updates every caller, so the reviewer can judge the convention on its own before any channel code uses it.

**Files:**
- Modify: `AGENTS.md` (the rule)
- Modify: `packages/domain/src/Game.ts` (`isLive()` method, `watchOrder` static)
- Test: `packages/domain/src/Game.test.ts` (new)
- Delete: `packages/domain/src/Slate.ts`, `packages/domain/src/Slate.test.ts`
- Modify: `packages/domain/src/Stage.ts` (`initial` static, `apply` method)
- Test: `packages/domain/src/Stage.test.ts`
- Modify: `apps/hub/src/ingest/Cadence.ts`, `apps/hub/src/stage/StageSessions.ts`, `apps/web/src/slate/SlateView.tsx`, `apps/web/src/hub/Live.ts`, `apps/web/src/hub/Live.test.ts`

**Interfaces:**
- Produces:
  - `GameSnapshot#isLive(): boolean` — live or at halftime.
  - `GameSnapshot.watchOrder: Order.Order<GameSnapshot>` — live first, then upcoming (scheduled or delayed) by kickoff, then everything over.
  - `Stage.initial: Stage` — four empty tiles, audio focus on the first.
  - `Stage#apply(command: StageCommand, locate: (game: GameId) => Option<StreamLocator>): Result<Stage, StageRejection>` — same behaviour as today's `Stage.apply(stage, command, locate)`. Task 4 replaces `locate` with availability.
- Removed: `Game.isLive`, `Slate.inWatchOrder`, `Stage.apply` (the function), `Stage.initial` (the module constant).

- [ ] **Step 1: Write the rule**

Apply this change to `AGENTS.md`:

```diff
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -36,8 +36,8 @@ A reader opens a file to see the thing it is named for. Keep it that way.
 1. The main export comes first. No preamble of types, constants, and small helpers above it.
 2. Private helpers go **below** the code that uses them, as hoisted `function` declarations, in the
    order they are first used.
-3. A helper used once and a few lines long is inlined. A helper that is really an operation on another
-   concept lives in that concept's module.
+3. A helper used once and a few lines long is inlined. A helper that is really an operation on another
+   concept is a method or static of that concept's type.
 4. Do not declare an interface or type alias for an options bag, a return shape, a callback, or
    component props used in one place. Write the shape inline in the signature.
 5. A service file reads: service declaration, its layer, then private helpers.
@@ -48,6 +48,12 @@ A reader opens a file to see the thing it is named for. Keep it that way.
 ## How code is written
 
 - Logic is a pure function or an `Effect`. No bare promises or `async` outside framework edges (React
   handlers, Electron callbacks).
+- An operation on a domain type lives on the type: a method or static of its class (`Schema.Class`,
+  `Schema.TaggedClass`), or, for a union that never crosses the wire, the constructors and `$match` of
+  its `Data.taggedEnum`. Write `stage.apply(command, …)` and `GameSnapshot.watchOrder`, never an
+  exported `apply(stage, …)`. A domain module exports no loose functions over its types; a private
+  helper below the class that only the class uses is fine. A schema a class reads when it is defined
+  (a field's type) goes above the class, because the class evaluates it then.
 - Expected failures are tagged errors in the error channel. Nothing is caught and ignored.
```

The technical spec's matching principles were updated together with this plan; no other document changes in this task.

- [ ] **Step 2: Write the failing game test**

Create `packages/domain/src/Game.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import { snapshot } from "./TestGame.ts"

describe("GameSnapshot.isLive", () => {
  it.each(["live", "halftime"] as const)("is live when %s", (status) => {
    assert.isTrue(snapshot({ status }).isLive())
  })

  it.each(["scheduled", "delayed", "final", "postponed", "canceled"] as const)(
    "is not live when %s",
    (status) => {
      assert.isFalse(snapshot({ status }).isLive())
    }
  )
})

describe("GameSnapshot.watchOrder", () => {
  it("puts live games first, then upcoming by kickoff, then finished", () => {
    const ordered = [
      game("final", "final", "2026-10-03T16:00:00Z"),
      game("late", "scheduled", "2026-10-03T23:30:00Z"),
      game("halftime", "halftime", "2026-10-03T19:30:00Z"),
      game("early", "scheduled", "2026-10-03T20:00:00Z"),
      game("live", "live", "2026-10-03T16:00:00Z")
    ].sort(GameSnapshot.watchOrder)
    assert.deepStrictEqual(
      ordered.map((g) => g.id),
      ["live", "halftime", "early", "late", "final"]
    )
  })
})

function game(id: string, status: GameStatus, kickoff: string) {
  return snapshot({ id: GameId.make(id), status, kickoff: DateTime.makeUnsafe(kickoff) })
}
```

The watch-order case is `Slate.test.ts`'s one test, moved.

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm vitest run packages/domain/src/Game.test.ts`
Expected: FAIL — `isLive is not a function`, and `GameSnapshot.watchOrder` is undefined.

- [ ] **Step 4: Put the operations on `GameSnapshot`**

Replace `packages/domain/src/Game.ts`:

```ts
import { DateTime, Order, Schema } from "effect"
import { LeagueId } from "./League.ts"
import { Situation } from "./Situation.ts"
import { Team } from "./Team.ts"

export const GameId = Schema.String.pipe(Schema.brand("GameId"))
export type GameId = typeof GameId.Type

export const GameStatus = Schema.Literals([
  "scheduled",
  "live",
  "halftime",
  "delayed",
  "final",
  "postponed",
  "canceled"
])
export type GameStatus = typeof GameStatus.Type

const Side = Schema.Struct({ team: Team, score: Schema.Int, ranking: Schema.optional(Schema.Int) })

export class GameSnapshot extends Schema.Class<GameSnapshot>("sportal/GameSnapshot")({
  id: GameId,
  league: LeagueId,
  kickoff: Schema.DateTimeUtcFromString,
  status: GameStatus,
  period: Schema.Int,
  clock: Schema.String,
  home: Side,
  away: Side,
  broadcasts: Schema.Array(Schema.String),
  situation: Schema.optional(Situation)
}) {
  /** Live games first, then upcoming by kickoff, then everything that is over. */
  static readonly watchOrder: Order.Order<GameSnapshot> = Order.combine(
    Order.mapInput(Order.Number, (game: GameSnapshot) =>
      game.isLive() ? 0 : game.status === "scheduled" || game.status === "delayed" ? 1 : 2
    ),
    Order.mapInput(DateTime.Order, (game: GameSnapshot) => game.kickoff)
  )

  isLive(): boolean {
    return this.status === "live" || this.status === "halftime"
  }
}
```

Run: `git rm packages/domain/src/Slate.ts packages/domain/src/Slate.test.ts`
Expected: both files staged for deletion.

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm vitest run packages/domain/src/Game.test.ts`
Expected: `Tests  8 passed (8)`.

- [ ] **Step 6: Rewrite the Stage test in method form**

Replace `packages/domain/src/Stage.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Option, Result } from "effect"
import { GameId } from "./Game.ts"
import { Stage } from "./Stage.ts"

const bama = GameId.make("401856707")
const irish = GameId.make("401858250")
const onFox = () => Option.some({ _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" })
const nowhere = () => Option.none()

describe("Stage#apply", () => {
  it("assigns a streamable game as a stream tile", () => {
    const stage = Result.getOrThrow(Stage.initial.apply({ _tag: "Assign", tile: 1, game: bama }, onFox))
    assert.deepStrictEqual(stage.tiles[1], {
      _tag: "StreamTile",
      game: bama,
      locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/fox" }
    })
  })

  it("assigns a game with no stream as a data tile", () => {
    const stage = Result.getOrThrow(Stage.initial.apply({ _tag: "Assign", tile: 0, game: bama }, nowhere))
    assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: bama })
  })

  it("moves a game rather than showing it twice", () => {
    const first = Result.getOrThrow(Stage.initial.apply({ _tag: "Assign", tile: 0, game: bama }, onFox))
    const second = Result.getOrThrow(first.apply({ _tag: "Assign", tile: 2, game: bama }, onFox))
    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.strictEqual(second.tiles[2]?._tag, "StreamTile")
  })

  it("clears a tile and leaves the others", () => {
    const a = Result.getOrThrow(Stage.initial.apply({ _tag: "Assign", tile: 0, game: bama }, onFox))
    const b = Result.getOrThrow(a.apply({ _tag: "Assign", tile: 1, game: irish }, onFox))
    const c = Result.getOrThrow(b.apply({ _tag: "Clear", tile: 0 }, onFox))
    assert.strictEqual(c.tiles[0]?._tag, "Empty")
    assert.strictEqual(c.tiles[1]?._tag, "StreamTile")
  })

  it("moves audio focus", () => {
    const stage = Result.getOrThrow(Stage.initial.apply({ _tag: "FocusAudio", tile: 3 }, nowhere))
    assert.strictEqual(stage.audioFocus, 3)
  })

  it("rejects a tile that does not exist", () => {
    const result = Stage.initial.apply({ _tag: "FocusAudio", tile: 4 }, nowhere)
    assert.isTrue(Result.isFailure(result))
  })
})
```

- [ ] **Step 7: Run it to see it fail**

Run: `pnpm vitest run packages/domain/src/Stage.test.ts`
Expected: FAIL — `Stage.initial` is undefined (it is still a module constant, not a static).

- [ ] **Step 8: Put `initial` and `apply` on `Stage`**

Replace `packages/domain/src/Stage.ts`:

```ts
import { Option, Result, Schema } from "effect"
import { GameId } from "./Game.ts"
import { StreamLocator } from "./Stream.ts"

export const Tile = Schema.Union([
  Schema.TaggedStruct("Empty", {}),
  Schema.TaggedStruct("StreamTile", { game: GameId, locator: StreamLocator }),
  Schema.TaggedStruct("DataTile", { game: GameId })
])
export type Tile = typeof Tile.Type

export class Stage extends Schema.Class<Stage>("sportal/Stage")({
  tiles: Schema.Array(Tile),
  audioFocus: Schema.Int
}) {
  /** Four empty tiles, with audio focus on the first. */
  static readonly initial = new Stage({
    tiles: [{ _tag: "Empty" }, { _tag: "Empty" }, { _tag: "Empty" }, { _tag: "Empty" }],
    audioFocus: 0
  })

  /**
   * Applies a command. `locate` says where a game can be streamed from, if anywhere;
   * a game with no stream becomes a data tile.
   */
  apply(
    command: StageCommand,
    locate: (game: GameId) => Option.Option<StreamLocator>
  ): Result.Result<Stage, StageRejection> {
    if (command.tile < 0 || command.tile >= this.tiles.length) {
      return Result.fail(new StageRejection({ reason: "no-such-tile" }))
    }
    switch (command._tag) {
      case "Assign": {
        const tile: Tile = Option.match(locate(command.game), {
          onNone: () => ({ _tag: "DataTile", game: command.game }),
          onSome: (locator) => ({ _tag: "StreamTile", game: command.game, locator })
        })
        // A game appears in at most one tile: assigning it elsewhere moves it.
        const tiles = this.tiles.map((existing, index) =>
          index === command.tile
            ? tile
            : existing._tag !== "Empty" && existing.game === command.game
              ? empty
              : existing
        )
        return Result.succeed(new Stage({ tiles, audioFocus: this.audioFocus }))
      }
      case "Clear":
        return Result.succeed(
          new Stage({
            tiles: this.tiles.map((existing, index) => (index === command.tile ? empty : existing)),
            audioFocus: this.audioFocus
          })
        )
      case "FocusAudio":
        return Result.succeed(new Stage({ tiles: this.tiles, audioFocus: command.tile }))
    }
  }
}

export const StageCommand = Schema.Union([
  Schema.TaggedStruct("Assign", { tile: Schema.Int, game: GameId }),
  Schema.TaggedStruct("Clear", { tile: Schema.Int }),
  Schema.TaggedStruct("FocusAudio", { tile: Schema.Int })
])
export type StageCommand = typeof StageCommand.Type

export class StageRejection extends Schema.TaggedError<StageRejection>()(
  "StageRejection",
  { reason: Schema.Literals(["no-such-tile"]) },
  { httpApiStatus: 422 }
) {}

const empty: Tile = { _tag: "Empty" }
```

`initial` spells out its four empty tiles because a static is evaluated when the class is defined, before `empty` below it exists. `apply` reads `empty`, `StageCommand`, and `StageRejection` only when it runs, so they can stay below the class.

- [ ] **Step 9: Run it to see it pass**

Run: `pnpm vitest run packages/domain/src/Stage.test.ts`
Expected: `Tests  6 passed (6)`.

- [ ] **Step 10: Update the callers**

Apply this change to `apps/hub/src/ingest/Cadence.ts`:

```diff
--- a/apps/hub/src/ingest/Cadence.ts
+++ b/apps/hub/src/ingest/Cadence.ts
@@ -1,4 +1,4 @@
-import { type GameSnapshot, isLive } from "@sportal/domain/Game"
+import type { GameSnapshot } from "@sportal/domain/Game"
 import { DateTime, Duration } from "effect"
 
 /**
@@ -16,7 +16,7 @@ export function interval(
 }
 
 function normalInterval(slate: ReadonlyArray<GameSnapshot>, now: DateTime.Utc): Duration.Duration {
-  if (slate.some(isLive)) return Duration.seconds(10)
+  if (slate.some((game) => game.isLive())) return Duration.seconds(10)
   const soon = DateTime.add(now, { minutes: 30 })
   const kickoffSoon = slate.some(
     (game) => game.status === "scheduled" && DateTime.isLessThanOrEqualTo(game.kickoff, soon)
```

Replace `apps/hub/src/stage/StageSessions.ts`:

```ts
import type { GameId } from "@sportal/domain/Game"
import { Stage, type StageCommand, type StageRejection } from "@sportal/domain/Stage"
import { Context, Effect, Layer, Option, Result, type Stream, SubscriptionRef } from "effect"
import { Ingest } from "../ingest/Ingest.ts"
import { Source } from "../source/Source.ts"

export class StageSessions extends Context.Service<
  StageSessions,
  {
    readonly stage: Effect.Effect<Stage>
    readonly changes: Stream.Stream<Stage>
    dispatch(command: StageCommand): Effect.Effect<Stage, StageRejection>
  }
>()("sportal/hub/StageSessions") {
  static readonly layer = Layer.effect(
    StageSessions,
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const source = yield* Source
      const current = yield* SubscriptionRef.make(Stage.initial)

      const dispatch = Effect.fn("StageSessions.dispatch")(function* (command: StageCommand) {
        const slate = yield* ingest.slate
        const locate = (id: GameId) =>
          Option.fromNullishOr(slate.find((game) => game.id === id)).pipe(Option.flatMap(source.locate))
        // One atomic step: concurrent dispatches queue up, and a rejection leaves the Stage as it was.
        return yield* SubscriptionRef.modifyEffect(current, (stage) => {
          const result = stage.apply(command, locate)
          return Result.isFailure(result)
            ? Effect.fail(result.failure)
            : Effect.succeed([result.success, result.success] as const)
        })
      })

      return StageSessions.of({
        stage: SubscriptionRef.get(current),
        changes: SubscriptionRef.changes(current),
        dispatch
      })
    })
  )
}
```

Apply this change to `apps/web/src/slate/SlateView.tsx`:

```diff
--- a/apps/web/src/slate/SlateView.tsx
+++ b/apps/web/src/slate/SlateView.tsx
@@ -1,5 +1,4 @@
-import { type GameSnapshot, isLive } from "@sportal/domain/Game"
-import * as Slate from "@sportal/domain/Slate"
+import { GameSnapshot } from "@sportal/domain/Game"
 import { DateTime } from "effect"
 
 export function SlateView(props: {
@@ -16,7 +15,7 @@ export function SlateView(props: {
         </span>
       </header>
       <ul className="min-h-0 flex-1 overflow-y-auto">
-        {Slate.inWatchOrder(props.slate).map((game) => (
+        {[...props.slate].sort(GameSnapshot.watchOrder).map((game) => (
           <li key={game.id}>
             <button
               type="button"
@@ -25,7 +24,7 @@ export function SlateView(props: {
             >
               <SideLine side={game.away} />
               <span className="row-span-2 self-center text-right text-neutral-400 text-xs">
-                <span className={isLive(game) ? "block text-emerald-400" : "block"}>{statusText(game)}</span>
+                <span className={game.isLive() ? "block text-emerald-400" : "block"}>{statusText(game)}</span>
                 {game.broadcasts.join(" · ")}
               </span>
               <SideLine side={game.home} />
```

Apply this change to `apps/web/src/hub/Live.ts`:

```diff
--- a/apps/web/src/hub/Live.ts
+++ b/apps/web/src/hub/Live.ts
@@ -1,6 +1,6 @@
 import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
 import type { GameSnapshot } from "@sportal/domain/Game"
-import * as Stage from "@sportal/domain/Stage"
+import { Stage } from "@sportal/domain/Stage"
 import { Schema } from "effect"
 import { useSyncExternalStore } from "react"
 
```

Apply this change to `apps/web/src/hub/Live.test.ts`:

```diff
--- a/apps/web/src/hub/Live.test.ts
+++ b/apps/web/src/hub/Live.test.ts
@@ -1,10 +1,10 @@
 import { assert, describe, it } from "@effect/vitest"
-import * as Stage from "@sportal/domain/Stage"
+import { Stage } from "@sportal/domain/Stage"
 import { disconnected, reduce } from "./Live.ts"
 
 describe("Live.reduce", () => {
   it("replaces the stage and keeps the slate", () => {
-    const stage = new Stage.Stage({ tiles: Stage.initial.tiles, audioFocus: 2 })
+    const stage = new Stage({ tiles: Stage.initial.tiles, audioFocus: 2 })
     const next = reduce(disconnected, { _tag: "StageChanged", stage })
     assert.strictEqual(next.stage.audioFocus, 2)
     assert.strictEqual(next.slate, disconnected.slate)
```

The web UI receives snapshots and stages by decoding live messages with their schemas, so they arrive as class instances and `game.isLive()` works on them.

- [ ] **Step 11: Check**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean (no unused `Slate` exports remain), and every test passes.

- [ ] **Step 12: Commit**

```bash
git add AGENTS.md packages/domain/src apps/hub/src apps/web/src
git commit -m "refactor(domain): operations on domain types live on the types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Domain — networks, channel carriages, and the channel lineup

**Files:**
- Modify: `packages/domain/src/Game.ts` (adds `Network`; `broadcasts` becomes `Array<Network>`)
- Create: `packages/domain/src/Source.ts`
- Test: `packages/domain/src/Source.test.ts`
- Modify: `apps/hub/src/provider/espn/EspnProvider.ts` (brands network names)
- Modify: tests that build snapshots with networks: `apps/hub/src/http/HubServer.test.ts`, `apps/hub/src/ingest/Cadence.test.ts`, `apps/hub/src/ingest/Ingest.test.ts`, `apps/hub/src/provider/espn/EspnProvider.test.ts`, `apps/hub/src/stage/StageSessions.test.ts`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `Stream.StreamLocator` (`{ _tag: "WebView", url }`), `GameSnapshot` from Task 1.
- Produces, importable as `@sportal/domain/Game`:
  - `Network` — branded string schema and type; `Network.make("ESPN")`.
- Produces, importable as `@sportal/domain/Source` (the pure concepts of a video source; the Hub's `Source` port wraps them and imports them by name):
  - `SourceName` — `Schema.Literals(["YouTube TV"])`.
  - `Channel` — `{ network: Network, source: SourceName, locator: StreamLocator }`.
  - `ChannelCarriage` — `{ _tag: "Carried", channel: Channel } | { _tag: "NotCarried", network, source }`.
  - `ChannelLineup` — `Schema.Class` `{ source: SourceName, guide: StreamLocator, carriages: ReadonlyArray<ChannelCarriage> }` with:
    - `availabilityOf(game: GameSnapshot): ChannelAvailability` — a carried network wins; otherwise the first of the game's networks with no carriage is `Unlearned`; otherwise `NotCarried`.
    - `record(carriage): ChannelLineup` — replaces any carriage for the same network.
    - `forget(network): ChannelLineup`.
  - `ChannelAvailability` — `Data.TaggedEnum` with constructors `ChannelAvailability.Carried({ channel })`, `ChannelAvailability.Unlearned({ network, source, guide })`, `ChannelAvailability.NotCarried()`.
  - `ChannelUrlRefused` — tagged error, no fields, HTTP 422.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/src/Source.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Network } from "./Game.ts"
import { ChannelAvailability, type ChannelCarriage, ChannelLineup } from "./Source.ts"
import { snapshot } from "./TestGame.ts"

const espn = Network.make("ESPN")
const disney = Network.make("Disney+")
const espnPlus = Network.make("ESPN+")
const guide = { _tag: "WebView" as const, url: "https://tv.youtube.com/live" }
const espnChannel = {
  network: espn,
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn" }
}
const carried = { _tag: "Carried" as const, channel: espnChannel }
const notCarried = (network: Network) => ({
  _tag: "NotCarried" as const,
  network,
  source: "YouTube TV" as const
})

describe("ChannelLineup#availabilityOf", () => {
  it("is carried when the network has a channel", () => {
    assert.deepStrictEqual(
      lineup([carried]).availabilityOf(on(espn)),
      ChannelAvailability.Carried({ channel: espnChannel })
    )
  })

  it("is unlearned when nothing is recorded for the network", () => {
    assert.deepStrictEqual(
      lineup([]).availabilityOf(on(espn)),
      ChannelAvailability.Unlearned({ network: espn, source: "YouTube TV", guide })
    )
  })

  it("prefers a carried network over an earlier unlearned one", () => {
    assert.strictEqual(lineup([carried]).availabilityOf(on(disney, espn))._tag, "Carried")
  })

  it("asks about the first network with nothing recorded, skipping ones not carried", () => {
    assert.deepStrictEqual(
      lineup([notCarried(espnPlus)]).availabilityOf(on(espnPlus, disney, espn)),
      ChannelAvailability.Unlearned({ network: disney, source: "YouTube TV", guide })
    )
  })

  it("is not carried when every network is not carried", () => {
    assert.deepStrictEqual(
      lineup([notCarried(espnPlus)]).availabilityOf(on(espnPlus)),
      ChannelAvailability.NotCarried()
    )
  })

  it("is not carried when the game lists no networks", () => {
    assert.deepStrictEqual(lineup([carried]).availabilityOf(on()), ChannelAvailability.NotCarried())
  })
})

describe("ChannelLineup#record and #forget", () => {
  it("replaces an earlier carriage for the same network", () => {
    assert.deepStrictEqual(lineup([carried]).record(notCarried(espn)).carriages, [notCarried(espn)])
  })

  it("forgets one network's carriage and keeps the others", () => {
    assert.deepStrictEqual(lineup([carried, notCarried(espnPlus)]).forget(espn).carriages, [
      notCarried(espnPlus)
    ])
  })
})

function lineup(carriages: ReadonlyArray<ChannelCarriage>) {
  return new ChannelLineup({ source: "YouTube TV", guide, carriages })
}

function on(...networks: Array<Network>) {
  return snapshot({ broadcasts: networks })
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/domain/src/Source.test.ts`
Expected: FAIL — `./Source.ts` does not exist, and `Network` is not exported from `./Game.ts`.

- [ ] **Step 3: Write the modules**

Add `Network` to `packages/domain/src/Game.ts`, and make it the type of `broadcasts`. It sits with the other schemas above `GameSnapshot`, because the class reads it when it is defined:

```diff
--- a/packages/domain/src/Game.ts
+++ b/packages/domain/src/Game.ts
@@ -17,6 +17,10 @@ export const GameStatus = Schema.Literals([
 ])
 export type GameStatus = typeof GameStatus.Type
 
+/** A network's name as the provider reports it ("CBS", "ESPN"). */
+export const Network = Schema.String.pipe(Schema.brand("Network"))
+export type Network = typeof Network.Type
+
 const Side = Schema.Struct({ team: Team, score: Schema.Int, ranking: Schema.optional(Schema.Int) })
 
 export class GameSnapshot extends Schema.Class<GameSnapshot>("sportal/GameSnapshot")({
@@ -28,7 +32,7 @@ export class GameSnapshot extends Schema.Class<GameSnapshot>("sportal/GameSnapsh
   clock: Schema.String,
   home: Side,
   away: Side,
-  broadcasts: Schema.Array(Schema.String),
+  broadcasts: Schema.Array(Network),
   situation: Schema.optional(Situation)
 }) {
```

Create `packages/domain/src/Source.ts`:

```ts
import { Data, Schema } from "effect"
import { type GameSnapshot, Network } from "./Game.ts"
import { StreamLocator } from "./Stream.ts"

/** The sources Sportal can play video from, by the name people know them by. */
export const SourceName = Schema.Literals(["YouTube TV"])
export type SourceName = typeof SourceName.Type

/** A network as carried by a specific source. */
export const Channel = Schema.Struct({ network: Network, source: SourceName, locator: StreamLocator })
export type Channel = typeof Channel.Type

/** Whether a source carries a network: on a channel, or not at all. */
export const ChannelCarriage = Schema.Union([
  Schema.TaggedStruct("Carried", { channel: Channel }),
  Schema.TaggedStruct("NotCarried", { network: Network, source: SourceName })
])
export type ChannelCarriage = typeof ChannelCarriage.Type

/**
 * The channel carriages one source has learned, and the guide where the rest are picked. Recording or
 * forgetting a carriage returns a new lineup.
 */
export class ChannelLineup extends Schema.Class<ChannelLineup>("sportal/ChannelLineup")({
  source: SourceName,
  guide: StreamLocator,
  carriages: Schema.Array(ChannelCarriage)
}) {
  /**
   * Where this source can show a game, given its networks in broadcast order. A carried network wins;
   * otherwise the first network with no carriage recorded is the one to pick next.
   */
  availabilityOf(game: GameSnapshot): ChannelAvailability {
    for (const network of game.broadcasts) {
      const carriage = this.carriageOf(network)
      if (carriage?._tag === "Carried") return ChannelAvailability.Carried({ channel: carriage.channel })
    }
    const unlearned = game.broadcasts.find((network) => this.carriageOf(network) === undefined)
    return unlearned === undefined
      ? ChannelAvailability.NotCarried()
      : ChannelAvailability.Unlearned({ network: unlearned, source: this.source, guide: this.guide })
  }

  /** Records a carriage, replacing any earlier one for the same network. */
  record(carriage: ChannelCarriage): ChannelLineup {
    return new ChannelLineup({
      source: this.source,
      guide: this.guide,
      carriages: [...this.forget(networkOf(carriage)).carriages, carriage]
    })
  }

  forget(network: Network): ChannelLineup {
    return new ChannelLineup({
      source: this.source,
      guide: this.guide,
      carriages: this.carriages.filter((carriage) => networkOf(carriage) !== network)
    })
  }

  private carriageOf(network: Network): ChannelCarriage | undefined {
    return this.carriages.find((carriage) => networkOf(carriage) === network)
  }
}

/** Whether and where a source can show one game: carried, unlearned (its network still to be picked), or not carried. */
export type ChannelAvailability = Data.TaggedEnum<{
  Carried: { readonly channel: Channel }
  Unlearned: { readonly network: Network; readonly source: SourceName; readonly guide: StreamLocator }
  // biome-ignore lint/complexity/noBannedTypes: the not-carried case carries nothing
  NotCarried: {}
}>
export const ChannelAvailability = Data.taggedEnum<ChannelAvailability>()

/** An address a source refused to learn, because it is not one of the source's live channels. */
export class ChannelUrlRefused extends Schema.TaggedError<ChannelUrlRefused>()(
  "ChannelUrlRefused",
  {},
  { httpApiStatus: 422 }
) {}

function networkOf(carriage: ChannelCarriage): Network {
  return carriage._tag === "Carried" ? carriage.channel.network : carriage.network
}
```

`ChannelLineup` is a schema class even though this plan never sends it over the wire: its fields are schemas already, and the class is where its operations live. `ChannelAvailability` never crosses the wire (tiles do), so it is a `Data.taggedEnum`: plain tagged objects with constructors on the type. `networkOf` is private to the file; it reads one carriage and is used only by the lineup.

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm vitest run packages/domain/src/Source.test.ts`
Expected: `Tests  8 passed (8)`.

- [ ] **Step 5: Brand the game's networks in the provider and tests**

Apply this change to `apps/hub/src/provider/espn/EspnProvider.ts`:

```diff
--- a/apps/hub/src/provider/espn/EspnProvider.ts
+++ b/apps/hub/src/provider/espn/EspnProvider.ts
@@ -1,3 +1,3 @@
-import { GameId, GameSnapshot, type GameStatus } from "@sportal/domain/Game"
+import { GameId, GameSnapshot, type GameStatus, Network } from "@sportal/domain/Game"
 import type { LeagueId } from "@sportal/domain/League"
 import { Situation } from "@sportal/domain/Situation"
@@ -75,7 +75,7 @@ function toSnapshot(league: LeagueId, event: typeof EspnPayload.Event.Type): Opt
       clock: event.status.displayClock,
       home: side(home),
       away: side(away),
-      broadcasts: (competition.broadcasts ?? []).flatMap((b) => b.names),
+      broadcasts: (competition.broadcasts ?? []).flatMap((b) => b.names.map((name) => Network.make(name))),
       ...(s === undefined
         ? {}
         : {
```

The typecheck now fails wherever a test builds a snapshot with plain strings. Fix each. In `Cadence.test.ts` and `Ingest.test.ts` the networks never mattered, so they go:

Apply this change to `apps/hub/src/ingest/Cadence.test.ts`:

```diff
--- a/apps/hub/src/ingest/Cadence.test.ts
+++ b/apps/hub/src/ingest/Cadence.test.ts
@@ -11,8 +11,7 @@ function game(status: "live" | "scheduled", kickoff: string) {
     kickoff: DateTime.makeUnsafe(kickoff),
     clock: "",
     home: { team: team("MSST"), score: 0 },
-    away: { team: team("ALA"), score: 0 },
-    broadcasts: ["ESPN"]
+    away: { team: team("ALA"), score: 0 }
   })
 }
 
```

Apply this change to `apps/hub/src/ingest/Ingest.test.ts`:

```diff
--- a/apps/hub/src/ingest/Ingest.test.ts
+++ b/apps/hub/src/ingest/Ingest.test.ts
@@ -12,8 +12,7 @@ function liveGame(homeScore: number) {
     period: 1,
     clock: "10:00",
     home: { team: team("MSST"), score: homeScore },
-    away: { team: team("ALA"), score: 0 },
-    broadcasts: ["ESPN"]
+    away: { team: team("ALA"), score: 0 }
   })
 }
 
```

Apply this change to `apps/hub/src/provider/espn/EspnProvider.test.ts`:

```diff
--- a/apps/hub/src/provider/espn/EspnProvider.test.ts
+++ b/apps/hub/src/provider/espn/EspnProvider.test.ts
@@ -1,5 +1,6 @@
 import { readFileSync } from "node:fs"
 import { assert, describe, it } from "@effect/vitest"
+import { Network } from "@sportal/domain/Game"
 import { Effect, Layer } from "effect"
 import { HttpClient, HttpClientResponse } from "effect/http"
 import { Provider } from "../Provider.ts"
@@ -33,7 +34,7 @@ describe("EspnProvider", () => {
       assert.strictEqual(game?.away.team.abbreviation, "MEM")
       assert.strictEqual(game?.away.team.id, "fbs:235")
       assert.strictEqual(game?.away.score, 27)
-      assert.deepStrictEqual(game?.broadcasts, ["ESPN+"])
+      assert.deepStrictEqual(game?.broadcasts, [Network.make("ESPN+")])
       assert.strictEqual(game?.situation?.isRedZone, true)
     }).pipe(Effect.provide(TestLayer))
   )
```

Apply this change to `apps/hub/src/http/HubServer.test.ts`:

```diff
--- a/apps/hub/src/http/HubServer.test.ts
+++ b/apps/hub/src/http/HubServer.test.ts
@@ -1,5 +1,5 @@
 import { assert, layer } from "@effect/vitest"
 import { SportalApi } from "@sportal/api/SportalApi"
-import { GameId } from "@sportal/domain/Game"
+import { GameId, Network } from "@sportal/domain/Game"
 import { snapshot, team } from "@sportal/domain/TestGame"
 import { DateTime, Effect, Layer } from "effect"
@@ -15,7 +15,7 @@ const game = snapshot({
   id: GameId.make("401856707"),
   home: { team: team("MSST"), score: 0 },
   away: { team: team("ALA"), score: 0 },
-  broadcasts: ["ESPN"]
+  broadcasts: [Network.make("ESPN")]
 })
 
 const TestHub = ApiHandlers.pipe(
```

Apply this change to `apps/hub/src/stage/StageSessions.test.ts`:

```diff
--- a/apps/hub/src/stage/StageSessions.test.ts
+++ b/apps/hub/src/stage/StageSessions.test.ts
@@ -1,4 +1,4 @@
 import { assert, describe, it } from "@effect/vitest"
-import { GameId } from "@sportal/domain/Game"
+import { GameId, Network } from "@sportal/domain/Game"
 import { snapshot } from "@sportal/domain/TestGame"
 import { Effect, Layer, Option, Stream } from "effect"
@@ -6,11 +6,12 @@ import { Ingest } from "../ingest/Ingest.ts"
 import { Source } from "../source/Source.ts"
 import { StageSessions } from "./StageSessions.ts"
 
-function game(id: string, broadcasts: ReadonlyArray<string>) {
+function game(id: string, broadcasts: ReadonlyArray<Network>) {
   return snapshot({ id: GameId.make(id), status: "live", period: 1, clock: "10:00", broadcasts })
 }
 
-const slate = [game("1", ["ESPN"]), game("2", ["ESPN"]), game("3", ["ESPN"]), game("4", ["Local"])]
+const espn = Network.make("ESPN")
+const slate = [game("1", [espn]), game("2", [espn]), game("3", [espn]), game("4", [Network.make("Local")])]
 
 const TestSessions = StageSessions.layer.pipe(
   Layer.provide(Layer.succeed(Ingest, Ingest.of({ slate: Effect.succeed(slate), changes: Stream.empty }))),
@@ -19,7 +20,7 @@ const TestSessions = StageSessions.layer.pipe(
       Source,
       Source.of({
         locate: (snapshot) =>
-          snapshot.broadcasts.includes("ESPN")
+          snapshot.broadcasts.includes(espn)
             ? Option.some({ _tag: "WebView", url: `https://tv.example/${snapshot.id}` })
             : Option.none()
       })
```

`YouTubeTv.ts` still looks networks up by name in its record of addresses (`channels[network]`); a branded string indexes it the same way, so it needs no change until Task 4 replaces it.

- [ ] **Step 6: Add the words**

Apply this change to `CONTEXT.md`:

```diff
--- a/CONTEXT.md
+++ b/CONTEXT.md
@@ -39,9 +39,15 @@ Every exported type name must be a term here.
 | **Ingest** | The Hub's loop that polls providers and keeps the current slate. | poller, sync, fetcher |
 | **Cadence** | How long Ingest waits between polls, given what the last poll saw. | interval, rate |
 | **Source** | A way you obtain **video** (YouTube TV). | provider, service |
+| **Source name** | A source as people know it ("YouTube TV"); how code and the UI name a source. | source id |
 | **Broadcast** | The fact that a network is airing a game. | channel, stream |
+| **Network** | A network's name as a provider reports it ("CBS", "ESPN"). | channel, station |
 | **Channel** | A network as carried by a specific source. | |
-| **Availability** | Whether and where a source can show a game. | |
+| **Channel carriage** | Whether a source carries a network: on a channel, or not at all. | answer, mapping |
+| **Channel lineup** | The channel carriages one source has learned, and the guide where the rest are picked. | channel map |
+| **Channel availability** | Whether and where a source can show a game: carried, unlearned (its network still to be picked), or not carried. | availability |
+| **Channel URL refused** | An address a source would not learn, because it is not one of its live channels. | not a channel |
 | **Stream** | One playing instance of a game from a source. | feed, video |
 | **StreamLocator** | What a Display must load to play a stream. | URL, link |
 | **StreamBudget** | How many concurrent streams a source allows. | limit, cap |
```

- [ ] **Step 7: Check**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and every test passes.

- [ ] **Step 8: Commit**

```bash
git add CONTEXT.md packages/domain/src apps/hub/src
git commit -m "feat(domain): networks, channel carriages, and the channel lineup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: The Hub's database, and the channel store

**Files:**
- Modify: `apps/hub/package.json` (adds `@effect/sql-sqlite-node` 4.0.0, exact)
- Create: `apps/hub/src/database/Database.ts`
- Test: `apps/hub/src/database/Database.test.ts`
- Create: `apps/hub/src/source/ChannelStore.ts` (the port), `apps/hub/src/source/SqlChannelStore.ts` (the adapter, with its migration)
- Test: `apps/hub/src/source/SqlChannelStore.test.ts`
- Modify: `apps/hub/src/main.ts` (data directory, database, channel store)
- Modify: `.dependency-cruiser.cjs` (`database/` and `SqlChannelStore.ts` are adapters only `main.ts`, tests, and other adapters may name), `.gitignore` (`.sportal/`), `CONTEXT.md`

**Where these live.** `Database.ts` gets its own folder with its test, like `http/` and `ingest/`: it is the one concept every SQL store shares, and it is concrete (SQLite), so it is an adapter. `ChannelStore.ts` and `SqlChannelStore.ts` sit in `source/` because the YouTube TV source is their only user; a store for games or follows will sit beside its own concept in the Tracker.

**Interfaces:**
- Consumes: `ChannelCarriage`, `Network`, `SourceName` from Task 2.
- Produces:
  - `Database.layer(filename: string)` — the SQLite client for the file (or `":memory:"`); provides `SqlClient`.
  - `Database.migrate(store: string, migrations: Record<string, Effect<void, unknown, SqlClient>>): Effect<ReadonlyArray<readonly [id: number, name: string]>, MigrationError | SqlError, SqlClient>` — runs the store's pending migrations (keys `<id>_<name>`) and records them in the store's own table, `<store>_migrations`.
  - `ChannelStore` (service `sportal/hub/ChannelStore`): `carriages: Effect<ReadonlyArray<ChannelCarriage>, ChannelStoreError>`; `record(carriage: ChannelCarriage): Effect<void, ChannelStoreError>` (replaces any earlier carriage for the same network and source); `forget(network, source): Effect<void, ChannelStoreError>`.
  - `ChannelStoreError` — tagged error with `cause: Schema.Defect()`.
  - `SqlChannelStore.layer: Layer<ChannelStore, MigrationError | SqlError, SqlClient>` — migrates the `channel` store's tables, then provides `ChannelStore`.

**The driver risk is settled.** The spec feared `@effect/sql-sqlite-node` would need `better-sqlite3`, a native module pnpm 12 will not build. Version 4.0.0 depends only on `effect` (checked in the registry) and runs on Node 24's own `node:sqlite`. Nothing native is installed.

- [ ] **Step 1: Add the driver**

Run: `pnpm --filter @sportal/hub add @effect/sql-sqlite-node@4.0.0 --save-exact`
Expected: `Done`; `apps/hub/package.json` lists `"@effect/sql-sqlite-node": "4.0.0"`.

Before writing code, read `node_modules/@effect/sql-sqlite-node/dist/SqliteClient.d.ts` and confirm `SqliteClient.layer({ filename })` is the constructor and what its layer provides. The rest of this task assumes it provides `SqlClient.SqlClient`.

- [ ] **Step 2: Write the failing database test**

Create `apps/hub/src/database/Database.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "./Database.ts"

describe("Database.migrate", () => {
  it.effect("keeps each store's migrations in its own table, so stores number them independently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const first = yield* Database.migrate("first", { "1_create": createTable("first_thing") })
      const second = yield* Database.migrate("second", { "1_create": createTable("second_thing") })
      assert.deepStrictEqual(first, [[1, "create"]])
      assert.deepStrictEqual(second, [[1, "create"]])

      const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`
      assert.includeMembers(
        tables.map((table) => table.name),
        ["first_migrations", "second_migrations", "first_thing", "second_thing"]
      )
    }).pipe(Effect.provide(Database.layer(":memory:")))
  )

  it.effect("runs a migration once", () =>
    Effect.gen(function* () {
      const migrations = { "1_create": createTable("thing") }
      yield* Database.migrate("store", migrations)
      assert.deepStrictEqual(yield* Database.migrate("store", migrations), [])
    }).pipe(Effect.provide(Database.layer(":memory:")))
  )
})

function createTable(name: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE ${sql(name)} (id INTEGER)`
  })
}
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm vitest run apps/hub/src/database`
Expected: FAIL — `./Database.ts` does not exist.

- [ ] **Step 4: Write the database module**

Create `apps/hub/src/database/Database.ts`:

```ts
import { SqliteClient } from "@effect/sql-sqlite-node"
import type { Effect } from "effect"
import { Migrator, type SqlClient } from "effect/sql"

/** The Hub's SQLite database, in `filename` (or `":memory:"`). Each store migrates its own tables. */
export const layer = (filename: string) => SqliteClient.layer({ filename })

/**
 * Runs one store's pending migrations, keyed `<id>_<name>`, and records them in that store's own table,
 * `<store>_migrations`, so two stores never share a numbering. Returns the migrations it ran.
 */
export function migrate(
  store: string,
  migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>
) {
  return run({ loader: Migrator.fromRecord(migrations), table: `${store}_migrations` })
}

const run = Migrator.make({})
```

`Migrator.make` comes from `effect/sql` itself (`src/sql/Migrator.ts`); its `table` option names the migrations table, and `fromRecord` sorts the record by id. The SQLite package's own migrator only adds a schema dump, which the Hub does not use.

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm vitest run apps/hub/src/database`
Expected: `Tests  2 passed (2)`.

- [ ] **Step 6: Write the port**

Create `apps/hub/src/source/ChannelStore.ts`:

```ts
import type { Network } from "@sportal/domain/Game"
import type { ChannelCarriage, SourceName } from "@sportal/domain/Source"
import { Context, type Effect, Schema } from "effect"

/** Where the Hub keeps the channel carriages it learned from the user: they cannot be fetched again. */
export class ChannelStore extends Context.Service<
  ChannelStore,
  {
    readonly carriages: Effect.Effect<ReadonlyArray<ChannelCarriage>, ChannelStoreError>
    /** Records a carriage, replacing any earlier one for the same network and source. */
    record(carriage: ChannelCarriage): Effect.Effect<void, ChannelStoreError>
    forget(network: Network, source: SourceName): Effect.Effect<void, ChannelStoreError>
  }
>()("sportal/hub/ChannelStore") {}

export class ChannelStoreError extends Schema.TaggedError<ChannelStoreError>()("ChannelStoreError", {
  cause: Schema.Defect()
}) {}
```

- [ ] **Step 7: Write the failing store test**

Create `apps/hub/src/source/SqlChannelStore.test.ts`:

```ts
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import { Effect, FileSystem, Layer } from "effect"
import * as Database from "../database/Database.ts"
import { ChannelStore } from "./ChannelStore.ts"
import * as SqlChannelStore from "./SqlChannelStore.ts"

const espn = Network.make("ESPN")
const espnPlus = Network.make("ESPN+")
const carried = (url: string) => ({
  _tag: "Carried" as const,
  channel: { network: espn, source: "YouTube TV" as const, locator: { _tag: "WebView" as const, url } }
})
const notCarried = { _tag: "NotCarried" as const, network: espnPlus, source: "YouTube TV" as const }

describe("SqlChannelStore", () => {
  it.effect("starts empty and returns each carriage recorded", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      const carriages = yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* store.carriages, [])
          yield* store.record(carried("https://tv.youtube.com/watch/espn"))
          yield* store.record(notCarried)
          return yield* store.carriages
        })
      )
      assert.sameDeepMembers([...carriages], [carried("https://tv.youtube.com/watch/espn"), notCarried])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("replaces an earlier carriage for the same network", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      const carriages = yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          yield* store.record(carried("https://tv.youtube.com/watch/first"))
          yield* store.record(carried("https://tv.youtube.com/watch/second"))
          return yield* store.carriages
        })
      )
      assert.deepStrictEqual(carriages, [carried("https://tv.youtube.com/watch/second")])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("forgets a carriage", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      const carriages = yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          yield* store.record(carried("https://tv.youtube.com/watch/espn"))
          yield* store.forget(espn, "YouTube TV")
          return yield* store.carriages
        })
      )
      assert.deepStrictEqual(carriages, [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps carriages when the database is opened again", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      yield* withStore(filename, (store) => store.record(notCarried))
      const carriages = yield* withStore(filename, (store) => store.carriages)
      assert.deepStrictEqual(carriages, [notCarried])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** A database file in a temporary directory that is removed when the test's scope closes. */
function tempDatabase() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return join(yield* fs.makeTempDirectoryScoped(), "sportal.sqlite")
  })
}

/** Runs `use` against the channel store over the given database file, opened fresh. */
function withStore<A, E>(filename: string, use: (store: typeof ChannelStore.Service) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    return yield* use(yield* ChannelStore)
  }).pipe(Effect.provide(SqlChannelStore.layer.pipe(Layer.provide(Database.layer(filename)))))
}
```

- [ ] **Step 8: Run it to see it fail**

Run: `pnpm vitest run apps/hub/src/source/SqlChannelStore.test.ts`
Expected: FAIL — `./SqlChannelStore.ts` does not exist.

- [ ] **Step 9: Write the adapter**

Create `apps/hub/src/source/SqlChannelStore.ts`:

```ts
import { Network } from "@sportal/domain/Game"
import { type ChannelCarriage, SourceName } from "@sportal/domain/Source"
import { DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import * as Database from "../database/Database.ts"
import { ChannelStore, ChannelStoreError } from "./ChannelStore.ts"

/** Channel carriages in the Hub's database, in a table this store creates and migrates itself. */
export const layer = Layer.effect(
  ChannelStore,
  Effect.gen(function* () {
    yield* Database.migrate("channel", migrations)
    const sql = yield* SqlClient.SqlClient

    const rows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        network: Network,
        source: SourceName,
        carried: Schema.Literals([0, 1]),
        url: Schema.NullOr(Schema.String)
      }),
      execute: () => sql`SELECT network, source, carried, url FROM channel_carriage`
    })

    const carriages = rows().pipe(
      Effect.map((found) =>
        found.map(
          ({ network, source, carried, url }): ChannelCarriage =>
            carried === 1 && url !== null
              ? { _tag: "Carried", channel: { network, source, locator: { _tag: "WebView", url } } }
              : { _tag: "NotCarried", network, source }
        )
      ),
      Effect.mapError((cause) => new ChannelStoreError({ cause }))
    )

    const record = Effect.fn("SqlChannelStore.record")(function* (carriage: ChannelCarriage) {
      const row =
        carriage._tag === "Carried"
          ? {
              network: carriage.channel.network,
              source: carriage.channel.source,
              carried: 1,
              url: carriage.channel.locator.url
            }
          : { network: carriage.network, source: carriage.source, carried: 0, url: null }
      const recordedAt = DateTime.formatIso(yield* DateTime.now)
      yield* sql`
        INSERT INTO channel_carriage ${sql.insert({ ...row, recorded_at: recordedAt })}
        ON CONFLICT (network, source) DO UPDATE SET
          carried = excluded.carried, url = excluded.url, recorded_at = excluded.recorded_at
      `.pipe(Effect.mapError((cause) => new ChannelStoreError({ cause })))
    })

    const forget = Effect.fn("SqlChannelStore.forget")((network: Network, source: SourceName) =>
      sql`DELETE FROM channel_carriage WHERE network = ${network} AND source = ${source}`.pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new ChannelStoreError({ cause }))
      )
    )

    return ChannelStore.of({ carriages, record, forget })
  })
)

/** This store's migrations, recorded in `channel_migrations`. */
const migrations = {
  "1_create_channel_carriage": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE channel_carriage (
        network TEXT NOT NULL,
        source TEXT NOT NULL,
        carried INTEGER NOT NULL,
        url TEXT,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (network, source)
      )
    `
  })
}
```

Rows are decoded with a struct written at the point of use, not a named row type: `ChannelCarriage` stays the only type. `recorded_at` comes from Effect's `Clock`. `migrations` is read only when the layer is built, so it can sit below the layer.

- [ ] **Step 10: Run it to see it pass**

Run: `pnpm vitest run apps/hub/src/source/SqlChannelStore.test.ts`
Expected: `Tests  4 passed (4)`.

- [ ] **Step 11: Give the Hub a data directory**

Replace `apps/hub/src/main.ts`:

```ts
import { createServer } from "node:http"
import { join } from "node:path"
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect, FileSystem, Layer, Option } from "effect"
import { FetchHttpClient, HttpRouter, HttpStaticServer } from "effect/http"
import * as Database from "./database/Database.ts"
import * as HubServer from "./http/HubServer.ts"
import { Ingest } from "./ingest/Ingest.ts"
import * as EspnProvider from "./provider/espn/EspnProvider.ts"
import * as SqlChannelStore from "./source/SqlChannelStore.ts"
import * as YouTubeTv from "./source/YouTubeTv.ts"
import channels from "./source/youtube-tv-channels.json" with { type: "json" }
import { StageSessions } from "./stage/StageSessions.ts"

const Hub = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("SPORTAL_PORT").pipe(Config.withDefault(4400))
    const host = yield* Config.String("SPORTAL_HOST").pipe(Config.withDefault("127.0.0.1"))
    // The built web UI, served by the Hub outside development.
    const webRoot = yield* Config.String("SPORTAL_WEB_ROOT").pipe(Config.option)
    // Where the Hub keeps its database.
    const dataDir = yield* Config.String("SPORTAL_DATA_DIR").pipe(Config.withDefault(".sportal"))
    yield* (yield* FileSystem.FileSystem).makeDirectory(dataDir, { recursive: true })

    const routes = Option.match(webRoot, {
      onNone: () => HubServer.layer,
      onSome: (root) => Layer.mergeAll(HubServer.layer, HttpStaticServer.layer({ root, spa: true }))
    })

    return HttpRouter.serve(routes).pipe(
      Layer.provide(StageSessions.layer),
      Layer.provide(YouTubeTv.layer(channels)),
      Layer.provide(SqlChannelStore.layer),
      Layer.provide(Ingest.layer(["nfl", "fbs"])),
      Layer.provide(EspnProvider.layer),
      Layer.provide(Database.layer(join(dataDir, "sportal.sqlite"))),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(NodeHttpServer.layer(createServer, { port, host })),
      Layer.provide(NodeServices.layer)
    )
  })
)

Layer.launch(Hub).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
```

Nothing depends on `ChannelStore` yet; providing it here creates and migrates the database at boot, which proves the wiring before Task 5 uses it. `Effect.provide(NodeServices.layer)` on the launch gives the boot step its `FileSystem`.

Apply this change to `.dependency-cruiser.cjs`:

```diff
--- a/.dependency-cruiser.cjs
+++ b/.dependency-cruiser.cjs
@@ -34,9 +34,11 @@ module.exports = {
       severity: "error",
       from: {
         path: "^apps/hub/src/",
-        pathNot: "(^apps/hub/src/main\\.ts$|\\.test\\.ts$|^apps/hub/src/provider/[^/]+/)"
+        pathNot:
+          "(^apps/hub/src/main\\.ts$|\\.test\\.ts$|^apps/hub/src/provider/[^/]+/|^apps/hub/src/source/Sql[^/]+\\.ts$)"
       },
-      to: { path: "^apps/hub/src/(provider/[^/]+/|source/YouTubeTv\\.ts$)" }
+      to: {
+        path: "^apps/hub/src/(provider/[^/]+/|source/YouTubeTv\\.ts$|source/Sql[^/]+\\.ts$|database/)"
+      }
     },
     {
       name: "test-game-is-for-tests",
```

An SQL adapter may name `Database`; nothing else outside `main.ts` and tests may name either.

Apply this change to `.gitignore`:

```diff
--- a/.gitignore
+++ b/.gitignore
@@ -12,3 +12,6 @@ out/
 fixtures/espn-recordings/*/
 
 spikes/
+
+# The Hub's local data directory (SPORTAL_DATA_DIR)
+.sportal/
```

- [ ] **Step 12: Add the words**

Apply this change to `CONTEXT.md`:

```diff
--- a/CONTEXT.md
+++ b/CONTEXT.md
@@ -48,6 +48,9 @@ Every exported type name must be a term here.
 | **Channel availability** | Whether and where a source can show a game: carried, unlearned (its network still to be picked), or not carried. | availability |
 | **Channel URL refused** | An address a source would not learn, because it is not one of its live channels. | not a channel |
+| **Channel store** | Where the Hub keeps the channel carriages it has learned. | channel repository |
+| **Channel store error** | The channel store could not read or write. | database error |
+| **Database** | The Hub's SQLite database. Each store migrates its own tables in it. | store, persistence |
 | **Stream** | One playing instance of a game from a source. | feed, video |
 | **StreamLocator** | What a Display must load to play a stream. | URL, link |
```

- [ ] **Step 13: Check, and see the database appear**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and every test passes.

Run: `cd apps/hub && SPORTAL_PORT=4490 timeout 8 node src/main.ts; ls .sportal; rm -rf .sportal`
Expected: the Hub logs `Listening on http://127.0.0.1:4490`; `.sportal/` holds `sportal.sqlite`.

- [ ] **Step 14: Commit**

```bash
git add CONTEXT.md .dependency-cruiser.cjs .gitignore apps/hub/package.json pnpm-lock.yaml apps/hub/src
git commit -m "feat(hub): database module with per-store migrations, and the channel store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Stage — tiles resolve by channel availability, picking tiles, and refresh

**Files:**
- Modify: `packages/domain/src/Stage.ts`
- Test: `packages/domain/src/Stage.test.ts` (rewritten; also covers the deferred Stage test gaps)
- Modify: `apps/hub/src/source/Source.ts`, `apps/hub/src/source/YouTubeTv.ts` (port exposes the lineup; still a fixed list of carriages until Task 5)
- Delete: `apps/hub/src/source/youtube-tv-channels.json`
- Modify: `apps/hub/src/stage/StageSessions.ts`, `apps/hub/src/stage/StageSessions.test.ts`, `apps/hub/src/http/HubServer.test.ts`, `apps/hub/src/main.ts`
- Modify: `apps/web/src/stage/StageView.tsx` (stream tiles carry a channel; a picking tile has a body)
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `ChannelAvailability`, `ChannelLineup`, `Channel`, `SourceName` from Task 2; `Network` from `@sportal/domain/Game`.
- Produces:
  - `Tile` — `Empty | StreamTile { game, channel: Channel } | PickingChannel { game, network, source, guide: StreamLocator } | DataTile { game }`. A stream tile now carries its whole channel, not just a locator, so the UI can forget the channel's network and name its source.
  - `Stage#apply(command, availabilityOf: (game: GameId) => ChannelAvailability)`.
  - `Stage#refresh(availabilityOf): Stage` — re-resolves every occupied tile; empty tiles and audio focus are untouched.
  - `Source` port: `lineup: Effect<ChannelLineup>` replaces `locate`. It is an effect because, from Task 5, the lineup lives in a ref.

- [ ] **Step 1: Write the failing test**

Replace `packages/domain/src/Stage.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { GameId, Network } from "./Game.ts"
import { ChannelAvailability } from "./Source.ts"
import { Stage } from "./Stage.ts"

const bama = GameId.make("401856707")
const irish = GameId.make("401858250")
const fox = Network.make("FOX")
const foxChannel = {
  network: fox,
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" }
}
const guide = { _tag: "WebView" as const, url: "https://tv.youtube.com/live" }
const onFox = () => ChannelAvailability.Carried({ channel: foxChannel })
const foxUnlearned = () => ChannelAvailability.Unlearned({ network: fox, source: "YouTube TV", guide })
const nowhere = () => ChannelAvailability.NotCarried()

describe("Stage#apply", () => {
  it("assigns a carried game as a stream tile", () => {
    const stage = assign(Stage.initial, 1, bama, onFox)
    assert.deepStrictEqual(stage.tiles[1], { _tag: "StreamTile", game: bama, channel: foxChannel })
  })

  it("assigns a game on an unlearned network as a picking tile", () => {
    const stage = assign(Stage.initial, 0, bama, foxUnlearned)
    assert.deepStrictEqual(stage.tiles[0], {
      _tag: "PickingChannel",
      game: bama,
      network: fox,
      source: "YouTube TV",
      guide
    })
  })

  it("assigns a game that is not carried as a data tile", () => {
    const stage = assign(Stage.initial, 0, bama, nowhere)
    assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: bama })
  })

  it("replaces whatever an occupied tile held", () => {
    const first = assign(Stage.initial, 0, bama, onFox)
    const second = assign(first, 0, irish, nowhere)
    assert.deepStrictEqual(second.tiles[0], { _tag: "DataTile", game: irish })
  })

  it("moves a game rather than showing it twice", () => {
    const first = assign(Stage.initial, 0, bama, onFox)
    const second = assign(first, 2, bama, onFox)
    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.strictEqual(second.tiles[2]?._tag, "StreamTile")
  })

  it("re-resolves a moved game, so a game that lost its stream moves as a data tile", () => {
    const first = assign(Stage.initial, 0, bama, onFox)
    const second = assign(first, 1, bama, nowhere)
    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.deepStrictEqual(second.tiles[1], { _tag: "DataTile", game: bama })
  })

  it("clears a tile and leaves the others", () => {
    const a = assign(Stage.initial, 0, bama, onFox)
    const b = assign(a, 1, irish, onFox)
    const c = Result.getOrThrow(b.apply({ _tag: "Clear", tile: 0 }, onFox))
    assert.strictEqual(c.tiles[0]?._tag, "Empty")
    assert.strictEqual(c.tiles[1]?._tag, "StreamTile")
  })

  it("moves audio focus", () => {
    const stage = Result.getOrThrow(Stage.initial.apply({ _tag: "FocusAudio", tile: 3 }, nowhere))
    assert.strictEqual(stage.audioFocus, 3)
  })

  it("leaves audio focus where it was on assign and clear", () => {
    const focused = Result.getOrThrow(Stage.initial.apply({ _tag: "FocusAudio", tile: 2 }, nowhere))
    const assigned = assign(focused, 0, bama, onFox)
    const cleared = Result.getOrThrow(assigned.apply({ _tag: "Clear", tile: 2 }, onFox))
    assert.strictEqual(assigned.audioFocus, 2)
    assert.strictEqual(cleared.audioFocus, 2)
  })

  it("rejects a tile that does not exist, saying why", () => {
    const result = Stage.initial.apply({ _tag: "FocusAudio", tile: 4 }, nowhere)
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "no-such-tile")
  })
})

describe("Stage#refresh", () => {
  it("turns every picking tile for a network into a stream once its channel is learned", () => {
    const picking = assign(assign(Stage.initial, 0, bama, foxUnlearned), 1, irish, foxUnlearned)
    const refreshed = picking.refresh(onFox)
    assert.deepStrictEqual(refreshed.tiles[0], { _tag: "StreamTile", game: bama, channel: foxChannel })
    assert.deepStrictEqual(refreshed.tiles[1], { _tag: "StreamTile", game: irish, channel: foxChannel })
  })

  it("moves a picking tile to the game's next unlearned network when one is not carried", () => {
    const espn = Network.make("ESPN")
    const picking = assign(Stage.initial, 0, bama, foxUnlearned)
    const refreshed = picking.refresh(() =>
      ChannelAvailability.Unlearned({ network: espn, source: "YouTube TV", guide })
    )
    assert.deepStrictEqual(refreshed.tiles[0], {
      _tag: "PickingChannel",
      game: bama,
      network: espn,
      source: "YouTube TV",
      guide
    })
  })

  it("turns a stream tile back into a picking tile when its channel is forgotten", () => {
    const streaming = assign(Stage.initial, 0, bama, onFox)
    assert.strictEqual(streaming.refresh(foxUnlearned).tiles[0]?._tag, "PickingChannel")
  })

  it("leaves empty tiles empty and audio focus where it was", () => {
    const focused = Result.getOrThrow(Stage.initial.apply({ _tag: "FocusAudio", tile: 3 }, nowhere))
    const refreshed = assign(focused, 0, bama, foxUnlearned).refresh(onFox)
    assert.deepStrictEqual(
      refreshed.tiles.map((tile) => tile._tag),
      ["StreamTile", "Empty", "Empty", "Empty"]
    )
    assert.strictEqual(refreshed.audioFocus, 3)
  })
})

function assign(stage: Stage, tile: number, game: GameId, availabilityOf: () => ChannelAvailability) {
  return Result.getOrThrow(stage.apply({ _tag: "Assign", tile, game }, availabilityOf))
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/domain/src/Stage.test.ts`
Expected: FAIL — `refresh` is not a function, and assignments still produce `locator` stream tiles.

- [ ] **Step 3: Write the implementation**

Replace `packages/domain/src/Stage.ts`:

```ts
import { Result, Schema } from "effect"
import { GameId, Network } from "./Game.ts"
import { Channel, type ChannelAvailability, SourceName } from "./Source.ts"
import { StreamLocator } from "./Stream.ts"

export const Tile = Schema.Union([
  Schema.TaggedStruct("Empty", {}),
  Schema.TaggedStruct("StreamTile", { game: GameId, channel: Channel }),
  /** The game's network has no channel yet: the tile shows the source's guide until one is picked. */
  Schema.TaggedStruct("PickingChannel", {
    game: GameId,
    network: Network,
    source: SourceName,
    guide: StreamLocator
  }),
  Schema.TaggedStruct("DataTile", { game: GameId })
])
export type Tile = typeof Tile.Type

export class Stage extends Schema.Class<Stage>("sportal/Stage")({
  tiles: Schema.Array(Tile),
  audioFocus: Schema.Int
}) {
  /** Four empty tiles, with audio focus on the first. */
  static readonly initial = new Stage({
    tiles: [{ _tag: "Empty" }, { _tag: "Empty" }, { _tag: "Empty" }, { _tag: "Empty" }],
    audioFocus: 0
  })

  /**
   * Applies a command. `availabilityOf` says whether and where a game can be streamed: a carried game
   * becomes a stream tile, a game on an unlearned network a picking tile, and any other a data tile.
   */
  apply(
    command: StageCommand,
    availabilityOf: (game: GameId) => ChannelAvailability
  ): Result.Result<Stage, StageRejection> {
    if (command.tile < 0 || command.tile >= this.tiles.length) {
      return Result.fail(new StageRejection({ reason: "no-such-tile" }))
    }
    switch (command._tag) {
      case "Assign": {
        const tile = tileFor(command.game, availabilityOf(command.game))
        // A game appears in at most one tile: assigning it elsewhere moves it.
        const tiles = this.tiles.map((existing, index) =>
          index === command.tile
            ? tile
            : existing._tag !== "Empty" && existing.game === command.game
              ? empty
              : existing
        )
        return Result.succeed(new Stage({ tiles, audioFocus: this.audioFocus }))
      }
      case "Clear":
        return Result.succeed(
          new Stage({
            tiles: this.tiles.map((existing, index) => (index === command.tile ? empty : existing)),
            audioFocus: this.audioFocus
          })
        )
      case "FocusAudio":
        return Result.succeed(new Stage({ tiles: this.tiles, audioFocus: command.tile }))
    }
  }

  /** Re-resolves every occupied tile after what a source knows has changed. */
  refresh(availabilityOf: (game: GameId) => ChannelAvailability): Stage {
    return new Stage({
      tiles: this.tiles.map((tile) =>
        tile._tag === "Empty" ? tile : tileFor(tile.game, availabilityOf(tile.game))
      ),
      audioFocus: this.audioFocus
    })
  }
}

export const StageCommand = Schema.Union([
  Schema.TaggedStruct("Assign", { tile: Schema.Int, game: GameId }),
  Schema.TaggedStruct("Clear", { tile: Schema.Int }),
  Schema.TaggedStruct("FocusAudio", { tile: Schema.Int })
])
export type StageCommand = typeof StageCommand.Type

export class StageRejection extends Schema.TaggedError<StageRejection>()(
  "StageRejection",
  { reason: Schema.Literals(["no-such-tile"]) },
  { httpApiStatus: 422 }
) {}

const empty: Tile = { _tag: "Empty" }

function tileFor(game: GameId, availability: ChannelAvailability): Tile {
  switch (availability._tag) {
    case "Carried":
      return { _tag: "StreamTile", game, channel: availability.channel }
    case "Unlearned":
      return {
        _tag: "PickingChannel",
        game,
        network: availability.network,
        source: availability.source,
        guide: availability.guide
      }
    case "NotCarried":
      return { _tag: "DataTile", game }
  }
}
```

`tileFor` is a private helper of `Stage`: it builds one tile for `apply` and `refresh` and is not exported.

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm vitest run packages/domain/src/Stage.test.ts`
Expected: `Tests  14 passed (14)`.

- [ ] **Step 5: Switch the source port to the lineup and drop the hand-filled map**

Replace `apps/hub/src/source/Source.ts`:

```ts
import type { ChannelLineup } from "@sportal/domain/Source"
import { Context, type Effect } from "effect"

export class Source extends Context.Service<
  Source,
  {
    /** The channels this source has learned so far. */
    readonly lineup: Effect.Effect<ChannelLineup>
  }
>()("sportal/hub/Source") {}
```

Replace `apps/hub/src/source/YouTubeTv.ts`:

```ts
import { type ChannelCarriage, ChannelLineup } from "@sportal/domain/Source"
import { Effect, Layer } from "effect"
import { Source } from "./Source.ts"

/** YouTube TV as a source that knows a fixed list of carriages. */
export const layer = (carriages: ReadonlyArray<ChannelCarriage>) =>
  Layer.succeed(
    Source,
    Source.of({ lineup: Effect.succeed(new ChannelLineup({ source: "YouTube TV", guide, carriages })) })
  )

const guide = { _tag: "WebView", url: "https://tv.youtube.com/live" } as const
```

This version takes a fixed list of carriages; Task 5 replaces it with one backed by the channel store.

Run: `git rm apps/hub/src/source/youtube-tv-channels.json`
Expected: the file is staged for deletion.

Apply this change to `apps/hub/src/main.ts`:

```diff
--- a/apps/hub/src/main.ts
+++ b/apps/hub/src/main.ts
@@ -9,7 +9,6 @@ import { Ingest } from "./ingest/Ingest.ts"
 import * as EspnProvider from "./provider/espn/EspnProvider.ts"
 import * as SqlChannelStore from "./source/SqlChannelStore.ts"
 import * as YouTubeTv from "./source/YouTubeTv.ts"
-import channels from "./source/youtube-tv-channels.json" with { type: "json" }
 import { StageSessions } from "./stage/StageSessions.ts"
 
 const Hub = Layer.unwrap(
@@ -29,7 +28,7 @@ const Hub = Layer.unwrap(
 
     return HttpRouter.serve(routes).pipe(
       Layer.provide(StageSessions.layer),
-      Layer.provide(YouTubeTv.layer(channels)),
+      Layer.provide(YouTubeTv.layer([])),
       Layer.provide(SqlChannelStore.layer),
       Layer.provide(Ingest.layer(["nfl", "fbs"])),
       Layer.provide(EspnProvider.layer),
```

- [ ] **Step 6: Resolve tiles in Stage sessions by availability**

Replace `apps/hub/src/stage/StageSessions.ts`:

```ts
import type { GameId } from "@sportal/domain/Game"
import { ChannelAvailability } from "@sportal/domain/Source"
import { Stage, type StageCommand, type StageRejection } from "@sportal/domain/Stage"
import { Context, Effect, Layer, Result, type Stream, SubscriptionRef } from "effect"
import { Ingest } from "../ingest/Ingest.ts"
import { Source } from "../source/Source.ts"

export class StageSessions extends Context.Service<
  StageSessions,
  {
    readonly stage: Effect.Effect<Stage>
    readonly changes: Stream.Stream<Stage>
    dispatch(command: StageCommand): Effect.Effect<Stage, StageRejection>
  }
>()("sportal/hub/StageSessions") {
  static readonly layer = Layer.effect(
    StageSessions,
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const source = yield* Source
      const current = yield* SubscriptionRef.make(Stage.initial)

      const dispatch = Effect.fn("StageSessions.dispatch")(function* (command: StageCommand) {
        const availabilityOf = yield* availabilityOnSlate(ingest, source)
        // One atomic step: concurrent dispatches queue up, and a rejection leaves the Stage as it was.
        return yield* SubscriptionRef.modifyEffect(current, (stage) => {
          const result = stage.apply(command, availabilityOf)
          return Result.isFailure(result)
            ? Effect.fail(result.failure)
            : Effect.succeed([result.success, result.success] as const)
        })
      })

      return StageSessions.of({
        stage: SubscriptionRef.get(current),
        changes: SubscriptionRef.changes(current),
        dispatch
      })
    })
  )
}

/** Where each game on the current slate can be streamed; a game no longer on the slate is not carried. */
function availabilityOnSlate(ingest: typeof Ingest.Service, source: typeof Source.Service) {
  return Effect.gen(function* () {
    const slate = yield* ingest.slate
    const lineup = yield* source.lineup
    return (id: GameId): ChannelAvailability => {
      const game = slate.find((candidate) => candidate.id === id)
      return game === undefined ? ChannelAvailability.NotCarried() : lineup.availabilityOf(game)
    }
  })
}
```

Replace `apps/hub/src/stage/StageSessions.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId, Network } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Layer, Stream } from "effect"
import { Ingest } from "../ingest/Ingest.ts"
import * as YouTubeTv from "../source/YouTubeTv.ts"
import { StageSessions } from "./StageSessions.ts"

const espn = Network.make("ESPN")
const espnPlus = Network.make("ESPN+")
const espnChannel = {
  network: espn,
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn" }
}
const slate = [game("1", [espn]), game("2", [espn]), game("3", [espn]), game("4", [espnPlus])]

const TestSessions = StageSessions.layer.pipe(
  Layer.provide(Layer.succeed(Ingest, Ingest.of({ slate: Effect.succeed(slate), changes: Stream.empty }))),
  Layer.provide(
    YouTubeTv.layer([
      { _tag: "Carried", channel: espnChannel },
      { _tag: "NotCarried", network: espnPlus, source: "YouTube TV" }
    ])
  )
)

describe("StageSessions", () => {
  it.effect("applies concurrent commands without losing any", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* Effect.all(
        slate.map((snapshot, tile) => sessions.dispatch({ _tag: "Assign", tile, game: snapshot.id })),
        { concurrency: "unbounded" }
      )
      const stage = yield* sessions.stage
      assert.isTrue(stage.tiles.every((tile) => tile._tag !== "Empty"))
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("rejects a command for a missing tile and leaves the stage unchanged", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
      const before = yield* sessions.stage
      const rejection = yield* sessions.dispatch({ _tag: "FocusAudio", tile: 9 }).pipe(Effect.flip)
      assert.strictEqual(rejection.reason, "no-such-tile")
      assert.deepStrictEqual(yield* sessions.stage, before)
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("assigns a carried game as a stream tile and any other as a data tile", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
      const stage = yield* sessions.dispatch({ _tag: "Assign", tile: 1, game: GameId.make("4") })
      assert.deepStrictEqual(stage.tiles[0], {
        _tag: "StreamTile",
        game: GameId.make("1"),
        channel: espnChannel
      })
      assert.deepStrictEqual(stage.tiles[1], { _tag: "DataTile", game: GameId.make("4") })
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("assigns a game missing from the slate as a data tile", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      const stage = yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("gone") })
      assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: GameId.make("gone") })
    }).pipe(Effect.provide(TestSessions))
  )
})

function game(id: string, broadcasts: ReadonlyArray<Network>) {
  return snapshot({ id: GameId.make(id), status: "live", period: 1, clock: "10:00", broadcasts })
}
```

Apply this change to `apps/hub/src/http/HubServer.test.ts`:

```diff
--- a/apps/hub/src/http/HubServer.test.ts
+++ b/apps/hub/src/http/HubServer.test.ts
@@ -12,6 +12,12 @@ import * as YouTubeTv from "../source/YouTubeTv.ts"
 import { StageSessions } from "../stage/StageSessions.ts"
 import { ApiHandlers } from "./HubServer.ts"
 
+const espnChannel = {
+  network: Network.make("ESPN"),
+  source: "YouTube TV" as const,
+  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn" }
+}
+
 const game = snapshot({
   id: GameId.make("401856707"),
   home: { team: team("MSST"), score: 0 },
@@ -21,7 +27,7 @@ const game = snapshot({
 
 const TestHub = ApiHandlers.pipe(
   Layer.provide(StageSessions.layer),
-  Layer.provide(YouTubeTv.layer({ ESPN: "https://tv.youtube.com/watch/espn" })),
+  Layer.provide(YouTubeTv.layer([{ _tag: "Carried", channel: espnChannel }])),
   Layer.provide(Ingest.layer(["fbs"])),
   Layer.provide(Layer.succeed(Provider, Provider.of({ slate: () => Effect.succeed([game]) })))
 )
@@ -45,7 +51,7 @@ layer(Layer.mergeAll(TestHub, HttpServer.layerServices))("Hub API", (it) => {
       assert.deepStrictEqual(stage.tiles[0], {
         _tag: "StreamTile",
         game: game.id,
-        locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/espn" }
+        channel: espnChannel
       })
 
       const rejected = yield* client.stage
```

- [ ] **Step 7: Keep the web UI compiling**

Apply this change to `apps/web/src/stage/StageView.tsx`:

```diff
--- a/apps/web/src/stage/StageView.tsx
+++ b/apps/web/src/stage/StageView.tsx
@@ -73,12 +73,14 @@ function TileBody(props: { tile: Tile }) {
   switch (props.tile._tag) {
     case "Empty":
       return <span>Pick a game from the slate</span>
+    case "PickingChannel":
+      return <span>No {props.tile.network} channel known yet</span>
     case "DataTile":
       return <span>No stream for this game on your sources</span>
     case "StreamTile":
       // Inside the shell this is covered by the provider view. In a plain browser it is the way to watch.
       return (
-        <a className="underline" href={props.tile.locator.url} target="_blank" rel="noreferrer">
+        <a className="underline" href={props.tile.channel.locator.url} target="_blank" rel="noreferrer">
           Open in YouTube TV
         </a>
       )
@@ -93,7 +95,7 @@ function placements(stage: Stage, videoAreas: ReadonlyArray<HTMLDivElement | nul
     return [
       {
         tile: index,
-        url: tile.locator.url,
+        url: tile.channel.locator.url,
         bounds: {
           x: Math.round(rect.x),
           y: Math.round(rect.y),
```

This picking-tile body is temporary; Task 9 gives the tile its real UI.

- [ ] **Step 8: Add the words**

Apply this change to `CONTEXT.md`:

```diff
--- a/CONTEXT.md
+++ b/CONTEXT.md
@@ -77,7 +77,8 @@ Provider and Source are the two words most likely to be swapped. Provider is alw
 | **Stage command** | An instruction to change a Stage: assign, clear, or focus audio. Issued by people and by the Director alike. | action, event |
 | **Stage rejection** | The reason a stage command was refused. | error |
 | **Layout** | A named arrangement of tile slots. | grid, template |
-| **Tile** | One slot's content: a **stream tile**, a **data tile**, or empty. | pane, cell, window |
+| **Tile** | One slot's content: a **stream tile**, a **picking tile**, a **data tile**, or empty. | pane, cell, window |
+| **Picking tile** | A tile showing a source's guide until its game's network has a channel; `PickingChannel` in code. | setup tile |
 | **Main tile** | The largest slot of a layout. | hero, primary |
 | **Audio focus** | The single tile whose sound is on. | active, unmuted |
 | **Promote** | Move a game into the main tile. | feature |
```

- [ ] **Step 9: Check**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and every test passes.

- [ ] **Step 10: Commit**

```bash
git add CONTEXT.md packages/domain/src apps/hub/src apps/web/src/stage/StageView.tsx
git commit -m "feat(domain): tiles resolve by channel availability, picking tiles, and refresh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: YouTube TV learns channels and keeps them in the channel store

**Files:**
- Modify: `apps/hub/src/source/Source.ts` (port grows `changes`, `learn`, `markNotCarried`, `forget`)
- Modify: `apps/hub/src/source/YouTubeTv.ts` (lineup in a ref backed by the channel store; `LiveChannelUrl`)
- Test: `apps/hub/src/source/YouTubeTv.test.ts`
- Modify: `apps/hub/src/main.ts`, `apps/hub/src/stage/StageSessions.test.ts`, `apps/hub/src/http/HubServer.test.ts`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `ChannelStore`, `ChannelStoreError` from Task 3; `ChannelLineup`, `ChannelUrlRefused` from `@sportal/domain/Source` (Task 2).
- Produces:
  - `Source` port: `lineup`; `changes: Stream<void>` (once after every change, never the current value); `learn(network, url): Effect<void, ChannelUrlRefused | ChannelStoreError>`; `markNotCarried(network)`, `forget(network)`: `Effect<void, ChannelStoreError>`.
  - `YouTubeTv.layer: Layer<Source, ChannelStoreError, ChannelStore>` — loads the store's carriages into its lineup at start; each write goes to the store first, then to the lineup, one at a time.
  - `YouTubeTv.LiveChannelUrl` — a schema from `string` to `string`. It decodes `https://tv.youtube.com/watch/<id>` with any query to `https://tv.youtube.com/watch/<id>?vp=0gEEEgIwAQ%3D%3D` and fails on anything else.

- [ ] **Step 1: Write the failing test**

The four addresses are the ones recorded from the live guide on 2026-10-03.

Create `apps/hub/src/source/YouTubeTv.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import { ChannelAvailability } from "@sportal/domain/Source"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import * as Database from "../database/Database.ts"
import { ChannelStore } from "./ChannelStore.ts"
import { Source } from "./Source.ts"
import * as SqlChannelStore from "./SqlChannelStore.ts"
import * as YouTubeTv from "./YouTubeTv.ts"

// Addresses recorded from YouTube TV's live guide on 2026-10-03.
const cbsLive = "https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D"
const foxLive = "https://tv.youtube.com/watch/_MpmFlh-Wzc?vp=0gEEEgIwAQ%3D%3D"
const foxFromTheBeginning =
  "https://tv.youtube.com/watch/_MpmFlh-Wzc?vpp=gAKAzYTWBg%3D%3D&vp=0gEKEgIwARiAzYTWBg%3D%3D"

const espn = Network.make("ESPN")
const disney = Network.make("Disney+")
const onEspn = snapshot({ broadcasts: [espn] })
const onEspnAndDisney = snapshot({ broadcasts: [disney, espn] })
const guide = { _tag: "WebView" as const, url: "https://tv.youtube.com/live" }
const decodeLive = Schema.decodeUnknownOption(YouTubeTv.LiveChannelUrl)

describe("YouTubeTv.LiveChannelUrl", () => {
  it("keeps a live channel address as it is", () => {
    assert.deepStrictEqual(decodeLive(cbsLive), Option.some(cbsLive))
  })

  it("decodes a from-the-beginning address to the live address for the same channel", () => {
    assert.deepStrictEqual(decodeLive(foxFromTheBeginning), Option.some(foxLive))
  })

  it.each([
    "https://tv.youtube.com/live",
    "https://tv.youtube.com/watch/",
    "https://tv.youtube.com/watch/abc/extra",
    "http://tv.youtube.com/watch/abc",
    "https://www.youtube.com/watch/abc",
    "https://tv.youtube.com.evil.example/watch/abc",
    "not a url"
  ])("refuses %s", (url) => {
    assert.isTrue(Option.isNone(decodeLive(url)))
  })
})

describe("YouTubeTv source", () => {
  it.effect("starts with every network unlearned, pointing at the live guide", () =>
    Effect.gen(function* () {
      const lineup = yield* (yield* Source).lineup
      assert.deepStrictEqual(
        lineup.availabilityOf(onEspn),
        ChannelAvailability.Unlearned({ network: espn, source: "YouTube TV", guide })
      )
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("learns a channel from a guide address and keeps its live address", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, foxFromTheBeginning)
      assert.deepStrictEqual(
        (yield* source.lineup).availabilityOf(onEspn),
        ChannelAvailability.Carried({
          channel: { network: espn, source: "YouTube TV", locator: { _tag: "WebView", url: foxLive } }
        })
      )
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("refuses to learn an address that is not a channel, and learns nothing", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const error = yield* source.learn(espn, "https://tv.youtube.com/live").pipe(Effect.flip)
      assert.strictEqual(error._tag, "ChannelUrlRefused")
      assert.strictEqual((yield* source.lineup).availabilityOf(onEspn)._tag, "Unlearned")
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("moves on to the next network once one is marked not carried", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.markNotCarried(disney)
      assert.deepStrictEqual(
        (yield* source.lineup).availabilityOf(onEspnAndDisney),
        ChannelAvailability.Unlearned({ network: espn, source: "YouTube TV", guide })
      )
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("forgets a learned channel", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, cbsLive)
      yield* source.forget(espn)
      assert.strictEqual((yield* source.lineup).availabilityOf(onEspn)._tag, "Unlearned")
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("signals a change after each write, not before", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const signals = yield* source.changes.pipe(Stream.take(2), Stream.runCount, Effect.forkChild)
      yield* Effect.yieldNow
      yield* source.learn(espn, cbsLive)
      yield* source.markNotCarried(disney)
      assert.strictEqual(yield* Fiber.join(signals), 2)
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("loads what the channel store already holds", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* (yield* Source).lineup).availabilityOf(onEspn)._tag, "Carried")
    }).pipe(Effect.provide(YouTubeTv.layer.pipe(Layer.provide(storeKnowingEspn()))))
  )
})

/** The source over a fresh in-memory database. */
function testSource() {
  return YouTubeTv.layer.pipe(Layer.provide(SqlChannelStore.layer), Layer.provide(Database.layer(":memory:")))
}

/** An in-memory channel store that already holds ESPN's channel when the source starts. */
function storeKnowingEspn() {
  return Layer.effect(
    ChannelStore,
    Effect.gen(function* () {
      const store = yield* ChannelStore
      yield* store.record({
        _tag: "Carried",
        channel: { network: espn, source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } }
      })
      return store
    })
  ).pipe(Layer.provide(SqlChannelStore.layer), Layer.provide(Database.layer(":memory:")))
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/hub/src/source/YouTubeTv.test.ts`
Expected: FAIL — `YouTubeTv.LiveChannelUrl` is undefined, and `YouTubeTv.layer` is still a function of a list.

- [ ] **Step 3: Grow the port**

Replace `apps/hub/src/source/Source.ts`:

```ts
import type { Network } from "@sportal/domain/Game"
import type { ChannelLineup, ChannelUrlRefused } from "@sportal/domain/Source"
import { Context, type Effect, type Stream } from "effect"
import type { ChannelStoreError } from "./ChannelStore.ts"

export class Source extends Context.Service<
  Source,
  {
    /** The channels this source has learned so far. */
    readonly lineup: Effect.Effect<ChannelLineup>
    /** Emits once after every change to the lineup. */
    readonly changes: Stream.Stream<void>
    /** Remembers the channel at `url` as where this source carries `network`. */
    learn(network: Network, url: string): Effect.Effect<void, ChannelUrlRefused | ChannelStoreError>
    markNotCarried(network: Network): Effect.Effect<void, ChannelStoreError>
    forget(network: Network): Effect.Effect<void, ChannelStoreError>
  }
>()("sportal/hub/Source") {}
```

- [ ] **Step 4: Write the store-backed source**

Replace `apps/hub/src/source/YouTubeTv.ts`:

```ts
import { type ChannelCarriage, ChannelLineup, ChannelUrlRefused } from "@sportal/domain/Source"
import { Effect, Layer, Schema, SchemaTransformation, Stream, SubscriptionRef } from "effect"
import { ChannelStore } from "./ChannelStore.ts"
import { Source } from "./Source.ts"

/** YouTube TV as a source. Its channels are learned from the live guide and kept in the channel store. */
export const layer = Layer.effect(
  Source,
  Effect.gen(function* () {
    const store = yield* ChannelStore
    const lineup = yield* SubscriptionRef.make(
      new ChannelLineup({ source: "YouTube TV", guide, carriages: yield* store.carriages })
    )

    // Store first, then memory, one write at a time: a failed write changes nothing.
    const record = (carriage: ChannelCarriage) =>
      SubscriptionRef.updateEffect(lineup, (current) =>
        store.record(carriage).pipe(Effect.as(current.record(carriage)))
      )

    return Source.of({
      lineup: SubscriptionRef.get(lineup),
      // The ref's current value comes first on every subscription; only later values are changes.
      changes: SubscriptionRef.changes(lineup).pipe(Stream.drop(1), Stream.as(undefined)),
      learn: (network, url) =>
        decodeLiveChannelUrl(url).pipe(
          Effect.mapError(() => new ChannelUrlRefused()),
          Effect.flatMap((live) =>
            record({
              _tag: "Carried",
              channel: { network, source: "YouTube TV", locator: { _tag: "WebView", url: live } }
            })
          )
        ),
      markNotCarried: (network) => record({ _tag: "NotCarried", network, source: "YouTube TV" }),
      forget: (network) =>
        SubscriptionRef.updateEffect(lineup, (current) =>
          store.forget(network, "YouTube TV").pipe(Effect.as(current.forget(network)))
        )
    })
  })
)

/**
 * A YouTube TV channel address, decoded to the address that plays the channel live. A guide pick can
 * carry a start point ("from the beginning"); keeping it would replay every later game on the channel
 * from that moment, so decoding keeps only the channel's id and the live flag.
 */
export const LiveChannelUrl = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^https:\/\/tv\.youtube\.com\/watch\/[A-Za-z0-9_-]+(\?.*)?$/)),
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (url) => `https://tv.youtube.com${new URL(url).pathname}?vp=${live}`,
      encode: (url) => url
    })
  )
)

const decodeLiveChannelUrl = Schema.decodeEffect(LiveChannelUrl)

const live = "0gEEEgIwAQ%3D%3D"

const guide = { _tag: "WebView", url: "https://tv.youtube.com/live" } as const
```

The pattern is the whole rule: `https`, exactly `tv.youtube.com`, `/watch/` and one id segment, then any query. `decode` only runs on an address that passed it, so `new URL(url)` cannot throw. `SubscriptionRef.updateEffect` makes each write one step: concurrent writes queue, and a store failure leaves the lineup unchanged. `SubscriptionRef.changes` replays the current value to each new subscriber, so `changes` drops that first element.

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm vitest run apps/hub/src/source/YouTubeTv.test.ts`
Expected: `Tests  16 passed (16)`.

- [ ] **Step 6: Wire it**

Apply this change to `apps/hub/src/main.ts`:

```diff
--- a/apps/hub/src/main.ts
+++ b/apps/hub/src/main.ts
@@ -28,7 +28,7 @@ const Hub = Layer.unwrap(
 
     return HttpRouter.serve(routes).pipe(
       Layer.provide(StageSessions.layer),
-      Layer.provide(YouTubeTv.layer([])),
+      Layer.provide(YouTubeTv.layer),
       Layer.provide(SqlChannelStore.layer),
       Layer.provide(Ingest.layer(["nfl", "fbs"])),
       Layer.provide(EspnProvider.layer),
```

Replace `apps/hub/src/stage/StageSessions.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId, Network } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Layer, Stream } from "effect"
import * as Database from "../database/Database.ts"
import { Ingest } from "../ingest/Ingest.ts"
import { Source } from "../source/Source.ts"
import * as SqlChannelStore from "../source/SqlChannelStore.ts"
import * as YouTubeTv from "../source/YouTubeTv.ts"
import { StageSessions } from "./StageSessions.ts"

const espn = Network.make("ESPN")
const espnPlus = Network.make("ESPN+")
const espnChannel = {
  network: espn,
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn?vp=0gEEEgIwAQ%3D%3D" }
}
const slate = [game("1", [espn]), game("2", [espn]), game("3", [espn]), game("4", [espnPlus])]

const TestSessions = StageSessions.layer.pipe(
  Layer.provide(Layer.succeed(Ingest, Ingest.of({ slate: Effect.succeed(slate), changes: Stream.empty }))),
  Layer.provide(sourceKnowingEspn())
)

describe("StageSessions", () => {
  it.effect("applies concurrent commands without losing any", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* Effect.all(
        slate.map((snapshot, tile) => sessions.dispatch({ _tag: "Assign", tile, game: snapshot.id })),
        { concurrency: "unbounded" }
      )
      const stage = yield* sessions.stage
      assert.isTrue(stage.tiles.every((tile) => tile._tag !== "Empty"))
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("rejects a command for a missing tile and leaves the stage unchanged", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
      const before = yield* sessions.stage
      const rejection = yield* sessions.dispatch({ _tag: "FocusAudio", tile: 9 }).pipe(Effect.flip)
      assert.strictEqual(rejection.reason, "no-such-tile")
      assert.deepStrictEqual(yield* sessions.stage, before)
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("assigns a carried game as a stream tile and any other as a data tile", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
      const stage = yield* sessions.dispatch({ _tag: "Assign", tile: 1, game: GameId.make("4") })
      assert.deepStrictEqual(stage.tiles[0], {
        _tag: "StreamTile",
        game: GameId.make("1"),
        channel: espnChannel
      })
      assert.deepStrictEqual(stage.tiles[1], { _tag: "DataTile", game: GameId.make("4") })
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("assigns a game missing from the slate as a data tile", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      const stage = yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("gone") })
      assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: GameId.make("gone") })
    }).pipe(Effect.provide(TestSessions))
  )
})

function game(id: string, broadcasts: ReadonlyArray<Network>) {
  return snapshot({ id: GameId.make(id), status: "live", period: 1, clock: "10:00", broadcasts })
}

/** YouTube TV over an in-memory database, already knowing ESPN's channel and that ESPN+ is not carried. */
function sourceKnowingEspn() {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, "https://tv.youtube.com/watch/espn")
      yield* source.markNotCarried(espnPlus)
    })
  ).pipe(
    Layer.provideMerge(YouTubeTv.layer),
    Layer.provide(SqlChannelStore.layer),
    Layer.provide(Database.layer(":memory:"))
  )
}
```

Apply this change to `apps/hub/src/http/HubServer.test.ts`:

```diff
--- a/apps/hub/src/http/HubServer.test.ts
+++ b/apps/hub/src/http/HubServer.test.ts
@@ -7,17 +7,13 @@ import { DateTime, Effect, Layer } from "effect"
 import { HttpServer } from "effect/http"
 import { HttpApiTest } from "effect/http-api"
+import * as Database from "../database/Database.ts"
 import { Ingest } from "../ingest/Ingest.ts"
 import { Provider } from "../provider/Provider.ts"
+import * as SqlChannelStore from "../source/SqlChannelStore.ts"
 import * as YouTubeTv from "../source/YouTubeTv.ts"
 import { StageSessions } from "../stage/StageSessions.ts"
 import { ApiHandlers } from "./HubServer.ts"
 
-const espnChannel = {
-  network: Network.make("ESPN"),
-  source: "YouTube TV" as const,
-  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn" }
-}
-
 const game = snapshot({
   id: GameId.make("401856707"),
   home: { team: team("MSST"), score: 0 },
@@ -27,7 +23,9 @@ const game = snapshot({
 
 const TestHub = ApiHandlers.pipe(
   Layer.provide(StageSessions.layer),
-  Layer.provide(YouTubeTv.layer([{ _tag: "Carried", channel: espnChannel }])),
+  Layer.provide(YouTubeTv.layer),
+  Layer.provide(SqlChannelStore.layer),
+  Layer.provide(Database.layer(":memory:")),
   Layer.provide(Ingest.layer(["fbs"])),
   Layer.provide(Layer.succeed(Provider, Provider.of({ slate: () => Effect.succeed([game]) })))
 )
@@ -35,7 +33,7 @@ const TestHub = ApiHandlers.pipe(
 const makeClient = HttpApiTest.groups(SportalApi, ["slate", "stage"])
 
 layer(Layer.mergeAll(TestHub, HttpServer.layerServices))("Hub API", (it) => {
-  it.effect("serves the slate and turns an assignment into a stream tile", () =>
+  it.effect("serves the slate and turns an assignment on an unlearned network into a picking tile", () =>
     Effect.gen(function* () {
       const client = yield* makeClient
       // Let the ingest loop's first poll run.
@@ -49,9 +47,11 @@ layer(Layer.mergeAll(TestHub, HttpServer.layerServices))("Hub API", (it) => {
         payload: { command: { _tag: "Assign", tile: 0, game: game.id } }
       })
       assert.deepStrictEqual(stage.tiles[0], {
-        _tag: "StreamTile",
+        _tag: "PickingChannel",
         game: game.id,
-        channel: espnChannel
+        network: Network.make("ESPN"),
+        source: "YouTube TV",
+        guide: { _tag: "WebView", url: "https://tv.youtube.com/live" }
       })
 
       const rejected = yield* client.stage
```

With an empty store, an ESPN game is now a picking tile; Task 6 rewrites this test around the channels API.

- [ ] **Step 7: Add the word**

Apply this change to `CONTEXT.md`:

```diff
--- a/CONTEXT.md
+++ b/CONTEXT.md
@@ -51,6 +51,7 @@ Every exported type name must be a term here.
 | **Channel store** | Where the Hub keeps the channel carriages it has learned. | channel repository |
 | **Channel store error** | The channel store could not read or write. | database error |
 | **Database** | The Hub's SQLite database. Each store migrates its own tables in it. | store, persistence |
+| **Live channel URL** | A source's address for a channel, reduced to the one that plays it live. | canonical URL |
 | **Stream** | One playing instance of a game from a source. | feed, video |
 | **StreamLocator** | What a Display must load to play a stream. | URL, link |
```

- [ ] **Step 8: Check**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and every test passes.

- [ ] **Step 9: Commit**

```bash
git add CONTEXT.md apps/hub/src
git commit -m "feat(hub): YouTube TV learns channels and keeps them in the channel store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Channels API, and the Stage follows what the source learns

**Files:**
- Modify: `packages/api/src/SportalApi.ts` (the `channels` group)
- Modify: `apps/hub/src/http/HubServer.ts` (its handlers)
- Modify: `apps/hub/src/stage/StageSessions.ts` (refresh on `Source.changes`)
- Test: `apps/hub/src/http/HubServer.test.ts` (rewritten; includes the deferred `/api/live` end-to-end test and waits for the first non-empty slate instead of a single yield), `apps/hub/src/stage/StageSessions.test.ts`

**Interfaces:**
- Consumes: the `Source` port from Task 5; `Stage#refresh` from Task 4.
- Produces:
  - `SportalApi` group `channels`: `learn` `POST /api/channels/learn` `{ network, url }` → 204, or 422 `ChannelUrlRefused`; `notCarried` `POST /api/channels/not-carried` `{ network }` → 204; `forget` `POST /api/channels/forget` `{ network }` → 204. A typed client calls them as `client.channels.learn({ payload })` and so on.
  - A channel store failure in these handlers is a defect (HTTP 500): the client cannot fix it.
  - `StageSessions` applies `stage.refresh` after every source change and publishes the new Stage through the existing live stream.

- [ ] **Step 1: Write the failing tests**

Replace `apps/hub/src/http/HubServer.test.ts`:

```ts
import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { GameId, Network } from "@sportal/domain/Game"
import { snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/http"
import { HttpApiClient, HttpApiTest } from "effect/http-api"
import * as Database from "../database/Database.ts"
import { Ingest } from "../ingest/Ingest.ts"
import { Provider } from "../provider/Provider.ts"
import * as SqlChannelStore from "../source/SqlChannelStore.ts"
import * as YouTubeTv from "../source/YouTubeTv.ts"
import { StageSessions } from "../stage/StageSessions.ts"
import * as HubServer from "./HubServer.ts"

const espn = Network.make("ESPN")
const espnLive = "https://tv.youtube.com/watch/espn?vp=0gEEEgIwAQ%3D%3D"
const game = snapshot({
  id: GameId.make("401856707"),
  status: "live",
  home: { team: team("MSST"), score: 0 },
  away: { team: team("ALA"), score: 0 },
  broadcasts: [espn]
})
const picking = {
  _tag: "PickingChannel",
  game: game.id,
  network: espn,
  source: "YouTube TV",
  guide: { _tag: "WebView", url: "https://tv.youtube.com/live" }
} as const
const streaming = {
  _tag: "StreamTile",
  game: game.id,
  channel: { network: espn, source: "YouTube TV", locator: { _tag: "WebView", url: espnLive } }
} as const

const makeClient = HttpApiTest.groups(SportalApi, ["slate", "stage", "channels"])

describe("Hub API", () => {
  it.effect("serves the slate and turns an assignment on an unlearned network into a picking tile", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      yield* firstSlate()

      const slate = yield* client.slate.current()
      assert.strictEqual(slate[0]?.away.team.abbreviation, "ALA")
      assert.isTrue(DateTime.isDateTime(slate[0]?.kickoff))

      const stage = yield* client.stage.dispatch({
        payload: { command: { _tag: "Assign", tile: 0, game: game.id } }
      })
      assert.deepStrictEqual(stage.tiles[0], picking)

      const rejected = yield* client.stage
        .dispatch({ payload: { command: { _tag: "Clear", tile: 9 } } })
        .pipe(Effect.flip)
      assert.strictEqual(rejected._tag, "StageRejection")
    }).pipe(Effect.provide(apiUnderTest()))
  )

  it.effect("learns a channel, and the picking tile becomes a stream tile", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      yield* firstSlate()
      yield* client.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })

      yield* client.channels.learn({ payload: { network: espn, url: "https://tv.youtube.com/watch/espn" } })
      assert.deepStrictEqual((yield* client.stage.current()).tiles[0], streaming)

      yield* client.channels.forget({ payload: { network: espn } })
      assert.deepStrictEqual((yield* client.stage.current()).tiles[0], picking)

      yield* client.channels.notCarried({ payload: { network: espn } })
      assert.deepStrictEqual((yield* client.stage.current()).tiles[0], { _tag: "DataTile", game: game.id })
    }).pipe(Effect.provide(apiUnderTest()))
  )

  it.effect("refuses to learn an address that is not a channel", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const error = yield* client.channels
        .learn({ payload: { network: espn, url: "https://tv.youtube.com/live" } })
        .pipe(Effect.flip)
      assert.strictEqual(error._tag, "ChannelUrlRefused")
    }).pipe(Effect.provide(apiUnderTest()))
  )
})

describe("GET /api/live", () => {
  it.effect("streams the current slate and stage first, then each change, as server-sent events", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const api = yield* HttpApiClient.make(SportalApi)
      yield* firstSlate()

      const response = yield* http.get("/api/live")
      assert.strictEqual(response.headers["content-type"], "text/event-stream")
      const messages = response.stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line !== ""),
        Stream.map((line) => {
          // Each event is one line, `data: <json>`, followed by a blank line.
          assert.isTrue(line.startsWith("data: "))
          return Schema.decodeUnknownSync(LiveMessageJson)(line.slice("data: ".length))
        })
      )

      const pulled = yield* messages.pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
      yield* api.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })
      const [first, second, third] = yield* Fiber.join(pulled)

      assert.sameMembers([first?._tag, second?._tag], ["SlateChanged", "StageChanged"])
      assert.deepStrictEqual(third?._tag === "StageChanged" ? third.stage.tiles[0] : third, picking)
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )
})

/** Waits until the ingest loop has published its first slate. */
function firstSlate() {
  return Effect.gen(function* () {
    const ingest = yield* Ingest
    yield* ingest.changes.pipe(
      Stream.filter((slate) => slate.length > 0),
      Stream.take(1),
      Stream.runDrain
    )
  })
}

function apiUnderTest() {
  return HubServer.ApiHandlers.pipe(
    Layer.provideMerge(hubUnderTest()),
    Layer.provideMerge(HttpServer.layerServices)
  )
}

/** Everything behind the API, over a fresh in-memory database and a provider that always returns `game`. */
function hubUnderTest() {
  return StageSessions.layer.pipe(
    Layer.provideMerge(YouTubeTv.layer),
    Layer.provide(SqlChannelStore.layer),
    Layer.provide(Database.layer(":memory:")),
    Layer.provideMerge(Ingest.layer(["fbs"])),
    Layer.provide(Layer.succeed(Provider, Provider.of({ slate: () => Effect.succeed([game]) })))
  )
}

/** The Hub's routes served on an ephemeral port, with an HTTP client pointed at them. */
function serverUnderTest() {
  return HttpRouter.serve(HubServer.layer, { disableLogger: true }).pipe(
    Layer.provideMerge(hubUnderTest()),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
}
```

The live-stream test serves the real routes on an ephemeral port with `NodeHttpServer.layerTest`, which also provides an `HttpClient` pointed at it.

Apply this change to `apps/hub/src/stage/StageSessions.test.ts`:

```diff
--- a/apps/hub/src/stage/StageSessions.test.ts
+++ b/apps/hub/src/stage/StageSessions.test.ts
@@ -2,7 +2,7 @@ import { assert, describe, it } from "@effect/vitest"
 import { GameId, Network } from "@sportal/domain/Game"
 import { snapshot } from "@sportal/domain/TestGame"
-import { Effect, Layer, Stream } from "effect"
+import { Effect, Layer, Option, Stream } from "effect"
 import * as Database from "../database/Database.ts"
 import { Ingest } from "../ingest/Ingest.ts"
 import { Source } from "../source/Source.ts"
@@ -18,11 +18,18 @@ const espnChannel = {
   source: "YouTube TV" as const,
   locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn?vp=0gEEEgIwAQ%3D%3D" }
 }
-const slate = [game("1", [espn]), game("2", [espn]), game("3", [espn]), game("4", [espnPlus])]
+const fox = Network.make("FOX")
+const slate = [
+  game("1", [espn]),
+  game("2", [espn]),
+  game("3", [espn]),
+  game("4", [espnPlus]),
+  game("5", [fox])
+]
 
 const TestSessions = StageSessions.layer.pipe(
   Layer.provide(Layer.succeed(Ingest, Ingest.of({ slate: Effect.succeed(slate), changes: Stream.empty }))),
-  Layer.provide(sourceKnowingEspn())
+  Layer.provideMerge(sourceKnowingEspn())
 )
 
 describe("StageSessions", () => {
@@ -30,7 +37,9 @@ describe("StageSessions", () => {
     Effect.gen(function* () {
       const sessions = yield* StageSessions
       yield* Effect.all(
-        slate.map((snapshot, tile) => sessions.dispatch({ _tag: "Assign", tile, game: snapshot.id })),
+        slate
+          .slice(0, 4)
+          .map((snapshot, tile) => sessions.dispatch({ _tag: "Assign", tile, game: snapshot.id })),
         { concurrency: "unbounded" }
       )
       const stage = yield* sessions.stage
@@ -63,6 +72,22 @@ describe("StageSessions", () => {
     }).pipe(Effect.provide(TestSessions))
   )
 
+  it.effect("refreshes the stage when the source learns a channel", () =>
+    Effect.gen(function* () {
+      const sessions = yield* StageSessions
+      const picking = yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })
+      assert.strictEqual(picking.tiles[0]?._tag, "PickingChannel")
+
+      yield* (yield* Source).learn(fox, "https://tv.youtube.com/watch/fox")
+      const stage = yield* sessions.changes.pipe(
+        Stream.filter((stage) => stage.tiles[0]?._tag === "StreamTile"),
+        Stream.take(1),
+        Stream.runHead
+      )
+      assert.isTrue(Option.isSome(stage))
+    }).pipe(Effect.provide(TestSessions))
+  )
+
   it.effect("assigns a game missing from the slate as a data tile", () =>
     Effect.gen(function* () {
       const sessions = yield* StageSessions
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/hub`
Expected: FAIL — the typecheck in the editor flags `client.channels`; at run time the channel tests fail and the refresh test times out.

- [ ] **Step 3: Add the endpoints**

Replace `packages/api/src/SportalApi.ts`:

```ts
import { GameSnapshot, Network } from "@sportal/domain/Game"
import { ChannelUrlRefused } from "@sportal/domain/Source"
import { Stage, StageCommand, StageRejection } from "@sportal/domain/Stage"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"

export class SportalApi extends HttpApi.make("sportal")
  .add(
    HttpApiGroup.make("slate").add(
      HttpApiEndpoint.get("current", "/slate", { success: Schema.Array(GameSnapshot) })
    )
  )
  .add(
    HttpApiGroup.make("stage").add(
      HttpApiEndpoint.get("current", "/stage", { success: Stage }),
      HttpApiEndpoint.post("dispatch", "/stage/commands", {
        payload: Schema.Struct({ command: StageCommand }),
        success: Stage,
        error: StageRejection
      })
    )
  )
  .add(
    // What the source knows about each network. These change every Display and every later game, so
    // they are not stage commands; the Stage follows through the live stream.
    HttpApiGroup.make("channels").add(
      HttpApiEndpoint.post("learn", "/channels/learn", {
        payload: Schema.Struct({ network: Network, url: Schema.String }),
        success: HttpApiSchema.NoContent,
        error: ChannelUrlRefused
      }),
      HttpApiEndpoint.post("notCarried", "/channels/not-carried", {
        payload: Schema.Struct({ network: Network }),
        success: HttpApiSchema.NoContent
      }),
      HttpApiEndpoint.post("forget", "/channels/forget", {
        payload: Schema.Struct({ network: Network }),
        success: HttpApiSchema.NoContent
      })
    )
  )
  .prefix("/api") {}
```

Apply this change to `apps/hub/src/http/HubServer.ts`:

```diff
--- a/apps/hub/src/http/HubServer.ts
+++ b/apps/hub/src/http/HubServer.ts
@@ -4,10 +4,11 @@ import { Effect, Layer, Schema, Stream } from "effect"
 import { HttpRouter, HttpServerResponse } from "effect/http"
 import { HttpApiBuilder } from "effect/http-api"
 import { Ingest } from "../ingest/Ingest.ts"
+import { Source } from "../source/Source.ts"
 import { StageSessions } from "../stage/StageSessions.ts"
 
 /** The handlers for every endpoint group in SportalApi. Exported so tests can drive them without a socket. */
-export const ApiHandlers = Layer.mergeAll(slateHandlers(), stageHandlers())
+export const ApiHandlers = Layer.mergeAll(slateHandlers(), stageHandlers(), channelHandlers())
 
 /** Every route the Hub serves: the API, and the live stream. */
 export const layer = Layer.mergeAll(
@@ -40,6 +41,25 @@ function stageHandlers() {
   )
 }
 
+function channelHandlers() {
+  return HttpApiBuilder.group(
+    SportalApi,
+    "channels",
+    Effect.fn(function* (handlers) {
+      const source = yield* Source
+      // A channel store that cannot be written is not something a client can fix: it is a server error.
+      return handlers.handleAll({
+        learn: ({ payload }) =>
+          source.learn(payload.network, payload.url).pipe(Effect.catchTag("ChannelStoreError", Effect.die)),
+        notCarried: ({ payload }) =>
+          source.markNotCarried(payload.network).pipe(Effect.catchTag("ChannelStoreError", Effect.die)),
+        forget: ({ payload }) =>
+          source.forget(payload.network).pipe(Effect.catchTag("ChannelStoreError", Effect.die))
+      })
+    })
+  )
+}
+
 /** GET /api/live — the current slate and stage, then every change, as server-sent events. */
 function liveRoute() {
   return HttpRouter.add(
```

- [ ] **Step 4: Refresh the Stage when the source changes**

Apply this change to `apps/hub/src/stage/StageSessions.ts`:

```diff
--- a/apps/hub/src/stage/StageSessions.ts
+++ b/apps/hub/src/stage/StageSessions.ts
@@ -1,7 +1,7 @@
 import type { GameId } from "@sportal/domain/Game"
 import { ChannelAvailability } from "@sportal/domain/Source"
 import { Stage, type StageCommand, type StageRejection } from "@sportal/domain/Stage"
-import { Context, Effect, Layer, Result, type Stream, SubscriptionRef } from "effect"
+import { Context, Effect, Layer, Result, Stream, SubscriptionRef } from "effect"
 import { Ingest } from "../ingest/Ingest.ts"
 import { Source } from "../source/Source.ts"
 
@@ -32,6 +32,15 @@ export class StageSessions extends Context.Service<
         })
       })
 
+      // When the source learns or forgets a channel, every tile it affects changes on every Display.
+      const refresh = Effect.gen(function* () {
+        const availabilityOf = yield* availabilityOnSlate(ingest, source)
+        yield* SubscriptionRef.update(current, (stage) => stage.refresh(availabilityOf))
+      })
+      yield* Effect.forkScoped(source.changes.pipe(Stream.runForEach(() => refresh)), {
+        startImmediately: true
+      })
+
       return StageSessions.of({
         stage: SubscriptionRef.get(current),
         changes: SubscriptionRef.changes(current),
```

`startImmediately` subscribes to `changes` before the layer finishes building, so no change can slip past.

- [ ] **Step 5: Run them to see them pass**

Run: `pnpm vitest run apps/hub`
Expected: every test passes. Run it a few times: it must be stable, since it waits on a live stream.

- [ ] **Step 6: Check**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and every test passes.

- [ ] **Step 7: Drive it against the live feed**

```bash
cd apps/hub
SPORTAL_PORT=4491 SPORTAL_DATA_DIR=/tmp/sportal-check timeout 40 node src/main.ts &
sleep 6
GAME=$(curl -s http://127.0.0.1:4491/api/slate | jq -r '[.[] | select(.broadcasts == ["ESPN"])][0].id')
curl -s -XPOST -H 'content-type: application/json' http://127.0.0.1:4491/api/stage/commands \
  -d "{\"command\":{\"_tag\":\"Assign\",\"tile\":0,\"game\":\"$GAME\"}}" | jq -c '.tiles[0]._tag'
curl -s -o /dev/null -w '%{http_code}\n' -XPOST -H 'content-type: application/json' \
  http://127.0.0.1:4491/api/channels/learn \
  -d '{"network":"ESPN","url":"https://tv.youtube.com/watch/_MpmFlh-Wzc?vpp=gAKAzYTWBg%3D%3D&vp=0gEKEgIwARiAzYTWBg%3D%3D"}'
curl -s http://127.0.0.1:4491/api/stage | jq -c '.tiles[0].channel.locator.url'
```

Expected: `"PickingChannel"`, then `204`, then `"https://tv.youtube.com/watch/_MpmFlh-Wzc?vp=0gEEEgIwAQ%3D%3D"`. Stop the Hub, start it again with the same `SPORTAL_DATA_DIR`, assign another ESPN game: it is a `"StreamTile"` at once.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/SportalApi.ts apps/hub/src
git commit -m "feat(hub): channels API, and the stage follows what the source learns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Shell bridge and guide reporting

**Files:**
- Modify: `packages/api/src/ShellBridge.ts` (`role`, `ChannelPick`, `onChannelPicked`)
- Modify: `apps/desktop/src/preload/ShellBridge.ts`
- Modify: `apps/desktop/src/main/TileViews.ts` (guide views report picks)
- Test: `apps/desktop/src/main/TileViews.test.ts`
- Modify: `apps/desktop/src/main/main.ts` (forwards picks to the window)
- Modify: `apps/web/src/stage/StageView.tsx` (placements carry a role)
- Modify: `CONTEXT.md`

**Interfaces:**
- Produces:
  - `TilePlacement` gains `role: "stream" | "guide"`.
  - `ChannelPick` — schema and type, `{ tile: number, url: string }`.
  - `ShellBridge.onChannelPicked(listener: (pick: ChannelPick) => void): () => void` — returns the unsubscribe function. The preload forwards the IPC message `sportal:channel-picked` and never hands the page the IPC event.
  - `TileViews.channelPicks: Stream<ChannelPick>` — each distinct `https://tv.youtube.com/watch/…` address a `guide` view's main frame lands on (`did-navigate` or `did-navigate-in-page`). A repeat of the address just reported is ignored; the record resets when the tile's placed address changes.

The spec said a guide view reports once and then stops. It reports each distinct channel address instead, so a pick the Hub refused can be picked again without clearing the tile.

- [ ] **Step 1: Change the contract**

Replace `packages/api/src/ShellBridge.ts`:

```ts
import { Schema } from "effect"

/**
 * Where one provider view sits in the Display's window, in CSS pixels, and what it loads. A `stream` view
 * plays a channel; a `guide` view shows the source's guide so the user can pick the channel for a network.
 */
export const TilePlacement = Schema.Struct({
  tile: Schema.Int,
  url: Schema.String,
  role: Schema.Literals(["stream", "guide"]),
  bounds: Schema.Struct({ x: Schema.Int, y: Schema.Int, width: Schema.Int, height: Schema.Int }),
  muted: Schema.Boolean
})
export type TilePlacement = typeof TilePlacement.Type

/** A guide view landed on a channel's address: the user picked that channel in the tile's guide. */
export const ChannelPick = Schema.Struct({ tile: Schema.Int, url: Schema.String })
export type ChannelPick = typeof ChannelPick.Type

/** What the desktop shell exposes to the web UI as `window.sportalShell`. Absent in a plain browser. */
export interface ShellBridge {
  /** Replaces the full set of provider views: views not listed are closed. */
  syncTiles(placements: ReadonlyArray<TilePlacement>): void
  /** Calls `listener` for every channel picked in a guide view. Returns a function that stops the calls. */
  onChannelPicked(listener: (pick: ChannelPick) => void): () => void
}

declare global {
  interface Window {
    sportalShell?: ShellBridge
  }
}
```
Replace `apps/desktop/src/preload/ShellBridge.ts`:

```ts
import type { ChannelPick, ShellBridge } from "@sportal/api/ShellBridge"
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"

const bridge: ShellBridge = {
  syncTiles: (placements) => ipcRenderer.send("sportal:sync-tiles", placements),
  onChannelPicked: (listener) => {
    // The page gets the pick alone, never the IPC event, which would expose the renderer's IPC handle.
    const forward = (_event: IpcRendererEvent, pick: ChannelPick) => listener(pick)
    ipcRenderer.on("sportal:channel-picked", forward)
    return () => {
      ipcRenderer.removeListener("sportal:channel-picked", forward)
    }
  }
}

contextBridge.exposeInMainWorld("sportalShell", bridge)
```

- [ ] **Step 2: Write the failing tests**

Apply this change to `apps/desktop/src/main/TileViews.test.ts`:

```diff
--- a/apps/desktop/src/main/TileViews.test.ts
+++ b/apps/desktop/src/main/TileViews.test.ts
@@ -1,5 +1,5 @@
 import { describe, expect, it } from "@effect/vitest"
-import { Context, Effect, Exit, Layer, Scope } from "effect"
+import { Context, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
 import { type Mock, vi } from "vitest"
 
 const created: Array<{ setBounds: Mock; webContents: ReturnType<typeof fakeContents> }> = []
@@ -21,6 +21,7 @@ const { TileViews } = await import("./TileViews.ts")
 const placement = {
   tile: 0,
   url: "https://tv.youtube.com/watch/one",
+  role: "stream" as const,
   bounds: { x: 10, y: 20, width: 640, height: 360 },
   muted: true
 }
@@ -106,6 +107,60 @@ describe("TileViews.sync", () => {
   )
 })
 
+describe("TileViews.channelPicks", () => {
+  const guide = { ...placement, url: "https://tv.youtube.com/live", role: "guide" as const }
+  const espn = "https://tv.youtube.com/watch/espn?vp=0gEEEgIwAQ%3D%3D"
+  const fox = "https://tv.youtube.com/watch/fox?vp=0gEEEgIwAQ%3D%3D"
+
+  it.effect("reports the channel a guide view lands on", () =>
+    Effect.gen(function* () {
+      const { tiles } = yield* attached()
+      yield* tiles.sync([guide])
+      const picks = yield* collect(tiles.channelPicks, 1)
+      created[0]?.webContents.emit("did-navigate-in-page", {}, espn, true)
+      expect(yield* Fiber.join(picks)).toEqual([{ tile: 0, url: espn }])
+    }).pipe(Effect.scoped)
+  )
+
+  it.effect("ignores the guide itself, subframes, and a repeat of the address just reported", () =>
+    Effect.gen(function* () {
+      const { tiles } = yield* attached()
+      yield* tiles.sync([guide])
+      const picks = yield* collect(tiles.channelPicks, 2)
+      const contents = created[0]?.webContents
+      contents?.emit("did-navigate", {}, "https://tv.youtube.com/live")
+      contents?.emit("did-navigate-in-page", {}, espn, false)
+      contents?.emit("did-navigate-in-page", {}, espn, true)
+      contents?.emit("did-navigate", {}, espn)
+      contents?.emit("did-navigate-in-page", {}, fox, true)
+      expect(yield* Fiber.join(picks)).toEqual([
+        { tile: 0, url: espn },
+        { tile: 0, url: fox }
+      ])
+    }).pipe(Effect.scoped)
+  )
+
+  it.effect("never reports for a stream view", () =>
+    Effect.gen(function* () {
+      const { tiles } = yield* attached()
+      yield* tiles.sync([placement, { ...guide, tile: 1 }])
+      const picks = yield* collect(tiles.channelPicks, 1)
+      created[0]?.webContents.emit("did-navigate-in-page", {}, espn, true)
+      created[1]?.webContents.emit("did-navigate-in-page", {}, fox, true)
+      expect(yield* Fiber.join(picks)).toEqual([{ tile: 1, url: fox }])
+    }).pipe(Effect.scoped)
+  )
+})
+
+/** Starts collecting the first `count` picks, subscribed before this returns. */
+function collect<A>(picks: Stream.Stream<A>, count: number) {
+  return Effect.gen(function* () {
+    const fiber = yield* picks.pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
+    yield* Effect.yieldNow
+    return fiber
+  })
+}
+
 /** Tile views over a fake window, on the real provider session with Electron mocked. */
 function attached() {
   created.length = 0
@@ -116,14 +171,21 @@ function attached() {
   )
 }
 
+/** A view's contents that records its event listeners, so a test can `emit` what Electron would. */
 function fakeContents() {
+  const listeners = new Map<string, Array<(...args: Array<unknown>) => void>>()
   return {
     loadURL: vi.fn(() => Promise.resolve()),
     setAudioMuted: vi.fn(),
     close: vi.fn(),
     isDestroyed: () => false,
-    on: vi.fn(),
-    setWindowOpenHandler: vi.fn()
+    on: vi.fn((event: string, listener: (...args: Array<unknown>) => void) => {
+      listeners.set(event, [...(listeners.get(event) ?? []), listener])
+    }),
+    setWindowOpenHandler: vi.fn(),
+    emit: (event: string, ...args: Array<unknown>) => {
+      for (const listener of listeners.get(event) ?? []) listener(...args)
+    }
   }
 }
 
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run apps/desktop/src/main/TileViews.test.ts`
Expected: FAIL — `Tests  3 failed | 7 passed (10)`.


- [ ] **Step 4: Report picks from guide views**

Replace `apps/desktop/src/main/TileViews.ts`:

```ts
import type { ChannelPick, TilePlacement } from "@sportal/api/ShellBridge"
import { Context, Effect, Layer, PubSub, Stream } from "effect"
import type { View, WebContentsView } from "electron"
import { allows, hostOf, load, ProviderSession } from "./ProviderSession.ts"

/**
 * Keeps one provider web view per stream or guide tile, laid over the web UI at the rectangle the UI reports.
 * The shell only ever sets a view's address, bounds, and mute flag, and reads the address a guide view
 * lands on; the provider's page is never modified.
 */
export class TileViews extends Context.Service<
  TileViews,
  {
    /** Makes the views match the placements: views for tiles not listed are closed. */
    sync(placements: ReadonlyArray<TilePlacement>): Effect.Effect<void>
    /** Each channel a guide view lands on, as the user picks it. */
    readonly channelPicks: Stream.Stream<ChannelPick>
  }
>()("sportal/desktop/TileViews") {
  // Only the window's own view tree is touched, so that is all the layer asks for.
  static readonly layer = (window: {
    readonly contentView: Pick<View, "addChildView" | "removeChildView">
    isDestroyed(): boolean
  }) =>
    Layer.effect(
      TileViews,
      Effect.gen(function* () {
        const providers = yield* ProviderSession
        const scope = yield* Effect.scope
        const picks = yield* PubSub.unbounded<ChannelPick>()
        const views = new Map<number, Entry>()

        const remove = (view: WebContentsView) => {
          if (!window.isDestroyed()) window.contentView.removeChildView(view)
          if (!view.webContents.isDestroyed()) view.webContents.close()
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const { view } of views.values()) remove(view)
            views.clear()
          })
        )

        const create = Effect.fn("TileViews.create")(function* (tile: number) {
          const entry: Entry = { view: yield* providers.createView, url: "", role: "stream", reported: "" }
          // YouTube TV moves between pages with pushState, which fires did-navigate-in-page, not will-navigate.
          const landed = (url: string) => {
            if (entry.role !== "guide" || url === entry.reported || !isChannelAddress(url)) return
            entry.reported = url
            PubSub.publishUnsafe(picks, { tile, url })
          }
          entry.view.webContents.on("did-navigate", (_event, url) => landed(url))
          entry.view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
            if (isMainFrame) landed(url)
          })
          window.contentView.addChildView(entry.view)
          return entry
        })

        const sync = Effect.fn("TileViews.sync")(function* (placements: ReadonlyArray<TilePlacement>) {
          const permitted: Array<TilePlacement> = []
          for (const placement of placements) {
            if (allows(placement.url)) permitted.push(placement)
            else
              yield* Effect.logWarning(
                `TileViews: refused tile ${placement.tile} address on ${hostOf(placement.url)}`
              )
          }

          for (const [tile, entry] of views) {
            if (permitted.some((placement) => placement.tile === tile)) continue
            remove(entry.view)
            views.delete(tile)
          }

          for (const placement of permitted) {
            let entry = views.get(placement.tile)
            if (entry === undefined) {
              entry = yield* create(placement.tile)
              views.set(placement.tile, entry)
            }
            if (entry.url !== placement.url) {
              entry.url = placement.url
              entry.reported = ""
              // The load starts now, as Electron issues it; only its outcome is awaited in the background.
              yield* Effect.forkIn(loadTile(entry.view, placement.url), scope, { startImmediately: true })
            }
            entry.role = placement.role
            entry.view.setBounds(placement.bounds)
            entry.view.webContents.setAudioMuted(placement.muted)
          }
        })

        return TileViews.of({ sync, channelPicks: Stream.fromPubSub(picks) })
      })
    )
}

/** One tile's view, the address last placed in it, its role, and the last channel address it reported. */
type Entry = { view: WebContentsView; url: string; role: TilePlacement["role"]; reported: string }

function isChannelAddress(url: string) {
  if (!URL.canParse(url)) return false
  const { protocol, hostname, pathname } = new URL(url)
  return protocol === "https:" && hostname === "tv.youtube.com" && pathname.startsWith("/watch/")
}

function loadTile(view: WebContentsView, url: string) {
  return load(view.webContents, url).pipe(
    Effect.catchTag("LoadFailed", (failure) =>
      // A newer placement superseding this load aborts it; that is routine.
      failure.code === "ERR_ABORTED"
        ? Effect.void
        : Effect.logError(`TileViews: could not load a tile from ${hostOf(url)}: ${failure.code}`)
    )
  )
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `pnpm vitest run apps/desktop/src/main/TileViews.test.ts`
Expected: `Tests  10 passed (10)`.


- [ ] **Step 6: Forward picks to the web UI, and mark placements**

Apply this change to `apps/desktop/src/main/main.ts`:

```diff
--- a/apps/desktop/src/main/main.ts
+++ b/apps/desktop/src/main/main.ts
@@ -1,6 +1,6 @@
 import { join } from "node:path"
 import { TilePlacement } from "@sportal/api/ShellBridge"
-import { Config, Effect, FiberSet, Layer, Option, Schema } from "effect"
+import { Config, Effect, FiberSet, Layer, Option, Schema, Stream } from "effect"
 import { app, BrowserWindow, components, type IpcMainEvent, ipcMain } from "electron"
 import { hostOf, load, ProviderSession } from "./ProviderSession.ts"
 import { TileViews } from "./TileViews.ts"
@@ -82,6 +82,16 @@ function serveHub(window: BrowserWindow, hubUrl: string) {
       Effect.sync(() => ipcMain.on("sportal:sync-tiles", syncTiles)),
       () => Effect.sync(() => ipcMain.removeListener("sportal:sync-tiles", syncTiles))
     )
+    yield* Effect.forkScoped(
+      tiles.channelPicks.pipe(
+        Stream.runForEach((pick) =>
+          Effect.sync(() => {
+            if (!window.isDestroyed()) window.webContents.send("sportal:channel-picked", pick)
+          })
+        )
+      ),
+      { startImmediately: true }
+    )
 
     yield* load(window.webContents, hubUrl).pipe(
       Effect.catchTag("LoadFailed", (failure) =>
```
Apply this change to `apps/web/src/stage/StageView.tsx`:

```diff
--- a/apps/web/src/stage/StageView.tsx
+++ b/apps/web/src/stage/StageView.tsx
@@ -96,6 +96,7 @@ function placements(stage: Stage, videoAreas: ReadonlyArray<HTMLDivElement | nul
       {
         tile: index,
         url: tile.channel.locator.url,
+        role: "stream",
         bounds: {
           x: Math.round(rect.x),
           y: Math.round(rect.y),
```
Apply this change to `CONTEXT.md`:

```diff
--- a/CONTEXT.md
+++ b/CONTEXT.md
@@ -64,7 +64,8 @@ Provider and Source are the two words most likely to be swapped. Provider is alw
 | **Desk mode** / **Couch mode** | The two presentation densities. | desktop/TV layout |
 | **Shell bridge** | The small interface the desktop shell exposes to the web UI. | IPC, native API |
 | **Provider session** | The shell's single persistent browser session shared by every provider view, with its navigation allowlist and permissions. | partition, profile |
-| **Tile views** | The shell component that keeps one provider web view per stream tile, placed where the web UI says. | view manager |
+| **Tile views** | The shell component that keeps one provider web view per stream or picking tile, placed where the web UI says. | view manager |
+| **Channel pick** | The shell's report that a picking tile's guide view landed on a channel's address. | selection |
 
 ### Viewing
 
```
Apply this change to `CONTEXT.md`:

```diff
--- a/CONTEXT.md
+++ b/CONTEXT.md
@@ -83,7 +83,7 @@ Provider and Source are the two words most likely to be swapped. Provider is alw
 | **Audio focus** | The single tile whose sound is on. | active, unmuted |
 | **Promote** | Move a game into the main tile. | feature |
 | **Preset** | A saved layout with tile assignments. | |
-| **Tile placement** | Where a stream tile sits in a Display's window and what it plays, as told to the shell. | bounds, rect |
+| **Tile placement** | Where a stream or picking tile sits in a Display's window, what it loads, and whether it is a stream or a guide, as told to the shell. | bounds, rect |
 | **Tile delay** | Seconds that data is held back for a tile to match its video. | offset, latency |
 | **Spoiler shield** | Hiding or delaying scores for chosen games. | |
 
```

- [ ] **Step 7: Check and build**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and every test passes.

Run: `pnpm --filter @sportal/desktop exec electron-vite build`
Expected: both builds end `✓ built`.


- [ ] **Step 8: Commit**

```bash
git add CONTEXT.md packages/api/src/ShellBridge.ts apps/desktop/src apps/web/src/stage/StageView.tsx
git commit -m "feat(desktop): guide views report the channel the user picks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Desktop findings from the restructure review

**Files:**
- Modify: `apps/desktop/src/main/ProviderSession.ts` (one navigation guard, `confine`)
- Test: `apps/desktop/src/main/ProviderSession.test.ts`
- Modify: `apps/desktop/src/main/TileViews.ts` (a removed view's failed load is routine)
- Modify: `apps/desktop/src/main/main.ts`

**Interfaces:**
- Produces: `confine(contents, permits: (url) => boolean, warn: (message) => void, options: { subframes: boolean })` in `ProviderSession.ts`. It refuses `will-navigate` and `will-redirect` off the permitted addresses, warns with the hostname only, denies every new window, and with `subframes` also refuses `will-frame-navigate` in subframes. Its `contents` parameter is a structural type that a real `WebContents` satisfies, so tests pass a fake without a cast.

Each finding, and what this task does:

| Finding | Change |
| --- | --- |
| The launch runs at module top level above a class and a const it uses | The launch moves to the end of `main.ts` |
| Each sync message forks its own fiber over a shared map | Messages go into a sliding queue of one; a single fiber applies them in order, and only the newest waiting set is kept |
| A window closed while the Hub page loads is logged as "the Hub could not be reached"; a removed view may log a load error | Both are ignored when the window or view is already destroyed |
| `WidevineUnavailable` drops the underlying error | It carries the error as `cause` (a `Schema.Defect`), which keeps more than a code |
| The two navigation guards share a shape | Both use `confine` |
| Guard subframe navigations (`will-frame-navigate`) | Done for the shell window, which holds the privileged preload. Not done for provider views: their pages embed frames from hosts the four-host allowlist does not name, and refusing them could break sign-in or playback in a way only a game day would show. Recorded in ADR 0002 (Task 10) |

- [ ] **Step 1: Write the failing tests**

Apply this change to `apps/desktop/src/main/ProviderSession.test.ts`:

```diff
--- a/apps/desktop/src/main/ProviderSession.test.ts
+++ b/apps/desktop/src/main/ProviderSession.test.ts
@@ -6,7 +6,7 @@ vi.mock("electron", () => ({
   WebContentsView: vi.fn()
 }))
 
-const { allows, grantsPermission, hostOf, loadErrorCode } = await import("./ProviderSession.ts")
+const { allows, confine, grantsPermission, hostOf, loadErrorCode } = await import("./ProviderSession.ts")
 
 describe("allows", () => {
   it.each([
@@ -67,3 +67,72 @@ describe("loadErrorCode", () => {
     expect(loadErrorCode(error)).toBe("unknown")
   })
 })
+
+describe("confine", () => {
+  const onHub = (url: string) => url.startsWith("http://hub/")
+
+  it.each(["will-navigate", "will-redirect"])(
+    "refuses a %s off the permitted addresses, saying where",
+    (event) => {
+      const { contents, warn } = confined({ subframes: false })
+      const refused = navigation("https://evil.example/path?token=secret", true)
+      contents.emit(event, refused)
+      expect(refused.preventDefault).toHaveBeenCalled()
+      expect(warn).toHaveBeenCalledWith("refused navigation to evil.example")
+    }
+  )
+
+  it("lets a permitted navigation through", () => {
+    const { contents, warn } = confined({ subframes: false })
+    const allowed = navigation("http://hub/stage", true)
+    contents.emit("will-navigate", allowed)
+    expect(allowed.preventDefault).not.toHaveBeenCalled()
+    expect(warn).not.toHaveBeenCalled()
+  })
+
+  it("never opens a new window", () => {
+    const { contents } = confined({ subframes: false })
+    expect(contents.openWindow()).toEqual({ action: "deny" })
+  })
+
+  it("refuses a subframe navigation off the permitted addresses only when asked to", () => {
+    const guarded = confined({ subframes: true })
+    const inFrame = navigation("https://evil.example/", false)
+    guarded.contents.emit("will-frame-navigate", inFrame)
+    expect(inFrame.preventDefault).toHaveBeenCalled()
+
+    const unguarded = confined({ subframes: false })
+    const elsewhere = navigation("https://evil.example/", false)
+    unguarded.contents.emit("will-frame-navigate", elsewhere)
+    expect(elsewhere.preventDefault).not.toHaveBeenCalled()
+  })
+
+  function confined(options: { subframes: boolean }) {
+    const contents = fakeContents()
+    const warn = vi.fn()
+    confine(contents, onHub, warn, options)
+    return { contents, warn }
+  }
+})
+
+function navigation(url: string, isMainFrame: boolean) {
+  return { url, isMainFrame, preventDefault: vi.fn() }
+}
+
+/** A page's contents that records its listeners, so a test can `emit` what Electron would. */
+function fakeContents() {
+  const listeners = new Map<string, Array<(details: ReturnType<typeof navigation>) => void>>()
+  let openHandler: () => unknown = () => undefined
+  return {
+    on: (event: string, listener: (details: ReturnType<typeof navigation>) => void) => {
+      listeners.set(event, [...(listeners.get(event) ?? []), listener])
+    },
+    setWindowOpenHandler: (handler: () => unknown) => {
+      openHandler = handler
+    },
+    emit: (event: string, details: ReturnType<typeof navigation>) => {
+      for (const listener of listeners.get(event) ?? []) listener(details)
+    },
+    openWindow: () => openHandler()
+  }
+}
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/desktop/src/main/ProviderSession.test.ts`
Expected: FAIL — `confine` is not exported.


- [ ] **Step 3: Write the guard and use it for provider views**

Replace `apps/desktop/src/main/ProviderSession.ts`:

```ts
import { Context, Effect, FiberSet, Layer, Schema } from "effect"
import { session, type WebContents, WebContentsView } from "electron"

/**
 * The one persistent session every provider view shares, so one sign-in covers every tile and survives
 * restarts. It grants playback only what playback needs, and keeps its views on the provider's pages.
 */
export class ProviderSession extends Context.Service<
  ProviderSession,
  {
    /** A new view on the provider session, guarded so it can only visit addresses `allows` permits. */
    readonly createView: Effect.Effect<WebContentsView>
  }
>()("sportal/desktop/ProviderSession") {
  static readonly layer = Layer.effect(
    ProviderSession,
    Effect.gen(function* () {
      // Electron's callbacks decide synchronously; only their logging runs as an Effect.
      const log = yield* FiberSet.makeRuntime()
      const providers = session.fromPartition("persist:providers")
      providers.setPermissionRequestHandler((_webContents, permission, callback, details) => {
        const granted = grantsPermission(permission)
        if (!granted)
          log(Effect.logWarning(`ProviderSession: denied ${permission} for ${hostOf(details.requestingUrl)}`))
        callback(granted)
      })

      const warn = (message: string) => log(Effect.logWarning(`ProviderSession: ${message}`))

      return ProviderSession.of({
        createView: Effect.sync(() => {
          const view = new WebContentsView({
            webPreferences: {
              session: providers,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
            }
          })
          // Subframes are left alone: provider pages embed frames from hosts the allowlist does not name.
          confine(view.webContents, allows, warn, { subframes: false })
          return view
        })
      })
    })
  )
}

/** Provider views may only visit the provider and its sign-in pages. */
export function allows(url: string): boolean {
  if (!URL.canParse(url)) return false
  const { protocol, hostname } = new URL(url)
  return protocol === "https:" && allowedHosts.includes(hostname)
}

const allowedHosts = ["tv.youtube.com", "www.youtube.com", "accounts.youtube.com", "accounts.google.com"]

/**
 * Keeps a page on the addresses `permits` allows: a navigation or server redirect elsewhere is refused and
 * reported to `warn` by hostname only, and the page never opens a window. With `subframes`, navigations
 * inside the page's frames are held to the same addresses.
 */
export function confine(
  contents: {
    on(
      event: "will-navigate" | "will-redirect" | "will-frame-navigate",
      listener: (details: { url: string; isMainFrame: boolean; preventDefault(): void }) => void
    ): unknown
    setWindowOpenHandler(handler: () => { action: "deny" }): void
  },
  permits: (url: string) => boolean,
  warn: (message: string) => void,
  options: { subframes: boolean }
) {
  const refuseUnlessPermitted = (details: { url: string; preventDefault(): void }) => {
    if (permits(details.url)) return
    details.preventDefault()
    warn(`refused navigation to ${hostOf(details.url)}`)
  }
  // will-navigate does not fire for server redirects, so both are guarded.
  contents.on("will-navigate", refuseUnlessPermitted)
  contents.on("will-redirect", refuseUnlessPermitted)
  if (options.subframes)
    contents.on("will-frame-navigate", (details) => {
      if (!details.isMainFrame) refuseUnlessPermitted(details)
    })
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
}

/** Playback needs DRM key systems, fullscreen, and a screen that stays awake; nothing else is granted. */
export function grantsPermission(permission: string): boolean {
  return ["mediaKeySystem", "fullscreen", "screen-wake-lock"].includes(permission)
}

/** The hostname alone, for logging: a full URL can carry tokens. */
export function hostOf(url: string) {
  return URL.canParse(url) ? new URL(url).hostname : "(unparseable address)"
}

/** Loads an address into a page; a failed load fails with Electron's error code, never its message. */
export function load(contents: WebContents, url: string) {
  return Effect.tryPromise({
    try: () => contents.loadURL(url),
    catch: (error) => new LoadFailed({ code: loadErrorCode(error) })
  })
}

/** The code Electron attaches to a failed load (such as `ERR_ABORTED`); the message would carry the full URL. */
export function loadErrorCode(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown"
}

class LoadFailed extends Schema.TaggedError<LoadFailed>()("LoadFailed", { code: Schema.String }) {}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run apps/desktop`
Expected: `Tests  41 passed (41)`.


- [ ] **Step 5: Restructure the shell's main process**

Replace `apps/desktop/src/main/main.ts`:

```ts
import { join } from "node:path"
import { TilePlacement } from "@sportal/api/ShellBridge"
import { Config, Effect, FiberSet, Layer, Option, Queue, Schema, Stream } from "effect"
import { app, BrowserWindow, components, type IpcMainEvent, ipcMain } from "electron"
import { confine, hostOf, load, ProviderSession } from "./ProviderSession.ts"
import { TileViews } from "./TileViews.ts"

const Shell = Layer.unwrap(
  Effect.gen(function* () {
    const hubUrl = yield* Config.String("SPORTAL_HUB_URL").pipe(Config.withDefault("http://127.0.0.1:4400"))
    yield* Effect.promise(() => app.whenReady())
    // Widevine is delivered as a component of the castlabs Electron build; wait for it before any playback.
    yield* Effect.tryPromise({
      try: () => components.whenReady(),
      catch: (cause) => new WidevineUnavailable({ cause })
    })
    const window = yield* openWindow(hubUrl)

    return Layer.effectDiscard(serveHub(window, hubUrl)).pipe(
      Layer.provide(TileViews.layer(window)),
      Layer.provide(ProviderSession.layer)
    )
  })
)

class WidevineUnavailable extends Schema.TaggedError<WidevineUnavailable>()("WidevineUnavailable", {
  cause: Schema.Defect()
}) {}

function openWindow(hubUrl: string) {
  return Effect.gen(function* () {
    const log = yield* FiberSet.makeRuntime()
    const window = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new BrowserWindow({
            width: 1920,
            height: 1080,
            backgroundColor: "#0a0a0a",
            webPreferences: {
              preload: join(import.meta.dirname, "../preload/ShellBridge.cjs"),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
            }
          })
      ),
      (window) =>
        Effect.sync(() => {
          if (!window.isDestroyed()) window.destroy()
        })
    )

    // The shell window holds the privileged preload, so neither it nor any frame in it leaves the Hub.
    const hubOrigin = new URL(hubUrl).origin
    confine(
      window.webContents,
      (url) => URL.canParse(url) && new URL(url).origin === hubOrigin,
      (message) => log(Effect.logWarning(`Sportal: ${message}`)),
      { subframes: true }
    )
    return window
  })
}

function serveHub(window: BrowserWindow, hubUrl: string) {
  return Effect.gen(function* () {
    const tiles = yield* TileViews

    // Placements are applied one at a time, and only the newest waiting set matters: each replaces all before it.
    const pending = yield* Queue.sliding<ReadonlyArray<TilePlacement>>(1)
    yield* Effect.forkScoped(Effect.forever(Queue.take(pending).pipe(Effect.flatMap(tiles.sync))))
    const syncTiles = (event: IpcMainEvent, placements: unknown) => {
      if (event.sender !== window.webContents) return
      const decoded = decodePlacements(placements)
      if (Option.isSome(decoded)) Queue.offerUnsafe(pending, decoded.value)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => ipcMain.on("sportal:sync-tiles", syncTiles)),
      () => Effect.sync(() => ipcMain.removeListener("sportal:sync-tiles", syncTiles))
    )

    yield* Effect.forkScoped(
      tiles.channelPicks.pipe(
        Stream.runForEach((pick) =>
          Effect.sync(() => {
            if (!window.isDestroyed()) window.webContents.send("sportal:channel-picked", pick)
          })
        )
      ),
      { startImmediately: true }
    )

    yield* load(window.webContents, hubUrl).pipe(
      Effect.catchTag("LoadFailed", (failure) =>
        // Closing the window while the Hub page loads fails the load; that is the user leaving, not an outage.
        window.isDestroyed()
          ? Effect.void
          : Effect.logError(`Sportal: the Hub could not be reached at ${hostOf(hubUrl)}: ${failure.code}`)
      )
    )
  })
}

const decodePlacements = Schema.decodeUnknownOption(Schema.Array(TilePlacement))

function allWindowsClosed() {
  return Effect.callback<void>((resume) => {
    const closed = () => resume(Effect.void)
    app.once("window-all-closed", closed)
    return Effect.sync(() => app.removeListener("window-all-closed", closed))
  })
}

// Launched last, once everything above is defined. Electron owns the process, so the shell is not run with
// NodeRuntime.runMain: it runs until its last window closes, releases what it holds, and then asks Electron
// to quit.
Layer.launch(Shell).pipe(
  Effect.raceFirst(allWindowsClosed()),
  Effect.tapCause((cause) => Effect.logError("Sportal: the shell stopped", cause)),
  Effect.ensuring(Effect.sync(() => app.quit())),
  Effect.runFork
)
```
Apply this change to `apps/desktop/src/main/TileViews.ts`:

```diff
--- a/apps/desktop/src/main/TileViews.ts
+++ b/apps/desktop/src/main/TileViews.ts
@@ -108,8 +108,8 @@ function isChannelAddress(url: string) {
 function loadTile(view: WebContentsView, url: string) {
   return load(view.webContents, url).pipe(
     Effect.catchTag("LoadFailed", (failure) =>
-      // A newer placement superseding this load aborts it; that is routine.
-      failure.code === "ERR_ABORTED"
+      // A newer placement superseding this load aborts it, and a removed view's load fails; both are routine.
+      failure.code === "ERR_ABORTED" || view.webContents.isDestroyed()
         ? Effect.void
         : Effect.logError(`TileViews: could not load a tile from ${hostOf(url)}: ${failure.code}`)
     )
```

- [ ] **Step 6: Check and build**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and every test passes.

Run: `pnpm --filter @sportal/desktop exec electron-vite build`
Expected: both builds end `✓ built`.


- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src
git commit -m "fix(desktop): one navigation guard, serial tile syncs, quieter shutdown, and the launch moved last

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Web UI — picking tiles, picks, not carried, and wrong channel

**Files:**
- Modify: `apps/web/src/hub/HubClient.ts`
- Modify: `apps/web/src/stage/StageView.tsx`

**Interfaces:**
- Consumes: the `channels` API group (Task 6), `ShellBridge.onChannelPicked` (Task 7), the tile shapes (Task 4).
- Produces, from `HubClient.ts`: `learnChannel(network, url)`, `markNotCarried(network)`, `forgetChannel(network)`, each `Promise<Option<string>>` — the message to show if the Hub did not take the command, or none. The Stage change itself arrives on the live stream; there is no optimistic state.

The tile's behaviour:

| Tile | In the shell | In a plain browser | Footer |
| --- | --- | --- | --- |
| Picking | The guide fills the video area, muted | "Open the guide" link and "Picking a channel works in the desktop app" | "Pick the <network> channel" and **Not on <source>** |
| Stream | The channel plays | "Open in <source>" link | Score, **wrong channel**, audio, clear |

A failed command shows a one-line notice on its tile until the Stage next changes.

- [ ] **Step 1: Add the channel commands to the client**

Replace `apps/web/src/hub/HubClient.ts`:

```ts
import { SportalApi } from "@sportal/api/SportalApi"
import type { Network } from "@sportal/domain/Game"
import type { StageCommand } from "@sportal/domain/Stage"
import { Context, Effect, Layer, ManagedRuntime, Option, Predicate } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"

class HubClient extends Context.Service<HubClient, HttpApiClient.ForApi<typeof SportalApi>>()(
  "sportal/web/HubClient"
) {
  static readonly layer = Layer.effect(HubClient, HttpApiClient.make(SportalApi)).pipe(
    Layer.provide(FetchHttpClient.layer)
  )
}

const runtime = ManagedRuntime.make(HubClient.layer)

/** Sends a stage command. The resulting stage arrives on the live stream, not from this call. */
export function dispatch(command: StageCommand): void {
  runtime.runFork(HubClient.use((hub) => hub.stage.dispatch({ payload: { command } })))
}

/**
 * Tells the Hub the channel the user picked for `network`. Like the other channel commands, it resolves to
 * the message to show the user if the Hub did not take it; the Stage change arrives on the live stream.
 */
export function learnChannel(network: Network, url: string): Promise<Option.Option<string>> {
  return outcome(HubClient.use((hub) => hub.channels.learn({ payload: { network, url } })))
}

export function markNotCarried(network: Network): Promise<Option.Option<string>> {
  return outcome(HubClient.use((hub) => hub.channels.notCarried({ payload: { network } })))
}

export function forgetChannel(network: Network): Promise<Option.Option<string>> {
  return outcome(HubClient.use((hub) => hub.channels.forget({ payload: { network } })))
}

function outcome(command: Effect.Effect<void, unknown, HubClient>) {
  return runtime.runPromise(
    command.pipe(
      Effect.match({
        onSuccess: () => Option.none(),
        onFailure: (error) =>
          Option.some(
            Predicate.isTagged(error, "ChannelUrlRefused")
              ? "That is not a live channel. Pick one from the live guide."
              : "The Hub did not take that. Try again."
          )
      })
    )
  )
}
```

- [ ] **Step 2: Rebuild the Stage view**

Replace `apps/web/src/stage/StageView.tsx`:

```tsx
import type { TilePlacement } from "@sportal/api/ShellBridge"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { Stage, Tile } from "@sportal/domain/Stage"
import { Option } from "effect"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { dispatch, forgetChannel, learnChannel, markNotCarried } from "../hub/HubClient.ts"

export function StageView(props: {
  stage: Stage
  slate: ReadonlyArray<GameSnapshot>
  selected: number
  onSelect: (tile: number) => void
}) {
  // One element per tile marking where its video goes; the shell lays a provider view over each.
  const videoAreas = useRef<Array<HTMLDivElement | null>>([])
  // What went wrong with the last channel command on a tile, until the Stage next changes.
  const [notices, setNotices] = useState<ReadonlyMap<number, string>>(new Map())

  useLayoutEffect(() => {
    const sync = () => window.sportalShell?.syncTiles(placements(props.stage, videoAreas.current))
    sync()
    window.addEventListener("resize", sync)
    return () => window.removeEventListener("resize", sync)
  }, [props.stage])

  useEffect(() => {
    setNotices(new Map())
    // A channel picked in a picking tile's guide teaches the Hub that network's channel.
    return window.sportalShell?.onChannelPicked((pick) => {
      const tile = props.stage.tiles[pick.tile]
      if (tile?._tag === "PickingChannel")
        void learnChannel(tile.network, pick.url).then((failure) => setNotices(noticed(pick.tile, failure)))
    })
  }, [props.stage])

  return (
    <main className="grid min-h-0 grid-cols-2 grid-rows-2 gap-1 p-1">
      {props.stage.tiles.map((tile, index) => {
        const game = tile._tag === "Empty" ? undefined : props.slate.find((g) => g.id === tile.game)
        const hasAudio = props.stage.audioFocus === index
        const notice = notices.get(index)
        return (
          <section
            // biome-ignore lint/suspicious/noArrayIndexKey: a tile is identified by its slot.
            key={index}
            className={`flex min-h-0 flex-col rounded border ${
              props.selected === index ? "border-sky-500" : "border-neutral-800"
            }`}
          >
            <div
              ref={(element) => {
                videoAreas.current[index] = element
              }}
              className="flex min-h-0 flex-1 items-center justify-center bg-black text-neutral-500"
            >
              <TileBody tile={tile} />
            </div>
            {notice === undefined ? null : <p className="px-2 pt-1 text-sm text-amber-400">{notice}</p>}
            <footer className="flex items-center gap-2 px-2 py-1 text-sm tabular-nums">
              <button type="button" className="flex-1 text-left" onClick={() => props.onSelect(index)}>
                {tile._tag === "PickingChannel"
                  ? `Pick the ${tile.network} channel`
                  : game === undefined
                    ? `Tile ${index + 1}`
                    : `${game.away.team.abbreviation} ${game.away.score} – ${game.home.score} ${game.home.team.abbreviation}`}
              </button>
              {tile._tag === "PickingChannel" ? (
                <button
                  type="button"
                  className="text-neutral-500"
                  onClick={() =>
                    void markNotCarried(tile.network).then((failure) => setNotices(noticed(index, failure)))
                  }
                >
                  Not on {tile.source}
                </button>
              ) : null}
              {tile._tag === "StreamTile" ? (
                <button
                  type="button"
                  className="text-neutral-500"
                  onClick={() =>
                    void forgetChannel(tile.channel.network).then((failure) =>
                      setNotices(noticed(index, failure))
                    )
                  }
                >
                  wrong channel
                </button>
              ) : null}
              <button
                type="button"
                className={hasAudio ? "text-emerald-400" : "text-neutral-500"}
                onClick={() => dispatch({ _tag: "FocusAudio", tile: index })}
              >
                {hasAudio ? "audio on" : "audio"}
              </button>
              <button
                type="button"
                className="text-neutral-500"
                onClick={() => dispatch({ _tag: "Clear", tile: index })}
              >
                clear
              </button>
            </footer>
          </section>
        )
      })}
    </main>
  )
}

function TileBody(props: { tile: Tile }) {
  switch (props.tile._tag) {
    case "Empty":
      return <span>Pick a game from the slate</span>
    case "DataTile":
      return <span>No stream for this game on your sources</span>
    case "PickingChannel":
      // Inside the shell the guide covers this. In a plain browser there is no view to watch for the pick.
      return (
        <span className="flex flex-col items-center gap-1">
          <a className="underline" href={props.tile.guide.url} target="_blank" rel="noreferrer">
            Open the guide
          </a>
          <span>Picking a channel works in the desktop app</span>
        </span>
      )
    case "StreamTile":
      // Inside the shell this is covered by the provider view. In a plain browser it is the way to watch.
      return (
        <a className="underline" href={props.tile.channel.locator.url} target="_blank" rel="noreferrer">
          Open in {props.tile.channel.source}
        </a>
      )
  }
}

function placements(stage: Stage, videoAreas: ReadonlyArray<HTMLDivElement | null>): Array<TilePlacement> {
  return stage.tiles.flatMap((tile, index) => {
    const area = videoAreas[index]
    if (area === null || area === undefined) return []
    const view =
      tile._tag === "StreamTile"
        ? { url: tile.channel.locator.url, role: "stream" as const, muted: stage.audioFocus !== index }
        : tile._tag === "PickingChannel"
          ? // A guide can preview what is on; it never takes the sound.
            { url: tile.guide.url, role: "guide" as const, muted: true }
          : undefined
    if (view === undefined) return []
    const rect = area.getBoundingClientRect()
    return [
      {
        tile: index,
        ...view,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      }
    ]
  })
}

/** The notices with `failure`, if there was one, shown on `tile`. */
function noticed(tile: number, failure: Option.Option<string>) {
  return (notices: ReadonlyMap<number, string>) =>
    Option.isSome(failure) ? new Map(notices).set(tile, failure.value) : notices
}
```

`noticed` is a pure updater rather than a closure over `setNotices`, so the pick subscription depends only on the Stage (Biome's `useExhaustiveDependencies` rejects the closure).

- [ ] **Step 3: Check and build**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and every test passes.

Run: `pnpm --filter @sportal/web build`
Expected: `✓ built`.


- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): picking tiles, channel picks, not carried, and wrong channel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Docs — game-day rows, ADR follow-up, deferred findings

**Files:**
- Modify: `docs/game-day-checklist.md`, `docs/adr/0002-desktop-shell-playback.md`, `docs/plans/2026-10-03-thin-vertical-slice.md`, `AGENTS.md`

- [ ] **Step 1: Replace the game-day rows**

Apply this change to `docs/game-day-checklist.md`:

```diff
--- a/docs/game-day-checklist.md
+++ b/docs/game-day-checklist.md
@@ -9,15 +9,20 @@ Setup: Hub serving the built web UI, desktop shell running, signed in to YouTube
 | --- | --- | --- |
 | 1 | Open the shell | Slate lists today's NFL and FBS games, live first; header reads `live` |
 | 2 | Watch a live game's row for a minute | Score and clock update without a reload |
-| 3 | Click a live game on a mapped network | It plays in the selected tile within a few seconds, inside the tile |
-| 4 | Fill all four tiles with mapped games | Tiles up to the stream limit play; note what the provider does past it |
-| 5 | Press `audio` on each tile in turn | Exactly one tile is audible each time |
-| 6 | Pick a game that is already on the Stage | It moves to the selected tile; it is never shown twice |
-| 7 | Click a game on an unmapped network | Data-tile message, no video, nothing else disturbed |
-| 8 | Press `clear` on a playing tile | Video and sound stop for that tile only |
-| 9 | Resize and maximize the window | Every video stays inside its tile; score strips stay visible |
-| 10 | Open the web UI in a normal browser on the same machine | Same slate and Stage; a stream tile shows an "Open in YouTube TV" link instead of video; a change there changes the shell |
-| 11 | Stop the Hub, wait, start it | Header shows `reconnecting…` then `live`; video keeps playing while the Hub is down; when the Hub returns the Stage is empty again, because nothing is saved yet |
-| 12 | Quit and reopen the shell | Still signed in to the provider |
+| 3 | Click a live game on a network never seen before | The tile shows YouTube TV's live guide, muted; its footer reads "Pick the <network> channel" |
+| 4 | In that tile's guide, pick the channel airing the game | The tile plays it live within a few seconds, inside the tile |
+| 5 | Click another game on the same network | It plays at once, with no guide |
+| 6 | Fill all four tiles with games on learned networks | Tiles up to the stream limit play; note what the provider does past it |
+| 7 | Press `audio` on each tile in turn | Exactly one tile is audible each time |
+| 8 | Pick a game that is already on the Stage | It moves to the selected tile; it is never shown twice |
+| 9 | Click an ESPN+ game, press **Not on YouTube TV** | Data-tile message, no video; the next ESPN+ game is a data tile at once |
+| 10 | On a playing tile, press **wrong channel** | The tile returns to the guide for that network |
+| 11 | Press `clear` on a playing tile | Video and sound stop for that tile only |
+| 12 | Resize and maximize the window | Every video and guide stays inside its tile; score strips stay visible |
+| 13 | Open the web UI in a normal browser on the same machine | Same slate and Stage; a stream tile shows an "Open in YouTube TV" link and a picking tile an "Open the guide" link instead of video; a change there changes the shell |
+| 14 | Stop the Hub, wait, start it | Header shows `reconnecting…` then `live`; video keeps playing while the Hub is down; when the Hub returns the Stage is empty again, because the Stage is not saved yet |
+| 15 | After the Hub restart, click a game on a network learned earlier | It plays at once, with no guide: learned channels are saved |
+| 16 | Quit and reopen the shell | Still signed in to the provider |
+| 17 | Once, after a channel's programme changes, click a game on that network | It plays the channel live, showing the new programme. If it plays the old programme or fails, record it: channels must then be learned per game (see `docs/specs/2026-10-03-learned-channels-design.md`) |
 
 Record the date, the build, and any row that failed.
```

Row 17 is the spec's open observation: whether an old address still plays its channel live after the programme changes.

- [ ] **Step 2: Record the follow-up in ADR 0002**

Apply this change to `docs/adr/0002-desktop-shell-playback.md`:

```diff
--- a/docs/adr/0002-desktop-shell-playback.md
+++ b/docs/adr/0002-desktop-shell-playback.md
@@ -49,9 +49,21 @@ per network or per game depends on the address-stability observation above.
 
 ## Consequences
 
-- Until learned channels exist, every assignment in the shell is a data tile.
 - The provider allowlist is four exact hosts (`tv.youtube.com`, `www.youtube.com`,
   `accounts.youtube.com`, `accounts.google.com`). Sign-in was proven in the spike without an
   allowlist; if it stalls in the shell, the terminal names the blocked host.
 - The stream budget is unknown and is not enforced.
 - The display backend may need to differ per machine; both start scripts are kept.
+
+## Follow-up: learned channels (2026-10-03)
+
+Built as designed in `docs/specs/2026-10-03-learned-channels-design.md`. What changed in the shell:
+
+- A guide view reads only the address its page lands on (`did-navigate`, `did-navigate-in-page`);
+  nothing is injected. The Hub keeps the channel's live address (`/watch/<id>?vp=0gEEEgIwAQ%3D%3D`).
+- Observed in the live guide: one channel picked twice gives the same id; different channels give
+  different ids; "from the beginning" adds an absolute start time to the address. Whether an old
+  address still plays the channel live after its programme changes is game-day checklist row 17.
+- Subframe navigations are held to the Hub's origin in the shell window only. Provider views do not
+  guard subframes: their pages embed frames from hosts the four-host allowlist does not name, and
+  refusing them could break sign-in or playback in ways only a game day would show.
```

- [ ] **Step 3: Mark the deferred findings this plan takes**

Apply this change to `docs/plans/2026-10-03-thin-vertical-slice.md`:

```diff
--- a/docs/plans/2026-10-03-thin-vertical-slice.md
+++ b/docs/plans/2026-10-03-thin-vertical-slice.md
@@ -2856,7 +2856,7 @@ git commit -m "docs: decision records and game-day checklist"
 
 In the order the product plan's phases call for them:
 
-0. **Learned channels** (decided 2026-10-03, see `docs/adr/0002-desktop-shell-playback.md`) — an unknown network opens YouTube TV's live guide in the tile; the shell reports the address the view lands on; the Hub remembers it. Replaces the hand-filled channel map. First confirm whether an address identifies a channel or a programme.
+0. **Learned channels** (decided 2026-10-03, see `docs/adr/0002-desktop-shell-playback.md`) — an unknown network opens YouTube TV's live guide in the tile; the shell reports the address the view lands on; the Hub remembers it. Replaces the hand-filled channel map. First confirm whether an address identifies a channel or a programme. **Planned in `docs/plans/2026-10-03-learned-channels.md`.**
 0. **shadcn/ui** (decided 2026-10-03) — adopt it as the web UI's component base as the first UI task: design tokens in `theme.css`, components under `apps/web/src/ui/` with the class-merging helper as its own named file (shadcn's default `lib/utils.ts` and `components/ui/` paths break the layout rules).
-1. **Tracker** — `Store` port with SQL, `GameEvent` and `diff`, game detail, standings, follows, watchability, availability, CollegeFootballData for FBS gaps, the access token and network binding so other devices can connect, couch mode.
+1. **Tracker** — SQL stores per concept on the `Database` module (each owns its migrations, as the channel store does), `GameEvent` and `diff`, game detail, standings, follows, watchability, availability, CollegeFootballData for FBS gaps, the access token and network binding so other devices can connect, couch mode.
 2. **Stage** — layouts beyond 2×2, presets, hotkeys, stream budget enforcement, data tiles with real content, more than one Display.
@@ -2868,7 +2868,7 @@ In the order the product plan's phases call for them:
 Recorded by the final whole-branch review on 2026-10-03. Each belongs to the plan named.
 
 **Tracker**
-- Test `GET /api/live` end to end (framing, content type, current state first) — first task.
+- Test `GET /api/live` end to end (framing, content type, current state first) — first task. **Done in learned channels.**
 - Ingest: add a request timeout mapped to `ProviderError`, and catch and log a defect inside a poll so the loop cannot die silently.
 - Ingest: publish only when the slate changed.
 - Ingest: test the per-league fallback with two leagues.
@@ -2876,22 +2876,22 @@ Recorded by the final whole-branch review on 2026-10-03. Each belongs to the pla
 - dependency-cruiser: make `provider-payloads-are-private` per-provider with a backreference, when a second provider folder exists.
 - `delayed` games: decide whether they count as live for ordering and cadence; pin the ordering of delayed, postponed, and canceled games with tests.
 - Web: decode live messages with a non-throwing decoder and warn on failure; show `OT` instead of `Q5`.
-- `HubServer.test.ts`: wait for the first non-empty slate instead of a single yield.
+- `HubServer.test.ts`: wait for the first non-empty slate instead of a single yield. **Done in learned channels.**
 
 **Stage**
-- Stage tests: assert the rejection reason; cover assign over an occupied tile, audio focus unchanged by assign and clear, and a move that becomes a data tile.
+- Stage tests: assert the rejection reason; cover assign over an occupied tile, audio focus unchanged by assign and clear, and a move that becomes a data tile. **Done in learned channels.**
 - Web: re-sync tile placements with a `ResizeObserver` on the video areas.
-- Web: surface a rejected or failed stage command to the user.
+- Web: surface a rejected or failed stage command to the user. Done for channel commands only in learned channels; stage commands remain.
 
 **Reach**
 - Hub: refuse non-loopback binds until the access token exists; check `Host` and `Origin`.
-- Decode the channel map at boot.
-- Web: name the source in a stream tile's link instead of hard-coding YouTube TV.
-- Desktop: guard subframe navigations (`will-frame-navigate`).
+- Decode the channel map at boot. Settled in learned channels: the map is gone.
+- Web: name the source in a stream tile's link instead of hard-coding YouTube TV. **Done in learned channels.**
+- Desktop: guard subframe navigations (`will-frame-navigate`). Done for the shell window in learned channels; provider views deliberately not (see ADR 0002 follow-up).
 
 **Desktop shell** (from the review of the Effect-native restructure; take with learned channels, which reworks these files)
-- `main.ts`: the program is launched at module top level above a class and a const it uses; it works only because the first step is asynchronous. Move the launch last or into a function.
-- `main.ts`: each sync message forks its own fiber over a shared map; serialise them or state the no-async-step assumption.
-- A window closed while the Hub page is loading is logged as "the Hub could not be reached"; a view removed mid-load may log a load error.
-- `WidevineUnavailable` drops the underlying error; carry its code.
-- The two navigation guards (shell window, provider views) share a shape and could be one.
+- `main.ts`: the program is launched at module top level above a class and a const it uses; it works only because the first step is asynchronous. Move the launch last or into a function. **Done in learned channels.**
+- `main.ts`: each sync message forks its own fiber over a shared map; serialise them or state the no-async-step assumption. **Done in learned channels.**
+- A window closed while the Hub page is loading is logged as "the Hub could not be reached"; a view removed mid-load may log a load error. **Done in learned channels.**
+- `WidevineUnavailable` drops the underlying error; carry its code. **Done in learned channels** (it carries the error as its cause).
+- The two navigation guards (shell window, provider views) share a shape and could be one. **Done in learned channels.**
```

- [ ] **Step 4: Name the data directory in AGENTS.md**

Apply this change to `AGENTS.md`:

```diff
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -60,7 +60,8 @@ A reader opens a file to see the thing it is named for. Keep it that way.
 - `pnpm check` — format check, lint, typecheck, import boundaries, unused code, tests. Must pass before
   every commit; the push hook runs it.
 - `pnpm format` — apply formatting and safe lint fixes.
-- `pnpm --filter @sportal/hub dev` — run the Hub on http://127.0.0.1:4400 (API and live stream only).
+- `pnpm --filter @sportal/hub dev` — run the Hub on http://127.0.0.1:4400 (API and live stream only). It
+  keeps its SQLite database in `SPORTAL_DATA_DIR`, by default `.sportal/` in the directory it runs from.
 - `pnpm --filter @sportal/web dev` — run the web UI on http://127.0.0.1:4401, proxying `/api` to the Hub.
 - `SPORTAL_HUB_URL=http://127.0.0.1:4401 pnpm --filter @sportal/desktop start` — build and run the desktop
   shell against the web dev server. Use `start:x11` instead of `start` to run through XWayland.
```

- [ ] **Step 5: Check and commit**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and every test passes.

```bash
git add AGENTS.md docs
git commit -m "docs: game-day rows for learned channels, ADR 0002 follow-up, deferred findings taken

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Run the game-day checklist**

On a game day, with the Hub serving the built web UI and the shell running and signed in, run every row of `docs/game-day-checklist.md`. Rows 3, 4, 9, 10, 15, and 17 are the ones this plan adds; they are the only test of guide reporting against real YouTube TV. Record the date, the build, and any row that failed.
