# Learned Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a game on any network YouTube TV carries plays it in the desktop shell, without a hand-filled channel map: the first time a network is seen its tile opens YouTube TV's live guide, the user picks the channel once, and the Hub remembers it across restarts.

**Architecture:** The Hub gains a `Store` port (SQLite through `effect/sql`) that holds channel answers. The YouTube TV source reads them into memory, resolves each game's `Availability` (carried, unlearned, or not carried), and learns new channels through a `channels` API group. `Stage.apply` turns availability into stream, picking, or data tiles, and `Stage.refresh` re-resolves every Display's tiles whenever the source learns or forgets something. The shell lays a guide view over each picking tile, reports the address the view lands on through the shell bridge, and the web UI turns that report into `POST /api/channels/learn`.

**Tech Stack:** TypeScript 6, Effect 4.0.0 (`effect`, `effect/sql`, `effect/http-api`), `@effect/sql-sqlite-node` 4.0.0 on Node 24's `node:sqlite`, `@effect/platform-node` 4.0.0, React 19, Electron 44 (castlabs Widevine build), Vitest 5, Biome 2.5, dependency-cruiser 18, knip 6.

**Spec:** `docs/specs/2026-10-03-learned-channels-design.md` (approved 2026-10-03).

**Status of the code in this plan:** proposed, not yet built. Every code block is written against the code on `main` at `f229b74` and has not been compiled or run. Expected test counts and command outputs are what each step should produce; if a step's output differs, stop and reconcile before moving on. The desktop shell's guide reporting can only be proven against real YouTube TV, which the game-day checklist rows added in Task 9 do.

## Global Constraints

- Read `AGENTS.md` before every task. Its rules on file layout and in-file order are requirements, not style.
- Effect is pinned to exactly `4.0.0`, and `@effect/sql-sqlite-node` to exactly `4.0.0`. Do not write Effect code from memory; consult `node_modules/effect/ai-docs/src/` (SQL: `40_sql`, HTTP: `51_http-server`).
- TypeScript stays on `^6`. Node 24 via `mise` (`mise exec -- <command>` if your shell has not activated mise).
- `pnpm check` must pass before every commit.
- Domain vocabulary is binding: every exported type name is a term in `CONTEXT.md`. A new term gets its row in the same commit.
- Banned file and folder names: `utils`, `helpers`, `common`, `shared`, `misc`, `lib`, `types`, `constants`, `models`, `interfaces`, `index.ts`.
- In the Hub, only `main.ts` and tests name concrete adapters (`EspnProvider`, `YouTubeTv`, and from Task 2 `SqlStore`).
- Provider web players are loaded unmodified: no script injection, no request rewriting, no capture. The shell sets a view's address, bounds, and mute flag, and reads the address it navigated to; nothing else.
- The address stored for a channel is the canonical live address, `https://tv.youtube.com/watch/<id>?vp=0gEEEgIwAQ%3D%3D`. A stored "from the beginning" address would replay every later game from its kickoff.
- A channel is remembered per network and source. If game-day checklist row 17 shows an old address plays the old programme, the key becomes game, network, and source; only the store's key and the `availability` lookup change.
- The Hub binds to `127.0.0.1`. Poll ESPN no faster than `Cadence` allows.

## Where this plan differs from the spec

Refinements made while planning, for review with the plan. None changes what the user sees.

- **The SQLite risk does not exist.** `@effect/sql-sqlite-node` 4.0.0 runs on `node:sqlite`, not `better-sqlite3`; nothing native is installed (Task 2).
- **`Network` lives in `Game.ts`, and the source concepts in a new domain `Source.ts`.** There is no `Broadcast.ts`: no type here is a Broadcast. Decided in review of this plan (Task 1).
- **`Store` takes an answer, not three verbs.** The port is `channelAnswers`, `answer(ChannelAnswer)`, and `forget(network, source)`; the `Source` port keeps `learn`, `markNotCarried`, and `forget` (Tasks 2 and 4).
- **`Source.availability` is an effect that returns a lookup** (`Effect<(game) => Availability>`), because what the source knows lives in a ref (Task 3).
- **A stream tile carries its whole `Channel`**, and a picking tile and `Unlearned` availability carry the `SourceName`. The UI needs the channel's network for **wrong channel** and the source's name for its labels. `SourceName` (`"YouTube TV"`) is a new glossary term (Tasks 1 and 3).
- **A guide view reports each distinct channel address**, not only the first, so a pick the Hub refused can be retried (Task 6).
- **Subframe guarding applies to the shell window only**, not provider views (Task 7, recorded in ADR 0002).
- **`WidevineUnavailable` carries the underlying error as its `cause`** rather than a code (Task 7).
- **`ChannelPick`** (`{ tile, url }`) is a named schema in the bridge contract, with a glossary row, because the preload, the shell, and the web UI all use it (Task 6).

## Out of scope

- The stream budget and what happens at the provider's concurrent-stream limit.
- Regional feeds: a learned CBS channel is the user's local CBS, which may be showing a different regional game from the one clicked. A known limitation; the Tracker's availability work handles it.
- Learning a channel in a plain browser.
- Saving the Stage across Hub restarts (only channel answers are stored).
- Every Tracker, Stage, Director, and Reach item in `docs/plans/2026-10-03-thin-vertical-slice.md`, other than the deferred findings this plan names.

## File map

```
sportal/
├── AGENTS.md, CONTEXT.md, .gitignore, .dependency-cruiser.cjs           Tasks 1–3, 6, 9
├── docs/game-day-checklist.md, docs/adr/0002-…, docs/plans/…slice.md  Task 9
├── packages/
│   ├── domain/src/
│   │   ├── Source.ts (+ test)           SourceName, Channel, ChannelAnswer,
│   │   │                                Availability, NotAChannel, availability()   Task 1
│   │   ├── Game.ts                      Network; broadcasts: Array<Network>          Task 1
│   │   └── Stage.ts (+ test)            PickingChannel tile, apply(availability), refresh   Task 3
│   └── api/src/
│       ├── SportalApi.ts                channels group                               Task 5
│       └── ShellBridge.ts               role, ChannelPick, onChannelPicked           Task 6
└── apps/
    ├── hub/
    │   ├── package.json                 @effect/sql-sqlite-node 4.0.0                Task 2
    │   └── src/
    │       ├── store/Store.ts, SqlStore.ts (+ test)                                  Task 2
    │       ├── source/Source.ts, YouTubeTv.ts (+ test)                               Tasks 3–4
    │       ├── source/youtube-tv-channels.json   deleted                             Task 3
    │       ├── stage/StageSessions.ts (+ test)   availability, refresh               Tasks 3–5
    │       ├── http/HubServer.ts (+ test)        channel handlers, /api/live test    Task 5
    │       └── main.ts                           data dir, store, source             Tasks 2–4
    ├── desktop/src/
    │   ├── preload/ShellBridge.ts                onChannelPicked                     Task 6
    │   └── main/TileViews.ts (+ test)            guide views report picks            Tasks 6–7
    │       ProviderSession.ts (+ test)           confine                             Task 7
    │       main.ts                               picks to the window; findings       Tasks 6–7
    └── web/src/
        ├── hub/HubClient.ts                      channel commands                    Task 8
        └── stage/StageView.tsx                   picking tiles, wrong channel        Tasks 3, 6, 8
```

---

### Task 1: Domain — networks, channels, and availability

**Files:**
- Create: `packages/domain/src/Source.ts`
- Test: `packages/domain/src/Source.test.ts`
- Modify: `packages/domain/src/Game.ts` (adds `Network`; `broadcasts` becomes `Array<Network>`)
- Modify: `apps/hub/src/provider/espn/EspnProvider.ts` (brands network names)
- Modify: tests that build snapshots with networks: `apps/hub/src/http/HubServer.test.ts`, `apps/hub/src/ingest/Cadence.test.ts`, `apps/hub/src/ingest/Ingest.test.ts`, `apps/hub/src/provider/espn/EspnProvider.test.ts`, `apps/hub/src/stage/StageSessions.test.ts`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `Stream.StreamLocator` (`{ _tag: "WebView", url }`), `Game.GameSnapshot`.
- Produces, importable as `@sportal/domain/Game`:
  - `Network` — branded string schema and type; `Network.make("ESPN")`.
- Produces, importable as `@sportal/domain/Source` (the pure concepts of a video source; the Hub's `Source` port wraps them and imports them by name):
  - `SourceName` — `Schema.Literals(["YouTube TV"])`.
  - `Channel` — `{ network: Network, source: SourceName, locator: StreamLocator }`.
  - `ChannelAnswer` — `{ _tag: "Carried", channel: Channel } | { _tag: "NotCarried", network, source }`.
  - `Availability` (type only) — `{ _tag: "Carried", channel } | { _tag: "Unlearned", network, source, guide: StreamLocator } | { _tag: "NotCarried" }`.
  - `NotAChannel` — tagged error, no fields, HTTP 422.
  - `availability(networks, answers, guide: { source, locator }): Availability` — a carried network wins; otherwise the first network with no answer is `Unlearned`; otherwise `NotCarried`.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/src/Source.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Network } from "./Game.ts"
import * as Source from "./Source.ts"

const espn = Network.make("ESPN")
const disney = Network.make("Disney+")
const espnPlus = Network.make("ESPN+")
const guide = {
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/live" }
}
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

describe("Source.availability", () => {
  it("is carried when the network has a channel", () => {
    assert.deepStrictEqual(Source.availability([espn], [carried], guide), {
      _tag: "Carried",
      channel: espnChannel
    })
  })

  it("is unlearned when nothing is known about the network", () => {
    assert.deepStrictEqual(Source.availability([espn], [], guide), {
      _tag: "Unlearned",
      network: espn,
      source: "YouTube TV",
      guide: guide.locator
    })
  })

  it("prefers a carried network over an earlier unlearned one", () => {
    assert.strictEqual(Source.availability([disney, espn], [carried], guide)._tag, "Carried")
  })

  it("asks about the first network with no answer, skipping ones not carried", () => {
    assert.deepStrictEqual(Source.availability([espnPlus, disney, espn], [notCarried(espnPlus)], guide), {
      _tag: "Unlearned",
      network: disney,
      source: "YouTube TV",
      guide: guide.locator
    })
  })

  it("is not carried when every network is not carried", () => {
    assert.deepStrictEqual(Source.availability([espnPlus], [notCarried(espnPlus)], guide), {
      _tag: "NotCarried"
    })
  })

  it("is not carried when the game lists no networks", () => {
    assert.deepStrictEqual(Source.availability([], [carried], guide), { _tag: "NotCarried" })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/domain/src/Source.test.ts`
Expected: FAIL — `./Source.ts` does not exist (`Test Files  1 failed`, `Tests  no tests`).


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
 }) {}
```

Create `packages/domain/src/Source.ts`:

```ts
import { Schema } from "effect"
import { Network } from "./Game.ts"
import { StreamLocator } from "./Stream.ts"

/** The sources Sportal can play video from, by the name people know them by. */
export const SourceName = Schema.Literals(["YouTube TV"])
export type SourceName = typeof SourceName.Type

/** A network as carried by a specific source. */
export const Channel = Schema.Struct({ network: Network, source: SourceName, locator: StreamLocator })
export type Channel = typeof Channel.Type

/** What is known about a network on a source: carried on a channel, or not carried at all. */
export const ChannelAnswer = Schema.Union([
  Schema.TaggedStruct("Carried", { channel: Channel }),
  Schema.TaggedStruct("NotCarried", { network: Network, source: SourceName })
])
export type ChannelAnswer = typeof ChannelAnswer.Type

/** Whether and where a source can show one game. */
export type Availability =
  | { readonly _tag: "Carried"; readonly channel: Channel }
  | {
      readonly _tag: "Unlearned"
      readonly network: Network
      readonly source: SourceName
      readonly guide: StreamLocator
    }
  | { readonly _tag: "NotCarried" }

/** An address a source refused to learn, because it is not one of the source's live channels. */
export class NotAChannel extends Schema.TaggedError<NotAChannel>()(
  "NotAChannel",
  {},
  { httpApiStatus: 422 }
) {}

/**
 * Where a source can show a game, given the game's networks in broadcast order and the source's answers.
 * A carried network wins; otherwise the first network with no answer is the one to learn next.
 */
export function availability(
  networks: ReadonlyArray<Network>,
  answers: ReadonlyArray<ChannelAnswer>,
  guide: { source: SourceName; locator: StreamLocator }
): Availability {
  const answerFor = (network: Network) =>
    answers.find((answer) =>
      answer._tag === "Carried" ? answer.channel.network === network : answer.network === network
    )
  for (const network of networks) {
    const answer = answerFor(network)
    if (answer?._tag === "Carried") return answer
  }
  const unlearned = networks.find((network) => answerFor(network) === undefined)
  return unlearned === undefined
    ? { _tag: "NotCarried" }
    : { _tag: "Unlearned", network: unlearned, source: guide.source, guide: guide.locator }
}
```

`Availability` is a plain type, not a schema: it never crosses the wire (tiles do). `ChannelAnswer` is a schema because the store decodes it.

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm vitest run packages/domain/src/Source.test.ts`
Expected: `Tests  6 passed (6)`.


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
@@ -75,7 +76,7 @@ function toSnapshot(league: LeagueId, event: typeof EspnPayload.Event.Type): Opt
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
@@ -15,7 +16,7 @@ const game = snapshot({
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
@@ -6,11 +7,12 @@ import { Ingest } from "../ingest/Ingest.ts"
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
@@ -19,7 +21,7 @@ const TestSessions = StageSessions.layer.pipe(
       Source,
       Source.of({
         locate: (snapshot) =>
-          snapshot.broadcasts.includes("ESPN")
+          snapshot.broadcasts.includes(espn)
             ? Option.some({ _tag: "WebView", url: `https://tv.example/${snapshot.id}` })
             : Option.none()
       })
```

- [ ] **Step 6: Add the words**

Apply this change to `CONTEXT.md`:

```diff
--- a/CONTEXT.md
+++ b/CONTEXT.md
@@ -39,9 +39,13 @@ Every exported type name must be a term here.
 | **Ingest** | The Hub's loop that polls providers and keeps the current slate. | poller, sync, fetcher |
 | **Cadence** | How long Ingest waits between polls, given what the last poll saw. | interval, rate |
 | **Source** | A way you obtain **video** (YouTube TV). | provider, service |
+| **Source name** | A source as people know it ("YouTube TV"); how code and the UI name a source. | source id |
 | **Broadcast** | The fact that a network is airing a game. | channel, stream |
+| **Network** | A network's name as a provider reports it ("CBS", "ESPN"). | channel, station |
 | **Channel** | A network as carried by a specific source. | |
-| **Availability** | Whether and where a source can show a game. | |
+| **Channel answer** | What is known about a network on a source: carried on a channel, or not carried. | mapping |
+| **Not a channel** | An address a source refused to learn, because it is not one of its live channels. | |
+| **Availability** | Whether and where a source can show a game: carried, unlearned (its network still to be picked), or not carried. | |
 | **Stream** | One playing instance of a game from a source. | feed, video |
 | **StreamLocator** | What a Display must load to play a stream. | URL, link |
 | **StreamBudget** | How many concurrent streams a source allows. | limit, cap |
```

- [ ] **Step 7: Check**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and `Tests  63 passed (63)`.


- [ ] **Step 8: Commit**

```bash
git add CONTEXT.md packages/domain/src apps/hub/src
git commit -m "feat(domain): networks, channels, and availability

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Store port and its SQLite implementation

**Files:**
- Modify: `apps/hub/package.json` (adds `@effect/sql-sqlite-node` 4.0.0, exact)
- Create: `apps/hub/src/store/Store.ts`, `apps/hub/src/store/SqlStore.ts`
- Test: `apps/hub/src/store/SqlStore.test.ts`
- Modify: `apps/hub/src/main.ts` (data directory, store layer)
- Modify: `.dependency-cruiser.cjs` (`SqlStore.ts` is an adapter only `main.ts` and tests may name), `.gitignore` (`.sportal/`), `CONTEXT.md`

**Interfaces:**
- Consumes: `ChannelAnswer`, `Network`, `SourceName` from Task 1.
- Produces:
  - `Store` (service `sportal/hub/Store`): `channelAnswers: Effect<ReadonlyArray<ChannelAnswer>, StoreError>`; `answer(answer: ChannelAnswer): Effect<void, StoreError>` (replaces any earlier answer for the same network and source); `forget(network, source): Effect<void, StoreError>`.
  - `StoreError` — tagged error with `cause: Schema.Defect()`.
  - `SqlStore.layer(filename: string): Layer<Store, SqlError | MigrationError>` — opens the SQLite file (or `":memory:"`), runs migrations, provides `Store`.

**The driver risk is settled.** The spec feared `@effect/sql-sqlite-node` would need `better-sqlite3`, a native module pnpm 12 will not build. Version 4.0.0 is built on Node 24's own `node:sqlite` (`import { DatabaseSync } from "node:sqlite"` in its `SqliteClient.js`), and its only dependency is `effect`. Nothing native is installed, so the fallback is not needed.

- [ ] **Step 1: Add the driver**

Run: `pnpm --filter @sportal/hub add @effect/sql-sqlite-node@4.0.0 --save-exact`
Expected: `Done`; `apps/hub/package.json` lists `"@effect/sql-sqlite-node": "4.0.0"`.


- [ ] **Step 2: Write the port**

Create `apps/hub/src/store/Store.ts`:

```ts
import type { Network } from "@sportal/domain/Game"
import type { ChannelAnswer, SourceName } from "@sportal/domain/Source"
import { Context, type Effect, Schema } from "effect"

/** The Hub's persistence. It holds only what cannot be fetched again: today, the channel answers. */
export class Store extends Context.Service<
  Store,
  {
    readonly channelAnswers: Effect.Effect<ReadonlyArray<ChannelAnswer>, StoreError>
    /** Records an answer, replacing any earlier answer for the same network and source. */
    answer(answer: ChannelAnswer): Effect.Effect<void, StoreError>
    forget(network: Network, source: SourceName): Effect.Effect<void, StoreError>
  }
>()("sportal/hub/Store") {}

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", { cause: Schema.Defect() }) {}
```

The spec named the writes `learn`, `markNotCarried`, and `forget`. Since a channel answer is already a union of the two cases, the port takes the answer itself: `answer` and `forget`. The source (Task 4) keeps the three verbs.

- [ ] **Step 3: Write the failing test**

Create `apps/hub/src/store/SqlStore.test.ts`:

```ts
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import { Effect, FileSystem } from "effect"
import * as SqlStore from "./SqlStore.ts"
import { Store } from "./Store.ts"

const espn = Network.make("ESPN")
const espnPlus = Network.make("ESPN+")
const carried = (url: string) => ({
  _tag: "Carried" as const,
  channel: { network: espn, source: "YouTube TV" as const, locator: { _tag: "WebView" as const, url } }
})
const notCarried = { _tag: "NotCarried" as const, network: espnPlus, source: "YouTube TV" as const }

describe("SqlStore", () => {
  it.effect("starts with no answers and returns each answer recorded", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      const answers = yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* store.channelAnswers, [])
          yield* store.answer(carried("https://tv.youtube.com/watch/espn"))
          yield* store.answer(notCarried)
          return yield* store.channelAnswers
        })
      )
      assert.sameDeepMembers([...answers], [carried("https://tv.youtube.com/watch/espn"), notCarried])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("replaces an earlier answer for the same network", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      const answers = yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          yield* store.answer(carried("https://tv.youtube.com/watch/first"))
          yield* store.answer(carried("https://tv.youtube.com/watch/second"))
          return yield* store.channelAnswers
        })
      )
      assert.deepStrictEqual(answers, [carried("https://tv.youtube.com/watch/second")])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("forgets an answer", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      const answers = yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          yield* store.answer(carried("https://tv.youtube.com/watch/espn"))
          yield* store.forget(espn, "YouTube TV")
          return yield* store.channelAnswers
        })
      )
      assert.deepStrictEqual(answers, [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps answers when the store is opened again", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      yield* withStore(filename, (store) => store.answer(notCarried))
      const answers = yield* withStore(filename, (store) => store.channelAnswers)
      assert.deepStrictEqual(answers, [notCarried])
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

/** Runs `use` against a store over the given database file, opened fresh. */
function withStore<A, E>(filename: string, use: (store: typeof Store.Service) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    return yield* use(yield* Store)
  }).pipe(Effect.provide(SqlStore.layer(filename)))
}
```

- [ ] **Step 4: Run it to see it fail**

Run: `pnpm vitest run apps/hub/src/store`
Expected: FAIL — `./SqlStore.ts` does not exist.


- [ ] **Step 5: Write the implementation**

Create `apps/hub/src/store/SqlStore.ts`:

```ts
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Network } from "@sportal/domain/Game"
import { type ChannelAnswer, SourceName } from "@sportal/domain/Source"
import { DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { Store, StoreError } from "./Store.ts"

/** The store over a SQLite database file, migrated to the current schema before first use. */
export const layer = (filename: string) =>
  Layer.effect(
    Store,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const channelRows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({
          network: Network,
          source: SourceName,
          carried: Schema.Literals([0, 1]),
          url: Schema.NullOr(Schema.String)
        }),
        execute: () => sql`SELECT network, source, carried, url FROM channel`
      })

      const channelAnswers = channelRows().pipe(
        Effect.map((rows) =>
          rows.map(
            ({ network, source, carried, url }): ChannelAnswer =>
              carried === 1 && url !== null
                ? { _tag: "Carried", channel: { network, source, locator: { _tag: "WebView", url } } }
                : { _tag: "NotCarried", network, source }
          )
        ),
        Effect.mapError((cause) => new StoreError({ cause }))
      )

      const answer = Effect.fn("SqlStore.answer")(function* (answer: ChannelAnswer) {
        const row =
          answer._tag === "Carried"
            ? {
                network: answer.channel.network,
                source: answer.channel.source,
                carried: 1,
                url: answer.channel.locator.url
              }
            : { network: answer.network, source: answer.source, carried: 0, url: null }
        const answeredAt = DateTime.formatIso(yield* DateTime.now)
        yield* sql`
          INSERT INTO channel ${sql.insert({ ...row, answered_at: answeredAt })}
          ON CONFLICT (network, source) DO UPDATE SET
            carried = excluded.carried, url = excluded.url, answered_at = excluded.answered_at
        `.pipe(Effect.mapError((cause) => new StoreError({ cause })))
      })

      const forget = Effect.fn("SqlStore.forget")((network: Network, source: SourceName) =>
        sql`DELETE FROM channel WHERE network = ${network} AND source = ${source}`.pipe(
          Effect.asVoid,
          Effect.mapError((cause) => new StoreError({ cause }))
        )
      )

      return Store.of({ channelAnswers, answer, forget })
    })
  ).pipe(Layer.provide(migrations), Layer.provide(SqliteClient.layer({ filename })))

const migrations = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "0001_create_channel": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE channel (
          network TEXT NOT NULL,
          source TEXT NOT NULL,
          carried INTEGER NOT NULL,
          url TEXT,
          answered_at TEXT NOT NULL,
          PRIMARY KEY (network, source)
        )
      `
    })
  })
})
```

Rows are decoded with a struct written at the point of use, not a named row type: `ChannelAnswer` stays the only type. `answered_at` comes from Effect's `Clock`.

- [ ] **Step 6: Run it to see it pass**

Run: `pnpm vitest run apps/hub/src/store`
Expected: `Tests  4 passed (4)`.


- [ ] **Step 7: Give the Hub a data directory**

Replace `apps/hub/src/main.ts`:

```ts
import { createServer } from "node:http"
import { join } from "node:path"
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect, FileSystem, Layer, Option } from "effect"
import { FetchHttpClient, HttpRouter, HttpStaticServer } from "effect/http"
import * as HubServer from "./http/HubServer.ts"
import { Ingest } from "./ingest/Ingest.ts"
import * as EspnProvider from "./provider/espn/EspnProvider.ts"
import * as YouTubeTv from "./source/YouTubeTv.ts"
import channels from "./source/youtube-tv-channels.json" with { type: "json" }
import { StageSessions } from "./stage/StageSessions.ts"
import * as SqlStore from "./store/SqlStore.ts"

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
      Layer.provide(Ingest.layer(["nfl", "fbs"])),
      Layer.provide(EspnProvider.layer),
      Layer.provide(SqlStore.layer(join(dataDir, "sportal.sqlite"))),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(NodeHttpServer.layer(createServer, { port, host })),
      Layer.provide(NodeServices.layer)
    )
  })
)

Layer.launch(Hub).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
```

Nothing depends on `Store` yet; providing it here creates and migrates the database at boot, which proves the wiring before Task 4 uses it. `Effect.provide(NodeServices.layer)` on the launch gives the boot step its `FileSystem`.

Apply this change to `.dependency-cruiser.cjs`:

```diff
--- a/.dependency-cruiser.cjs
+++ b/.dependency-cruiser.cjs
@@ -36,7 +36,7 @@ module.exports = {
         path: "^apps/hub/src/",
         pathNot: "(^apps/hub/src/main\\.ts$|\\.test\\.ts$|^apps/hub/src/provider/[^/]+/)"
       },
-      to: { path: "^apps/hub/src/(provider/[^/]+/|source/YouTubeTv\\.ts$)" }
+      to: { path: "^apps/hub/src/(provider/[^/]+/|source/YouTubeTv\\.ts$|store/SqlStore\\.ts$)" }
     },
     {
       name: "test-game-is-for-tests",
```
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

- [ ] **Step 8: Add the words**

Apply this change to `CONTEXT.md`:

```diff
--- a/CONTEXT.md
+++ b/CONTEXT.md
@@ -59,6 +59,8 @@ Provider and Source are the two words most likely to be swapped. Provider is alw
 | **Hub** | The server process that owns all shared state. | backend, server |
 | **Live message** | One update the Hub pushes to clients on the live stream: the slate changed, or the Stage changed. | event, notification |
 | **Stage sessions** | The Hub component holding the authoritative Stage for each Display and applying stage commands to it. | stage store, stage manager |
+| **Store** | The Hub's persistence: what it cannot fetch again. Today, channel answers. | database, repository |
+| **Store error** | The store could not read or write. | database error |
 | **Display** | A device running the shell and presenting a Stage. | screen, client, player |
 | **Remote** | A client controlling a Display's Stage without presenting it. | controller |
 | **Desk mode** / **Couch mode** | The two presentation densities. | desktop/TV layout |
```

- [ ] **Step 9: Check, and see the database appear**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and `Tests  67 passed (67)`.

Run: `cd apps/hub && SPORTAL_PORT=4490 timeout 8 node src/main.ts; ls .sportal; rm -rf .sportal`
Expected: the Hub logs `Listening on http://127.0.0.1:4490`; `.sportal/` holds `sportal.sqlite`.


- [ ] **Step 10: Commit**

```bash
git add CONTEXT.md .dependency-cruiser.cjs .gitignore apps/hub/package.json pnpm-lock.yaml apps/hub/src/main.ts apps/hub/src/store
git commit -m "feat(hub): Store port with a SQLite implementation for channel answers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Stage — tiles resolve by availability, picking tiles, and refresh

**Files:**
- Modify: `packages/domain/src/Stage.ts`
- Test: `packages/domain/src/Stage.test.ts` (rewritten; also covers the deferred Stage test gaps)
- Modify: `apps/hub/src/source/Source.ts`, `apps/hub/src/source/YouTubeTv.ts` (port speaks availability; still a fixed list of answers until Task 4)
- Delete: `apps/hub/src/source/youtube-tv-channels.json`
- Modify: `apps/hub/src/stage/StageSessions.ts`, `apps/hub/src/stage/StageSessions.test.ts`, `apps/hub/src/http/HubServer.test.ts`, `apps/hub/src/main.ts`
- Modify: `apps/web/src/stage/StageView.tsx` (stream tiles carry a channel; a picking tile has a body)
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `Availability`, `Channel`, `Network`, `SourceName` from Task 1.
- Produces:
  - `Stage.Tile` — `Empty | StreamTile { game, channel: Channel } | PickingChannel { game, network, source, guide: StreamLocator } | DataTile { game }`. A stream tile now carries its whole channel, not just a locator, so the UI can forget the channel's network and name its source.
  - `Stage.apply(stage, command, availability: (game: GameId) => Availability)`.
  - `Stage.refresh(stage, availability): Stage` — re-resolves every occupied tile; empty tiles and audio focus are untouched.
  - `Source` port: `availability: Effect<(game: GameSnapshot) => Availability>` replaces `locate`. It is an effect because, from Task 4, what the source knows lives in a ref.

- [ ] **Step 1: Write the failing test**

Replace `packages/domain/src/Stage.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { GameId, Network } from "./Game.ts"
import type { Availability } from "./Source.ts"
import * as Stage from "./Stage.ts"

const bama = GameId.make("401856707")
const irish = GameId.make("401858250")
const fox = Network.make("FOX")
const foxChannel = {
  network: fox,
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" }
}
const guide = { _tag: "WebView" as const, url: "https://tv.youtube.com/live" }
const onFox = (): Availability => ({ _tag: "Carried", channel: foxChannel })
const foxUnlearned = (): Availability => ({ _tag: "Unlearned", network: fox, source: "YouTube TV", guide })
const nowhere = (): Availability => ({ _tag: "NotCarried" })

describe("Stage.apply", () => {
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
    const c = Result.getOrThrow(Stage.apply(b, { _tag: "Clear", tile: 0 }, onFox))
    assert.strictEqual(c.tiles[0]?._tag, "Empty")
    assert.strictEqual(c.tiles[1]?._tag, "StreamTile")
  })

  it("moves audio focus", () => {
    const stage = Result.getOrThrow(Stage.apply(Stage.initial, { _tag: "FocusAudio", tile: 3 }, nowhere))
    assert.strictEqual(stage.audioFocus, 3)
  })

  it("leaves audio focus where it was on assign and clear", () => {
    const focused = Result.getOrThrow(Stage.apply(Stage.initial, { _tag: "FocusAudio", tile: 2 }, nowhere))
    const assigned = assign(focused, 0, bama, onFox)
    const cleared = Result.getOrThrow(Stage.apply(assigned, { _tag: "Clear", tile: 2 }, onFox))
    assert.strictEqual(assigned.audioFocus, 2)
    assert.strictEqual(cleared.audioFocus, 2)
  })

  it("rejects a tile that does not exist, saying why", () => {
    const result = Stage.apply(Stage.initial, { _tag: "FocusAudio", tile: 4 }, nowhere)
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "no-such-tile")
  })
})

describe("Stage.refresh", () => {
  it("turns every picking tile for a network into a stream once its channel is learned", () => {
    const picking = assign(assign(Stage.initial, 0, bama, foxUnlearned), 1, irish, foxUnlearned)
    const refreshed = Stage.refresh(picking, onFox)
    assert.deepStrictEqual(refreshed.tiles[0], { _tag: "StreamTile", game: bama, channel: foxChannel })
    assert.deepStrictEqual(refreshed.tiles[1], { _tag: "StreamTile", game: irish, channel: foxChannel })
  })

  it("moves a picking tile to the game's next unlearned network when one is not carried", () => {
    const espn = Network.make("ESPN")
    const picking = assign(Stage.initial, 0, bama, foxUnlearned)
    const refreshed = Stage.refresh(picking, () => ({
      _tag: "Unlearned",
      network: espn,
      source: "YouTube TV",
      guide
    }))
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
    assert.strictEqual(Stage.refresh(streaming, foxUnlearned).tiles[0]?._tag, "PickingChannel")
  })

  it("leaves empty tiles empty and audio focus where it was", () => {
    const focused = Result.getOrThrow(Stage.apply(Stage.initial, { _tag: "FocusAudio", tile: 3 }, nowhere))
    const refreshed = Stage.refresh(assign(focused, 0, bama, foxUnlearned), onFox)
    assert.deepStrictEqual(
      refreshed.tiles.map((tile) => tile._tag),
      ["StreamTile", "Empty", "Empty", "Empty"]
    )
    assert.strictEqual(refreshed.audioFocus, 3)
  })
})

function assign(stage: Stage.Stage, tile: number, game: GameId, availability: () => Availability) {
  return Result.getOrThrow(Stage.apply(stage, { _tag: "Assign", tile, game }, availability))
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/domain/src/Stage.test.ts`
Expected: FAIL — `Tests  12 failed | 2 passed (14)`.


- [ ] **Step 3: Write the implementation**

Replace `packages/domain/src/Stage.ts`:

```ts
import { Result, Schema } from "effect"
import { GameId, Network } from "./Game.ts"
import { type Availability, Channel, SourceName } from "./Source.ts"
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
}) {}

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

export const initial = new Stage({ tiles: [empty, empty, empty, empty], audioFocus: 0 })

/**
 * Applies a command. `availability` says whether and where a game can be streamed: a carried game
 * becomes a stream tile, a game on an unlearned network a picking tile, and any other a data tile.
 */
export function apply(
  stage: Stage,
  command: StageCommand,
  availability: (game: GameId) => Availability
): Result.Result<Stage, StageRejection> {
  if (command.tile < 0 || command.tile >= stage.tiles.length) {
    return Result.fail(new StageRejection({ reason: "no-such-tile" }))
  }
  switch (command._tag) {
    case "Assign": {
      const tile = tileFor(command.game, availability(command.game))
      // A game appears in at most one tile: assigning it elsewhere moves it.
      const tiles = stage.tiles.map((existing, index) =>
        index === command.tile
          ? tile
          : existing._tag !== "Empty" && existing.game === command.game
            ? empty
            : existing
      )
      return Result.succeed(new Stage({ tiles, audioFocus: stage.audioFocus }))
    }
    case "Clear":
      return Result.succeed(
        new Stage({
          tiles: stage.tiles.map((existing, index) => (index === command.tile ? empty : existing)),
          audioFocus: stage.audioFocus
        })
      )
    case "FocusAudio":
      return Result.succeed(new Stage({ tiles: stage.tiles, audioFocus: command.tile }))
  }
}

/** Re-resolves every occupied tile after what a source knows has changed. */
export function refresh(stage: Stage, availability: (game: GameId) => Availability): Stage {
  return new Stage({
    tiles: stage.tiles.map((tile) =>
      tile._tag === "Empty" ? tile : tileFor(tile.game, availability(tile.game))
    ),
    audioFocus: stage.audioFocus
  })
}

function tileFor(game: GameId, availability: Availability): Tile {
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

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm vitest run packages/domain/src/Stage.test.ts`
Expected: `Tests  14 passed (14)`.


- [ ] **Step 5: Switch the source port to availability and drop the hand-filled map**

Replace `apps/hub/src/source/Source.ts`:

```ts
import type { GameSnapshot } from "@sportal/domain/Game"
import type { Availability } from "@sportal/domain/Source"
import { Context, type Effect } from "effect"

export class Source extends Context.Service<
  Source,
  {
    /** What the source knows right now, as a lookup from a game to where it can be streamed. */
    readonly availability: Effect.Effect<(game: GameSnapshot) => Availability>
  }
>()("sportal/hub/Source") {}
```
Replace `apps/hub/src/source/YouTubeTv.ts`:

```ts
import { availability, type ChannelAnswer } from "@sportal/domain/Source"
import { Effect, Layer } from "effect"
import { Source } from "./Source.ts"

export const layer = (answers: ReadonlyArray<ChannelAnswer>) =>
  Layer.succeed(
    Source,
    Source.of({
      availability: Effect.succeed((game) => availability(game.broadcasts, answers, guide))
    })
  )

const guide = {
  source: "YouTube TV",
  locator: { _tag: "WebView", url: "https://tv.youtube.com/live" }
} as const
```

This version takes a fixed list of answers; Task 4 replaces it with one backed by the store.

Run: `git rm apps/hub/src/source/youtube-tv-channels.json`
Expected: the file is staged for deletion.

Apply this change to `apps/hub/src/main.ts`:

```diff
--- a/apps/hub/src/main.ts
+++ b/apps/hub/src/main.ts
@@ -7,7 +7,6 @@ import * as HubServer from "./http/HubServer.ts"
 import { Ingest } from "./ingest/Ingest.ts"
 import * as EspnProvider from "./provider/espn/EspnProvider.ts"
 import * as YouTubeTv from "./source/YouTubeTv.ts"
-import channels from "./source/youtube-tv-channels.json" with { type: "json" }
 import { StageSessions } from "./stage/StageSessions.ts"
 import * as SqlStore from "./store/SqlStore.ts"
 
@@ -28,7 +27,7 @@ const Hub = Layer.unwrap(
 
     return HttpRouter.serve(routes).pipe(
       Layer.provide(StageSessions.layer),
-      Layer.provide(YouTubeTv.layer(channels)),
+      Layer.provide(YouTubeTv.layer([])),
       Layer.provide(Ingest.layer(["nfl", "fbs"])),
       Layer.provide(EspnProvider.layer),
       Layer.provide(SqlStore.layer(join(dataDir, "sportal.sqlite"))),
```

- [ ] **Step 6: Resolve tiles in Stage sessions by availability**

Replace `apps/hub/src/stage/StageSessions.ts`:

```ts
import type { GameId } from "@sportal/domain/Game"
import type { Availability } from "@sportal/domain/Source"
import * as Stage from "@sportal/domain/Stage"
import { Context, Effect, Layer, Result, type Stream, SubscriptionRef } from "effect"
import { Ingest } from "../ingest/Ingest.ts"
import { Source } from "../source/Source.ts"

export class StageSessions extends Context.Service<
  StageSessions,
  {
    readonly stage: Effect.Effect<Stage.Stage>
    readonly changes: Stream.Stream<Stage.Stage>
    dispatch(command: Stage.StageCommand): Effect.Effect<Stage.Stage, Stage.StageRejection>
  }
>()("sportal/hub/StageSessions") {
  static readonly layer = Layer.effect(
    StageSessions,
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const source = yield* Source
      const current = yield* SubscriptionRef.make(Stage.initial)

      const dispatch = Effect.fn("StageSessions.dispatch")(function* (command: Stage.StageCommand) {
        const availability = yield* availabilityOnSlate(ingest, source)
        // One atomic step: concurrent dispatches queue up, and a rejection leaves the Stage as it was.
        return yield* SubscriptionRef.modifyEffect(current, (stage) => {
          const result = Stage.apply(stage, command, availability)
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
    const lookup = yield* source.availability
    return (id: GameId): Availability => {
      const game = slate.find((candidate) => candidate.id === id)
      return game === undefined ? { _tag: "NotCarried" } : lookup(game)
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

This picking-tile body is temporary; Task 8 gives the tile its real UI.

- [ ] **Step 8: Add the words**

Apply this change to `CONTEXT.md`:

```diff
--- a/CONTEXT.md
+++ b/CONTEXT.md
@@ -74,7 +74,8 @@ Provider and Source are the two words most likely to be swapped. Provider is alw
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
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and `Tests  76 passed (76)`.


- [ ] **Step 10: Commit**

```bash
git add CONTEXT.md packages/domain/src apps/hub/src apps/web/src/stage/StageView.tsx
git commit -m "feat(domain): tiles resolve by availability, picking tiles, and refresh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: YouTube TV learns channels and keeps them in the store

**Files:**
- Modify: `apps/hub/src/source/Source.ts` (port grows `changes`, `learn`, `markNotCarried`, `forget`)
- Modify: `apps/hub/src/source/YouTubeTv.ts` (store-backed; `canonical`)
- Test: `apps/hub/src/source/YouTubeTv.test.ts`
- Modify: `apps/hub/src/main.ts`, `apps/hub/src/stage/StageSessions.test.ts`, `apps/hub/src/http/HubServer.test.ts`

**Interfaces:**
- Consumes: `Store` from Task 2; `availability`, `NotAChannel` from `@sportal/domain/Source` (Task 1).
- Produces:
  - `Source` port: `availability`; `changes: Stream<void>` (once after every change, never the current value); `learn(network, url): Effect<void, NotAChannel | StoreError>`; `markNotCarried(network)`, `forget(network)`: `Effect<void, StoreError>`.
  - `YouTubeTv.layer: Layer<Source, StoreError, Store>` — loads the store's answers at start; each write goes to the store first, then to memory, one at a time.
  - `YouTubeTv.canonical(url): Result<string, NotAChannel>` — `https://tv.youtube.com/watch/<id>` with any query becomes `https://tv.youtube.com/watch/<id>?vp=0gEEEgIwAQ%3D%3D`; anything else is refused.

- [ ] **Step 1: Write the failing test**

The four addresses are the ones recorded from the live guide on 2026-10-03.

Create `apps/hub/src/source/YouTubeTv.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Fiber, Layer, Result, Stream } from "effect"
import * as SqlStore from "../store/SqlStore.ts"
import { Store } from "../store/Store.ts"
import { Source } from "./Source.ts"
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

describe("YouTubeTv.canonical", () => {
  it("keeps a live channel address as it is", () => {
    assert.deepStrictEqual(YouTubeTv.canonical(cbsLive), Result.succeed(cbsLive))
  })

  it("turns a from-the-beginning address into the live address for the same channel", () => {
    assert.deepStrictEqual(YouTubeTv.canonical(foxFromTheBeginning), Result.succeed(foxLive))
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
    assert.isTrue(Result.isFailure(YouTubeTv.canonical(url)))
  })
})

describe("YouTubeTv source", () => {
  it.effect("starts with every network unlearned, pointing at the live guide", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const availability = yield* source.availability
      assert.deepStrictEqual(availability(onEspn), {
        _tag: "Unlearned",
        network: espn,
        source: "YouTube TV",
        guide: { _tag: "WebView", url: "https://tv.youtube.com/live" }
      })
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("learns a channel from a guide address and stores it as the live address", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, foxFromTheBeginning)
      const availability = yield* source.availability
      assert.deepStrictEqual(availability(onEspn), {
        _tag: "Carried",
        channel: { network: espn, source: "YouTube TV", locator: { _tag: "WebView", url: foxLive } }
      })
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("refuses to learn an address that is not a channel, and learns nothing", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const error = yield* source.learn(espn, "https://tv.youtube.com/live").pipe(Effect.flip)
      assert.strictEqual(error._tag, "NotAChannel")
      assert.strictEqual((yield* source.availability)(onEspn)._tag, "Unlearned")
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("moves on to the next network once one is marked not carried", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.markNotCarried(disney)
      const availability = yield* source.availability
      assert.deepStrictEqual(availability(onEspnAndDisney), {
        _tag: "Unlearned",
        network: espn,
        source: "YouTube TV",
        guide: { _tag: "WebView", url: "https://tv.youtube.com/live" }
      })
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("forgets a learned channel", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, cbsLive)
      yield* source.forget(espn)
      assert.strictEqual((yield* source.availability)(onEspn)._tag, "Unlearned")
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("signals a change after each answer, not before", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const signals = yield* source.changes.pipe(Stream.take(2), Stream.runCount, Effect.forkChild)
      yield* Effect.yieldNow
      yield* source.learn(espn, cbsLive)
      yield* source.markNotCarried(disney)
      assert.strictEqual(yield* Fiber.join(signals), 2)
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("loads what the store already knows", () =>
    Effect.gen(function* () {
      const source = yield* Source
      assert.strictEqual((yield* source.availability)(onEspn)._tag, "Carried")
    }).pipe(Effect.provide(YouTubeTv.layer.pipe(Layer.provide(storeKnowingEspn()))))
  )
})

/** The source over a fresh in-memory store. */
function testSource() {
  return YouTubeTv.layer.pipe(Layer.provide(SqlStore.layer(":memory:")))
}

/** An in-memory store that already holds a channel for ESPN when the source starts. */
function storeKnowingEspn() {
  return Layer.effect(
    Store,
    Effect.gen(function* () {
      const store = yield* Store
      yield* store.answer({
        _tag: "Carried",
        channel: { network: espn, source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } }
      })
      return store
    })
  ).pipe(Layer.provide(SqlStore.layer(":memory:")))
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/hub/src/source/YouTubeTv.test.ts`
Expected: FAIL — `YouTubeTv.canonical` is not a function, and `YouTubeTv.layer` is still a function of a list.


- [ ] **Step 3: Grow the port**

Replace `apps/hub/src/source/Source.ts`:

```ts
import type { GameSnapshot, Network } from "@sportal/domain/Game"
import type { Availability, NotAChannel } from "@sportal/domain/Source"
import { Context, type Effect, type Stream } from "effect"
import type { StoreError } from "../store/Store.ts"

export class Source extends Context.Service<
  Source,
  {
    /** What the source knows right now, as a lookup from a game to where it can be streamed. */
    readonly availability: Effect.Effect<(game: GameSnapshot) => Availability>
    /** Emits once after every change to what the source knows. */
    readonly changes: Stream.Stream<void>
    /** Remembers the channel at `url` as where this source carries `network`. */
    learn(network: Network, url: string): Effect.Effect<void, NotAChannel | StoreError>
    markNotCarried(network: Network): Effect.Effect<void, StoreError>
    forget(network: Network): Effect.Effect<void, StoreError>
  }
>()("sportal/hub/Source") {}
```

- [ ] **Step 4: Write the store-backed source**

Replace `apps/hub/src/source/YouTubeTv.ts`:

```ts
import { availability, type ChannelAnswer, NotAChannel } from "@sportal/domain/Source"
import { Effect, Layer, Result, Stream, SubscriptionRef } from "effect"
import { Store } from "../store/Store.ts"
import { Source } from "./Source.ts"

/** YouTube TV as a source. Its channels are learned from the live guide and kept in the store. */
export const layer = Layer.effect(
  Source,
  Effect.gen(function* () {
    const store = yield* Store
    const answers = yield* SubscriptionRef.make(yield* store.channelAnswers)

    // Store first, then memory, one write at a time: a failed write changes nothing.
    const record = (answer: ChannelAnswer) =>
      SubscriptionRef.updateEffect(answers, (known) =>
        store
          .answer(answer)
          .pipe(Effect.as([...known.filter((other) => networkOf(other) !== networkOf(answer)), answer]))
      )

    return Source.of({
      availability: SubscriptionRef.get(answers).pipe(
        Effect.map((known) => (game) => availability(game.broadcasts, known, guide))
      ),
      // The ref's current value comes first on every subscription; only later values are changes.
      changes: SubscriptionRef.changes(answers).pipe(Stream.drop(1), Stream.as(undefined)),
      learn: (network, url) =>
        Effect.fromResult(canonical(url)).pipe(
          Effect.flatMap((address) =>
            record({
              _tag: "Carried",
              channel: { network, source: guide.source, locator: { _tag: "WebView", url: address } }
            })
          )
        ),
      markNotCarried: (network) => record({ _tag: "NotCarried", network, source: guide.source }),
      forget: (network) =>
        SubscriptionRef.updateEffect(answers, (known) =>
          store
            .forget(network, guide.source)
            .pipe(Effect.as(known.filter((answer) => networkOf(answer) !== network)))
        )
    })
  })
)

/**
 * The address that plays a channel live. A guide pick can carry a start point ("from the beginning");
 * storing that would replay every later game on the channel from that moment, so only the live flag is kept.
 */
export function canonical(url: string): Result.Result<string, NotAChannel> {
  if (!URL.canParse(url)) return Result.fail(new NotAChannel())
  const { protocol, hostname, pathname } = new URL(url)
  const id = /^\/watch\/([A-Za-z0-9_-]+)$/.exec(pathname)?.[1]
  return protocol === "https:" && hostname === "tv.youtube.com" && id !== undefined
    ? Result.succeed(`https://tv.youtube.com/watch/${id}?vp=${live}`)
    : Result.fail(new NotAChannel())
}

const live = "0gEEEgIwAQ%3D%3D"

const guide = {
  source: "YouTube TV",
  locator: { _tag: "WebView", url: "https://tv.youtube.com/live" }
} as const

function networkOf(answer: ChannelAnswer) {
  return answer._tag === "Carried" ? answer.channel.network : answer.network
}
```

`SubscriptionRef.updateEffect` makes each write one step: concurrent writes queue, and a store failure leaves memory unchanged. `SubscriptionRef.changes` replays the current value to each new subscriber, so `changes` drops that first element.

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm vitest run apps/hub/src/source/YouTubeTv.test.ts`
Expected: `Tests  16 passed (16)`.


- [ ] **Step 6: Wire it**

Apply this change to `apps/hub/src/main.ts`:

```diff
--- a/apps/hub/src/main.ts
+++ b/apps/hub/src/main.ts
@@ -27,7 +27,7 @@ const Hub = Layer.unwrap(
 
     return HttpRouter.serve(routes).pipe(
       Layer.provide(StageSessions.layer),
-      Layer.provide(YouTubeTv.layer([])),
+      Layer.provide(YouTubeTv.layer),
       Layer.provide(Ingest.layer(["nfl", "fbs"])),
       Layer.provide(EspnProvider.layer),
       Layer.provide(SqlStore.layer(join(dataDir, "sportal.sqlite"))),
```
Replace `apps/hub/src/stage/StageSessions.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId, Network } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Layer, Stream } from "effect"
import { Ingest } from "../ingest/Ingest.ts"
import { Source } from "../source/Source.ts"
import * as YouTubeTv from "../source/YouTubeTv.ts"
import * as SqlStore from "../store/SqlStore.ts"
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

/** YouTube TV over an in-memory store, already knowing ESPN's channel and that ESPN+ is not carried. */
function sourceKnowingEspn() {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, "https://tv.youtube.com/watch/espn")
      yield* source.markNotCarried(espnPlus)
    })
  ).pipe(Layer.provideMerge(YouTubeTv.layer), Layer.provide(SqlStore.layer(":memory:")))
}
```
Apply this change to `apps/hub/src/http/HubServer.test.ts`:

```diff
--- a/apps/hub/src/http/HubServer.test.ts
+++ b/apps/hub/src/http/HubServer.test.ts
@@ -10,14 +10,9 @@ import { Ingest } from "../ingest/Ingest.ts"
 import { Provider } from "../provider/Provider.ts"
 import * as YouTubeTv from "../source/YouTubeTv.ts"
 import { StageSessions } from "../stage/StageSessions.ts"
+import * as SqlStore from "../store/SqlStore.ts"
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
@@ -27,7 +22,8 @@ const game = snapshot({
 
 const TestHub = ApiHandlers.pipe(
   Layer.provide(StageSessions.layer),
-  Layer.provide(YouTubeTv.layer([{ _tag: "Carried", channel: espnChannel }])),
+  Layer.provide(YouTubeTv.layer),
+  Layer.provide(SqlStore.layer(":memory:")),
   Layer.provide(Ingest.layer(["fbs"])),
   Layer.provide(Layer.succeed(Provider, Provider.of({ slate: () => Effect.succeed([game]) })))
 )
@@ -35,7 +31,7 @@ const TestHub = ApiHandlers.pipe(
 const makeClient = HttpApiTest.groups(SportalApi, ["slate", "stage"])
 
 layer(Layer.mergeAll(TestHub, HttpServer.layerServices))("Hub API", (it) => {
-  it.effect("serves the slate and turns an assignment into a stream tile", () =>
+  it.effect("serves the slate and turns an assignment on an unlearned network into a picking tile", () =>
     Effect.gen(function* () {
       const client = yield* makeClient
       // Let the ingest loop's first poll run.
@@ -49,9 +45,11 @@ layer(Layer.mergeAll(TestHub, HttpServer.layerServices))("Hub API", (it) => {
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

With an empty store, an ESPN game is now a picking tile; Task 5 rewrites this test around the channels API.

- [ ] **Step 7: Check**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and `Tests  92 passed (92)`.


- [ ] **Step 8: Commit**

```bash
git add apps/hub/src
git commit -m "feat(hub): YouTube TV learns channels and keeps them in the store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Channels API, and the Stage follows what the source learns

**Files:**
- Modify: `packages/api/src/SportalApi.ts` (the `channels` group)
- Modify: `apps/hub/src/http/HubServer.ts` (its handlers)
- Modify: `apps/hub/src/stage/StageSessions.ts` (refresh on `Source.changes`)
- Test: `apps/hub/src/http/HubServer.test.ts` (rewritten; includes the deferred `/api/live` end-to-end test and waits for the first non-empty slate instead of a single yield), `apps/hub/src/stage/StageSessions.test.ts`

**Interfaces:**
- Consumes: the `Source` port from Task 4; `Stage.refresh` from Task 3.
- Produces:
  - `SportalApi` group `channels`: `learn` `POST /api/channels/learn` `{ network, url }` → 204, or 422 `NotAChannel`; `notCarried` `POST /api/channels/not-carried` `{ network }` → 204; `forget` `POST /api/channels/forget` `{ network }` → 204. A typed client calls them as `client.channels.learn({ payload })` and so on.
  - A store failure in these handlers is a defect (HTTP 500): the client cannot fix it.
  - `StageSessions` applies `Stage.refresh` after every source change and publishes the new Stage through the existing live stream.

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
import { Ingest } from "../ingest/Ingest.ts"
import { Provider } from "../provider/Provider.ts"
import * as YouTubeTv from "../source/YouTubeTv.ts"
import { StageSessions } from "../stage/StageSessions.ts"
import * as SqlStore from "../store/SqlStore.ts"
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
      assert.strictEqual(error._tag, "NotAChannel")
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

/** Everything behind the API, over a fresh in-memory store and a provider that always returns `game`. */
function hubUnderTest() {
  return StageSessions.layer.pipe(
    Layer.provideMerge(YouTubeTv.layer),
    Layer.provide(SqlStore.layer(":memory:")),
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
 import { Ingest } from "../ingest/Ingest.ts"
 import { Source } from "../source/Source.ts"
 import * as YouTubeTv from "../source/YouTubeTv.ts"
@@ -16,11 +16,18 @@ const espnChannel = {
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
@@ -28,7 +35,9 @@ describe("StageSessions", () => {
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
@@ -61,6 +70,22 @@ describe("StageSessions", () => {
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
import { NotAChannel } from "@sportal/domain/Source"
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
        error: NotAChannel
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
+      // A store that cannot be written is not something a client can fix: it is a server error.
+      return handlers.handleAll({
+        learn: ({ payload }) =>
+          source.learn(payload.network, payload.url).pipe(Effect.catchTag("StoreError", Effect.die)),
+        notCarried: ({ payload }) =>
+          source.markNotCarried(payload.network).pipe(Effect.catchTag("StoreError", Effect.die)),
+        forget: ({ payload }) =>
+          source.forget(payload.network).pipe(Effect.catchTag("StoreError", Effect.die))
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
 import type { Availability } from "@sportal/domain/Source"
 import * as Stage from "@sportal/domain/Stage"
-import { Context, Effect, Layer, Result, type Stream, SubscriptionRef } from "effect"
+import { Context, Effect, Layer, Result, Stream, SubscriptionRef } from "effect"
 import { Ingest } from "../ingest/Ingest.ts"
 import { Source } from "../source/Source.ts"
 
@@ -31,6 +31,15 @@ export class StageSessions extends Context.Service<
         })
       })
 
+      // When the source learns or forgets a channel, every tile it affects changes on every Display.
+      const refresh = Effect.gen(function* () {
+        const availability = yield* availabilityOnSlate(ingest, source)
+        yield* SubscriptionRef.update(current, (stage) => Stage.refresh(stage, availability))
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
Expected: `Tests  40 passed (40)`. Run it a few times: it must be stable, since it waits on a live stream.


- [ ] **Step 6: Check**

Run: `pnpm check`
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and `Tests  96 passed (96)`.


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

### Task 6: Shell bridge and guide reporting

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
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and `Tests  99 passed (99)`.

Run: `pnpm --filter @sportal/desktop exec electron-vite build`
Expected: both builds end `✓ built`.


- [ ] **Step 8: Commit**

```bash
git add CONTEXT.md packages/api/src/ShellBridge.ts apps/desktop/src apps/web/src/stage/StageView.tsx
git commit -m "feat(desktop): guide views report the channel the user picks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Desktop findings from the restructure review

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
| Guard subframe navigations (`will-frame-navigate`) | Done for the shell window, which holds the privileged preload. Not done for provider views: their pages embed frames from hosts the four-host allowlist does not name, and refusing them could break sign-in or playback in a way only a game day would show. Recorded in ADR 0002 (Task 9) |

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
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and `Tests  104 passed (104)`.

Run: `pnpm --filter @sportal/desktop exec electron-vite build`
Expected: both builds end `✓ built`.


- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src
git commit -m "fix(desktop): one navigation guard, serial tile syncs, quieter shutdown, and the launch moved last

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Web UI — picking tiles, picks, not carried, and wrong channel

**Files:**
- Modify: `apps/web/src/hub/HubClient.ts`
- Modify: `apps/web/src/stage/StageView.tsx`

**Interfaces:**
- Consumes: the `channels` API group (Task 5), `ShellBridge.onChannelPicked` (Task 6), the tile shapes (Task 3).
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
            Predicate.isTagged(error, "NotAChannel")
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
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and `Tests  104 passed (104)`.

Run: `pnpm --filter @sportal/web build`
Expected: `✓ built`.


- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): picking tiles, channel picks, not carried, and wrong channel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Docs — game-day rows, ADR follow-up, deferred findings

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
+  nothing is injected. The Hub keeps the canonical live address (`/watch/<id>?vp=0gEEEgIwAQ%3D%3D`).
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
 1. **Tracker** — `Store` port with SQL, `GameEvent` and `diff`, game detail, standings, follows, watchability, availability, CollegeFootballData for FBS gaps, the access token and network binding so other devices can connect, couch mode.
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
Expected: format, lint, typecheck, `✔ no dependency violations found`, knip clean, and `Tests  104 passed (104)`.

```bash
git add AGENTS.md docs
git commit -m "docs: game-day rows for learned channels, ADR 0002 follow-up, deferred findings taken

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Run the game-day checklist**

On a game day, with the Hub serving the built web UI and the shell running and signed in, run every row of `docs/game-day-checklist.md`. Rows 3, 4, 9, 10, 15, and 17 are the ones this plan adds; they are the only test of guide reporting against real YouTube TV. Record the date, the build, and any row that failed.
