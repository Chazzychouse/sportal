# UI overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the top bar with a two-level TV guide by league in two themes (Glass, Team), add YouTube custom
tiles, a stats page and stats tile from ESPN's summary, and highlight clips, with the web app's rules loosened for React.

**Architecture:** Eight phases on branch `ui-overhaul`, each ending with `pnpm check` green and a commit. Phase 2 gives
tiles an identity (`TileKey`) that is not only a game, which phases 4, 6 and 7 build on. The guide's state lives in the
pure `Display` fold because Shell hotkeys and the Remote drive it; UI-only state is plain React. The Hub gains a summary
decode and a `Stats` cache behind the provider port, served over the existing `effect/rpc` socket.

**Tech Stack:** TypeScript 7 (tsgo + `@effect/tsgo`), Effect 4 (`effect/rpc`, `effect/reactivity` atoms,
`@effect/atom-react`), React 19, Tailwind 4, shadcn primitives, Electron (desktop shell), Vitest via `@effect/vitest`,
pnpm workspaces.

**Spec:** `docs/specs/2026-10-16-ui-overhaul-design.md`.

## Global Constraints

- Read `AGENTS.md` before writing code. Every rule applies, as loosened for `apps/web` by phase 1's "In the web app"
  section once it lands.
- Effect 4 is newer than training data: check `node_modules/effect/ai-docs/src/` and the `.d.ts` files before using
  any API this plan does not spell out.
- Every new exported type name gets a `CONTEXT.md` row in the same commit; every deleted one loses its row.
- Tests: `it("should …")`, one behaviour each, Arrange/Act/Assert separated by blank lines, `describe` names the unit.
  A rewritten test file's commit body maps each old test name to its new test names, or to the behaviour removed with it.
- `pnpm check` must pass before every commit. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Code in this plan was drafted against `a948d5b`. Where an earlier phase changed a file, the anchors (function and case
  names) are what to follow; adapt text to the file as it now stands, keeping the plan's names and behaviour.
- Do not merge to `main`. Do not push.
- Provider web players load unmodified: no script injection, no request rewriting.

- Tasks are numbered 1–43 across the plan. Each heading also shows its phase and the number it had inside that phase; a
  "Task N" inside a phase's text means that phase's own numbering.

## Amendments (these override the phase parts below where they disagree)

The phases were drafted in parallel; these reconcile them.

1. **Custom stream ids** are derived from the target (`video.<id>`, `list.<id>`, `list.<id>.<videoId>`), not random:
   `CustomStream.parse(url, name?)` as phase 4 writes it. `TileKey.custom(id: string)`.
2. **Guide entries are the leagues with games today.** The Hub follows only some leagues (`EspnLeague.followed`), so a
   fixed league list would show empty tabs. Phase 3 replaces the static `Display.guideEntries` with entries carried
   by the shelves value: `GuideShelves` is
   `interface GuideShelves { readonly entries: ReadonlyArray<GuideEntry>; readonly shelves: (entry: GuideEntry, level: GuideLevel) => ReadonlyArray<ReadonlyArray<GuideItem>> }`,
   and every place the parts call `shelves(entry, level)` calls `shelves.shelves(entry, level)` and reads
   `shelves.entries` for the rail. `entries` is `"AllLive"`, then each `LeagueId` with at least one game in today's list,
   in `LeagueId.literals` order, then (from phase 4) `"Custom"`. A `lastEntry` no longer in `entries` falls back to
   `"AllLive"`. Phase 3's tests add: an entry list without a league that has no games; the fallback. `GuideRail` renders
   `shelves.entries`.
3. **Toasts and video.** With no top bar, a toast is drawn under provider views in the shell. Each visible toast's
   element registers with Covering through `useOverlayRef` (wrap sonner's toast content in a component that takes the
   ref), so the strip it covers hides while it shows. The persistent connection toast keeps that strip hidden until the
   Hub is back. Phase 3, task "The connection toast" and task "The new DisplayView" carry this.
4. **`teamColor(team)`** takes no surface (phase 3's signature). Phases 6–7 call it as phase 3 defines it, with
   `teamEdge` / `teamHalf` where they draw edges and halves.
5. **One placing rule.** Phase 4's private `placed` helper in `Screen` (shared by `Assign` and `AssignCustom`) is the
   one phases 6–7 reuse for `AssignStats` and `AssignClip`; and `Display#place` is the one `ChosenClip` uses.
6. **Overlays with a way back.** `Display#close()` returns `CustomForm` and `GamePage` to their `back`; both are excluded
   from `Opened` like `Guide` (phase 3's exclusion list). The palette opens a game page through
   `DisplayInput.GamePageOpened({ game })`.
7. **`Tile` statics.** Phase 4's `Tile.game(tile)` and `Tile.locator(tile)` gain `StatsTile` (game: its game; locator:
   none) and `ClipTile` (game: the highlight's game; locator: none) in phases 6 and 7, as does `Tile.key`.
8. **`Info`** is mapped in phase 3 and does nothing until phase 6 wires it to `GamePage`.
9. **Stats for unfollowed leagues** are not reachable on a running Hub (no games listed); the decode and fixtures still
   cover NFL, FBS, MLB and NBA.
10. **Phase 8** (docs and eye-check) is written below the parts. `TileKey`'s glossary row lands in phase 2 and is not
    added again.

---

## Phase 1 — Web rules

### Task 1 (phase 1, was task 1): The "In the web app" section in `AGENTS.md` — then commit

**Files:**
- Modify: `AGENTS.md` (insert one section between "How code is written" and "Tests")

**Interfaces:**
- Consumes: nothing.
- Produces: the rules every later phase's web code follows: atoms for state an outside input writes or another view
  reads, React state for a component's own DOM events, props as a non-exported `interface` above the component,
  several components per `.tsx`, `apps/web/src/ui/` for sport-agnostic presentational components, JSX and handlers
  exempt from rules 9–11 and the spelling table, no tests for components.

- [ ] **Step 1: Insert the section**

In `AGENTS.md`, the section "How code is written" ends with the line

```markdown
- No export lives only for its tests: `knip --production` fails on one.
```

and the next line after a blank line is `## Tests`. Between them, insert exactly this (a blank line before and after):

```markdown
## In the web app

These override the rules above for `apps/web` only. Everything else in this file still holds there.

- **State.**
  - Atoms or Effects hold Hub data, the `Screen`, and any state an outside input writes or another view reads: Shell
    hotkeys, the Remote, the shell's provider views. The guide's level, league and focus are such state.
  - Plain React state (`useState`, `useReducer`, refs) holds what only a component's own DOM events touch: hover, a
    collapsed section, a text field's draft, scroll, animation.
  - A pure class with a fold (`Display.apply`) only when the logic has rules worth testing apart. Opening and closing
    something is not such logic.
  - Effect discipline (no bare promises, tagged errors, `Effect.fn`) is for code that does IO, not for UI-only code.
- **Props.** A component may declare its props as a non-exported `interface` directly above it, or inline them; rule 4
  of "Inside a file" does not apply to props. Props take domain values (`game: GameSnapshot`); they never copy a domain
  type's fields.
- **Order.** A `.tsx` file may hold several components, in the order that reads best. A component two files use moves
  to its own file.
- **Placement.** `apps/web/src/ui/` holds reusable, sport-agnostic presentational components: rails, shelves, cards'
  frames, stat blocks, the page frame. It is the one folder named for a kind rather than a concept. `design/` stays
  shadcn only. Everything else is by concept, as elsewhere.
- **Expressions.** Rules 9–11 of "Inside a file" and the "One spelling per kind" table apply to Effect code. JSX,
  handlers and render logic are exempt: inline ternaries, maps and handlers are fine.
- **Tests.** Pure logic with rules keeps its tests beside it. Components and UI-only state need none. `TestWeb.ts` stays
  the one shared test module.
```

Nothing else in `AGENTS.md` changes. `ui` is not in the banned-names list (nor in `.dependency-cruiser.cjs`'s banned
path pattern), so no tool config changes.

- [ ] **Step 2: Check**

```bash
pnpm check
```

Expected: passes (the change is prose only).

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: the web app's own rules

AGENTS.md gains \"In the web app\", which loosens the general rules for
apps/web where they fought React: atoms only for state an outside input
writes or another view reads, React state for a component's own DOM
events, props as a non-exported interface above the component, several
components per .tsx file, apps/web/src/ui/ for sport-agnostic
presentational components, JSX and handlers exempt from the expression
rules, and no tests for components.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase 2 — TileKey

Tiles get an identity that is not only a `GameId`: `TileKey`, a branded string defined once in `packages/api` and
imported by the web and the desktop shell. A game's key is its `GameId` string itself, so the Screen's encoded form
(`localStorage` key `sportal/screen`, a Remote's report) and every IPC payload are byte-for-byte unchanged. No
behaviour changes; every existing assertion is kept, wrapped in `TileKey.game(…)` where a `GameId` value now meets a
`TileKey` (string literals such as `"live"` need no wrapping: a literal is assignable to a branded type's inference
candidate in `assert.strictEqual`, a `GameId` value is not).

This phase was dry-run on a copy of `ui-overhaul` at `a948d5b`: with exactly the changes below, `biome check .`,
`tsc --noEmit` (root and every workspace, with the `@effect/tsgo` diagnostics on), `depcruise`, `knip`,
`knip --production` and `vitest run` (52 files, 1014 tests) all pass.

**Rename summary (old → new), every one with no behaviour change:**

| Where | Old | New |
|---|---|---|
| `packages/api/src/ShellBridge.ts:20` | `TilePlacement.game: GameId` | `TilePlacement.key: TileKey` |
| `packages/api/src/ShellBridge.ts:43` | `setHidden(games: ReadonlyArray<GameId>)` | `setHidden(keys: ReadonlyArray<TileKey>)` |
| `packages/api/src/ShellBridge.ts:51` | `onTilePressed(listener: (game: GameId) => void)` | `onTilePressed(listener: (key: TileKey) => void)` |
| `apps/web/src/screen/Screen.ts:5` | `Tile = Schema.TaggedUnion({…})` | `Tile = Object.assign(Schema.TaggedUnion({…}), { key })`; `Tile.key(tile): TileKey \| undefined` (an occupied tile's overload returns `TileKey`) |
| `Screen.ts:51,53` | `audioFocus`, `solo`: `Option<GameId>` | `Option<TileKey>` (`Schema.OptionFromOptionalKey(TileKey)`) |
| `Screen.ts:89,94` | `hears(game: GameId)`, `soloes(game: GameId)` | `hears(key: TileKey)`, `soloes(key: TileKey)` |
| `Screen.ts:109` | `benched(): ReadonlyArray<{ tile; game: GameId }>` | `benched(): ReadonlyArray<{ tile; key: TileKey }>` |
| `Screen.ts:117` | `slotOf(game: GameId)` | `slotOf(key: TileKey)` |
| `Screen.ts:235–236` | `Unsettled.audioFocus`, `.solo`: `Option<GameId>` | `Option<TileKey>` |
| `Screen.ts:266` | `holds(tile, game: GameId)` | `holds(tile, key: TileKey)`: `Tile.key(tile) === key` |
| `Screen.ts:307` | `isOnScreen(game: GameId)` | `isOnScreen(key: TileKey)` |
| `apps/web/src/display/Display.ts:19` | `Display.interacting: GameId \| undefined` | `TileKey \| undefined` |
| `Display.ts:34` | `interactingOn(screen): GameId \| undefined` | `interactingOn(screen): TileKey \| undefined` |
| `Display.ts:144` | `DisplayInput.VideoPressed({ game: GameId })` | `DisplayInput.VideoPressed({ key: TileKey })` |
| `apps/web/src/screen/TileRects.ts:43` | `placements(…, interacting: GameId \| undefined)` | `interacting: TileKey \| undefined` |
| `TileRects.ts:62–65` | `coveredGames(overlays, videos: { game: GameId; bounds }[]): GameId[]` | `coveredTiles(overlays, videos: { key: TileKey; bounds }[]): TileKey[]` |
| `apps/web/src/screen/TilePlacements.ts:97` | private `gamesIn(screen)` | private `keysIn(screen)` |
| `apps/web/src/display/Covering.ts:38` | private `sameGames(a, b)` over `GameId` | private `sameKeys(a, b)` over `TileKey` |
| `apps/web/src/shell/Shell.ts:18` | `Shell.tilePressed: Stream<GameId>` | `Stream<TileKey>` |
| `Shell.ts:28` | `Shell.setHidden(games: ReadonlyArray<GameId>)` | `setHidden(keys: ReadonlyArray<TileKey>)` |
| `Shell.ts:94,104` | `layerTest({ tilePressed?: Stream<GameId> })`; record `{ _tag: "SetHidden"; games }` | `Stream<TileKey>`; `{ _tag: "SetHidden"; keys }` |
| `apps/desktop/src/main/TileViews.ts:26,33` | `hide(games: GameId[])`, `tilePresses: Stream<GameId>` | `hide(keys: TileKey[])`, `tilePresses: Stream<TileKey>` |
| `TileViews.ts:43–49,70,114,148` | `PubSub<GameId>`, `Map<GameId, Entry>`, `Set<GameId>`, `create(game: GameId)`, moves `{ game: GameId; … }` | `TileKey` throughout; moves `{ key: TileKey; … }` |
| `apps/desktop/src/main/main.ts:156` | `decodeGames = …Schema.Array(GameId)` | `decodeKeys = …Schema.Array(TileKey)` |

**Kept as `GameId` (deliberately):** `DisplayInput.Chosen({ game })` and `Display#choose(game)` (a game is chosen; the
key is derived inside), `ScreenCommand.Assign({ tile, game })` (it names a game to resolve into a tile through
`availabilityOf`, not an on-screen thing), `Screen.tileFor(game, …)`, `Screen#apply`'s and `Screen#refresh`'s
`availabilityOf(game)`, `StreamTile.game` / `DataTile.game`, the `ShellChannel` IPC names, and every `Games.game(…)`
lookup. No other `ScreenCommand` field names an on-screen thing (they are all slot indices), so `ScreenCommand` does not
change.

### Task 2 (phase 2, was task 2): `TileKey` in `packages/api`

**Files:**
- Create: `packages/api/src/TileKey.ts`
- Create: `packages/api/src/TileKey.test.ts`

**Interfaces:**
- Consumes: `GameId` (`@sportal/domain/Game`).
- Produces: `TileKey` (`export const TileKey = Object.assign(Schema.String.pipe(Schema.brand("TileKey")), { game })`,
  `export type TileKey = typeof TileKey.Type`), `TileKey.game(id: GameId): TileKey`. Later phases add `custom`,
  `stats`, `clip` to the same `Object.assign`.

- [ ] **Step 1: Write the failing test**

`packages/api/src/TileKey.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Schema } from "effect"
import { TileKey } from "./TileKey.ts"

describe("TileKey", () => {
  it("should send a key as its plain string", () => {
    const key = TileKey.game(GameId.make("401856707"))

    const wire = Schema.encodeSync(TileKey)(key)

    assert.strictEqual(wire, "401856707")
  })
})

describe("TileKey.game", () => {
  it("should key a game's tile by the game's id", () => {
    const key = TileKey.game(GameId.make("401856707"))

    assert.strictEqual(key, "401856707")
  })
})
```

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run packages/api/src/TileKey.test.ts
```

Expected: FAIL — the module `./TileKey.ts` does not exist.

- [ ] **Step 3: Write the module**

`packages/api/src/TileKey.ts` (the shape `GamesQuery.ts` and `Hotkey.ts` use: a wire value with its functions attached
by `Object.assign`, the helper hoisted below):

```ts
import type { GameId } from "@sportal/domain/Game"
import { Schema } from "effect"

/**
 * What a tile shows, as one string the Screen, the shell and a Remote all name it by: a game's stream or data tile is
 * the game's id itself. Audio focus, solo, the interacting tile and each provider view follow a tile's key, so what a
 * tile shows keeps them when it moves. With `game`, which builds a game's key.
 */
export const TileKey = Object.assign(Schema.String.pipe(Schema.brand("TileKey")), { game })
export type TileKey = typeof TileKey.Type

/** A game's tile: the game's id. */
function game(id: GameId): TileKey {
  return TileKey.make(id)
}
```

`Schema.brand` adds no runtime check, so `TileKey.make(id)` only brands (checked in `effect@4.0.0`'s
`dist/Schema.d.ts`: `brand<S, B>` keeps `"~type.make.in"` as `S["~type.make.in"]`, a plain `string`).

- [ ] **Step 4: Run it to see it pass**

```bash
pnpm vitest run packages/api/src/TileKey.test.ts
```

Expected: PASS, 2 tests.

### Task 3 (phase 2, was task 3): `Tile.key`, and the Screen keyed by `TileKey`

**Files:**
- Modify: `apps/web/src/screen/Screen.ts`
- Modify: `apps/web/src/screen/Screen.test.ts`

**Interfaces:**
- Consumes: `TileKey`, `TileKey.game` (Task 2).
- Produces: `Tile.key(tile: Occupied): TileKey` and `Tile.key(tile: Tile): TileKey | undefined` (overloads on a
  private hoisted `key`, attached with `Object.assign`; `Occupied` is the file's existing private
  `Exclude<Tile, { _tag: "Empty" }>`); `Screen.audioFocus: Option<TileKey>`, `Screen.solo: Option<TileKey>`,
  `Screen#hears(key: TileKey)`, `Screen#soloes(key: TileKey)`, `Screen#slotOf(key: TileKey)`,
  `Screen#benched(): ReadonlyArray<{ tile: number; key: TileKey }>`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/screen/Screen.test.ts`, add `import { TileKey } from "@sportal/api/TileKey"` as the second import
(after `@effect/vitest`), and insert this block directly above `describe("Screen#withSplit", () => {`:

```ts
describe("Tile.key", () => {
  it("should key a stream tile by its game", () => {
    const tile: Tile = { _tag: "StreamTile", game: TestWeb.bama, channel: TestWeb.foxChannel }

    const key = Tile.key(tile)

    assert.strictEqual(key, TileKey.game(TestWeb.bama))
  })

  it("should key a data tile by its game", () => {
    const tile: Tile = { _tag: "DataTile", game: TestWeb.bama, why: { _tag: "NoStream" } }

    const key = Tile.key(tile)

    assert.strictEqual(key, TileKey.game(TestWeb.bama))
  })

  it("should give an empty tile no key", () => {
    const key = Tile.key({ _tag: "Empty" })

    assert.isUndefined(key)
  })
})
```

`Tile` is already imported from `./Screen.ts` there; `TestWeb.foxChannel` already exists.

- [ ] **Step 2: Run them to see them fail**

```bash
pnpm vitest run apps/web/src/screen/Screen.test.ts -t "Tile.key"
```

Expected: FAIL — `Tile.key is not a function`.

- [ ] **Step 3: Key the Screen by `TileKey`**

Apply to `apps/web/src/screen/Screen.ts` (line numbers are the file at `a948d5b`). The private `key` goes right after
`interface Unsettled`, before `tileAt`: it is the first private helper used (by `Tile` itself). The `Solo` branch binds
`Tile.key(held)` once (rule 10). Comments on `apply`/`refresh` that say "game" stay: they describe games.

```diff
@@ -1,24 +1,29 @@
+import { TileKey } from "@sportal/api/TileKey"
 import { Channel, ChannelAvailability, SourceName } from "@sportal/domain/Channel"
 import { GameId } from "@sportal/domain/Game"
 import { Array as Arr, Option, Record as Rec, Result, Schema } from "effect"
 
-export const Tile = Schema.TaggedUnion({
-  Empty: {},
-  StreamTile: { game: GameId, channel: Channel },
-  /** No stream, and why: none on any source, streaming only, not in the guide, not on yet, or no guide to ask. */
-  DataTile: {
-    game: GameId,
-    why: Schema.TaggedUnion({
-      NoStream: {},
-      StreamingOnly: {},
-      NotInGuide: {},
-      NoGuide: { source: SourceName },
-      NotYet: {
-        channel: Schema.OptionFromOptionalKey(Schema.String),
-        begin: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString)
-      }
-    })
-  }
-})
+/** One slot's content: a game's stream, its data, or nothing. With `key`, what the tile shows as a `TileKey`. */
+export const Tile = Object.assign(
+  Schema.TaggedUnion({
+    Empty: {},
+    StreamTile: { game: GameId, channel: Channel },
+    /** No stream, and why: none on any source, streaming only, not in the guide, not on yet, or no guide to ask. */
+    DataTile: {
+      game: GameId,
+      why: Schema.TaggedUnion({
+        NoStream: {},
+        StreamingOnly: {},
+        NotInGuide: {},
+        NoGuide: { source: SourceName },
+        NotYet: {
+          channel: Schema.OptionFromOptionalKey(Schema.String),
+          begin: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString)
+        }
+      })
+    }
+  }),
+  { key }
+)
 export type Tile = typeof Tile.Type
 
@@ -48,8 +53,8 @@ export class Screen extends Schema.Class<Screen>("sportal/Screen")({
   /** Each layout's own split, kept while another layout is shown. */
   splits: Schema.Record(LayoutName, Split),
-  /** The game whose sound is on: always an on-screen game, or none when the screen is empty. */
-  audioFocus: Schema.OptionFromOptionalKey(GameId),
-  /** The game filling the Screen: always an on-screen game. */
-  solo: Schema.OptionFromOptionalKey(GameId)
+  /** The tile whose sound is on, by its key: always an on-screen tile, or none when the screen is empty. */
+  audioFocus: Schema.OptionFromOptionalKey(TileKey),
+  /** The tile filling the Screen, by its key: always an on-screen tile. */
+  solo: Schema.OptionFromOptionalKey(TileKey)
 }) {
   /** An empty Quad, every layout at its default split. */
@@ -86,12 +91,12 @@ export class Screen extends Schema.Class<Screen>("sportal/Screen")({
   }
 
-  /** Whether the game's sound is on. */
-  hears(game: GameId): boolean {
-    return Option.contains(this.audioFocus, game)
+  /** Whether the sound of the tile with this key is on. */
+  hears(key: TileKey): boolean {
+    return Option.contains(this.audioFocus, key)
   }
 
-  /** Whether the game fills the Screen. */
-  soloes(game: GameId): boolean {
-    return Option.contains(this.solo, game)
+  /** Whether the tile with this key fills the Screen. */
+  soloes(key: TileKey): boolean {
+    return Option.contains(this.solo, key)
   }
 
@@ -106,15 +111,15 @@ export class Screen extends Schema.Class<Screen>("sportal/Screen")({
   }
 
-  /** The games on the bench, in order, each with its tile. Empty tiles past the slots are skipped. */
-  benched(): ReadonlyArray<{ tile: number; game: GameId }> {
+  /** The keys on the bench, in order, each with its tile. Empty tiles past the slots are skipped. */
+  benched(): ReadonlyArray<{ tile: number; key: TileKey }> {
     const first = Screen.slotCount(this.layout)
     return this.tiles.flatMap((tile, index) =>
-      index < first || Tile.guards.Empty(tile) ? [] : [{ tile: index, game: tile.game }]
+      index < first || Tile.guards.Empty(tile) ? [] : [{ tile: index, key: Tile.key(tile) }]
     )
   }
 
-  /** The slot a game is in, if it is on screen. */
-  slotOf(game: GameId): number | undefined {
-    const slot = this.onScreen().findIndex((tile) => holds(tile, game))
+  /** The slot the tile with this key is in, if it is on screen. */
+  slotOf(key: TileKey): number | undefined {
+    const slot = this.onScreen().findIndex((tile) => holds(tile, key))
     return slot === -1 ? undefined : slot
   }
@@ -157,5 +162,5 @@ export class Screen extends Schema.Class<Screen>("sportal/Screen")({
           // A game appears in at most one tile, on screen or benched: assigning it elsewhere moves it.
           const tiles = this.tiles.map((existing, index) =>
-            index === tile ? assigned : holds(existing, game) ? empty : existing
+            index === tile ? assigned : holds(existing, TileKey.game(game)) ? empty : existing
           )
           return Result.succeed({ ...this, tiles })
@@ -168,14 +173,21 @@ export class Screen extends Schema.Class<Screen>("sportal/Screen")({
       Promote: ({ tile }) =>
         tileAt(this, tile, (found) =>
-          occupied(found, ({ game }) =>
-            Result.succeed({ ...this, tiles: swapped(this.tiles, 0, tile), audioFocus: Option.some(game) })
+          occupied(found, (held) =>
+            Result.succeed({
+              ...this,
+              tiles: swapped(this.tiles, 0, tile),
+              audioFocus: Option.some(Tile.key(held))
+            })
           )
         ),
       FocusAudio: ({ tile }) =>
-        onScreenAt(this, tile, ({ game }) => Result.succeed({ ...this, audioFocus: Option.some(game) })),
+        onScreenAt(this, tile, (held) =>
+          Result.succeed({ ...this, audioFocus: Option.some(Tile.key(held)) })
+        ),
       Solo: ({ tile }) =>
-        onScreenAt(this, tile, ({ game }) =>
-          Result.succeed({ ...this, audioFocus: Option.some(game), solo: Option.some(game) })
-        )
+        onScreenAt(this, tile, (held) => {
+          const key = Tile.key(held)
+          return Result.succeed({ ...this, audioFocus: Option.some(key), solo: Option.some(key) })
+        })
     })
     return Result.map(next, settle)
@@ -233,6 +245,13 @@ interface Unsettled {
   readonly layout: LayoutName
   readonly splits: Screen["splits"]
-  readonly audioFocus: Option.Option<GameId>
-  readonly solo: Option.Option<GameId>
+  readonly audioFocus: Option.Option<TileKey>
+  readonly solo: Option.Option<TileKey>
+}
+
+/** What `tile` shows, as a key: its game's id for a stream or data tile; none for an empty tile. */
+function key(tile: Occupied): TileKey
+function key(tile: Tile): TileKey | undefined
+function key(tile: Tile): TileKey | undefined {
+  return Tile.guards.Empty(tile) ? undefined : TileKey.game(tile.game)
 }
 
@@ -264,6 +283,6 @@ function occupied(
 }
 
-function holds(tile: Tile, game: GameId): boolean {
-  return !Tile.guards.Empty(tile) && tile.game === game
+function holds(tile: Tile, key: TileKey): boolean {
+  return Tile.key(tile) === key
 }
 
@@ -304,6 +323,6 @@ function settle(fields: Unsettled): Screen {
   )
   const tiles = Arr.makeBy(Math.max(slots, kept), (index) => fields.tiles[index] ?? empty)
-  const onScreen = tiles.slice(0, slots).flatMap((tile) => (Tile.guards.Empty(tile) ? [] : [tile.game]))
-  const isOnScreen = (game: GameId) => onScreen.includes(game)
+  const onScreen = tiles.slice(0, slots).flatMap((tile) => (Tile.guards.Empty(tile) ? [] : [Tile.key(tile)]))
+  const isOnScreen = (key: TileKey) => onScreen.includes(key)
   return new Screen({
     tiles,
```

- [ ] **Step 4: Keep every Screen assertion under `TileKey`**

Apply to `apps/web/src/screen/Screen.test.ts` (this diff also shows the import and the `Tile.key` block from Step 1).
Each change wraps the expected `GameId` in `TileKey.game(…)`; no assertion is added, dropped or loosened:

```diff
@@ -1,3 +1,4 @@
 import { assert, describe, it } from "@effect/vitest"
+import { TileKey } from "@sportal/api/TileKey"
 import type { ChannelAvailability } from "@sportal/domain/Channel"
 import { GameId } from "@sportal/domain/Game"
@@ -87,5 +88,5 @@ describe("Screen#apply", () => {
     const screen = TestWeb.assign(Screen.initial, 2, TestWeb.bama, TestWeb.onFox)
 
-    assert.deepStrictEqual(screen.audioFocus, Option.some(TestWeb.bama))
+    assert.deepStrictEqual(screen.audioFocus, Option.some(TileKey.game(TestWeb.bama)))
   })
 
@@ -95,5 +96,5 @@ describe("Screen#apply", () => {
     const focused = run(two, { _tag: "FocusAudio", tile: 1 })
 
-    assert.deepStrictEqual(focused.audioFocus, Option.some(TestWeb.irish))
+    assert.deepStrictEqual(focused.audioFocus, Option.some(TileKey.game(TestWeb.irish)))
   })
 
@@ -103,5 +104,5 @@ describe("Screen#apply", () => {
     const assigned = TestWeb.assign(focused, 2, usc, TestWeb.onFox)
 
-    assert.deepStrictEqual(assigned.audioFocus, Option.some(TestWeb.irish))
+    assert.deepStrictEqual(assigned.audioFocus, Option.some(TileKey.game(TestWeb.irish)))
   })
 
@@ -111,5 +112,5 @@ describe("Screen#apply", () => {
     const cleared = run(focused, { _tag: "Clear", tile: 1 })
 
-    assert.deepStrictEqual(cleared.audioFocus, Option.some(TestWeb.bama))
+    assert.deepStrictEqual(cleared.audioFocus, Option.some(TileKey.game(TestWeb.bama)))
   })
 
@@ -283,5 +284,5 @@ describe("Screen#refresh", () => {
     const refreshed = focused.refresh(some(TestWeb.onFox))
 
-    assert.deepStrictEqual(refreshed.audioFocus, Option.some(TestWeb.irish))
+    assert.deepStrictEqual(refreshed.audioFocus, Option.some(TileKey.game(TestWeb.irish)))
   })
 
@@ -454,5 +455,5 @@ describe("Screen layouts and the bench", () => {
     const single = run(focused, { _tag: "SetLayout", layout: "Single" })
 
-    assert.deepStrictEqual(single.audioFocus, Option.some(TestWeb.bama))
+    assert.deepStrictEqual(single.audioFocus, Option.some(TileKey.game(TestWeb.bama)))
   })
 
@@ -549,25 +550,49 @@ describe("Screen#hears and Screen#soloes", () => {
 
   it("should hear the on-air game", () => {
-    assert.isTrue(screen.hears(TestWeb.irish))
+    assert.isTrue(screen.hears(TileKey.game(TestWeb.irish)))
   })
 
   it("should not hear the soloed game when another is on air", () => {
-    assert.isFalse(screen.hears(TestWeb.bama))
+    assert.isFalse(screen.hears(TileKey.game(TestWeb.bama)))
   })
 
   it("should solo the soloed game", () => {
-    assert.isTrue(screen.soloes(TestWeb.bama))
+    assert.isTrue(screen.soloes(TileKey.game(TestWeb.bama)))
   })
 
   it("should not solo the game on air", () => {
-    assert.isFalse(screen.soloes(TestWeb.irish))
+    assert.isFalse(screen.soloes(TileKey.game(TestWeb.irish)))
   })
 
   it("should not hear a game in no tile", () => {
-    assert.isFalse(screen.hears(usc))
+    assert.isFalse(screen.hears(TileKey.game(usc)))
   })
 
   it("should not solo a game in no tile", () => {
-    assert.isFalse(screen.soloes(usc))
+    assert.isFalse(screen.soloes(TileKey.game(usc)))
+  })
+})
+
+describe("Tile.key", () => {
+  it("should key a stream tile by its game", () => {
+    const tile: Tile = { _tag: "StreamTile", game: TestWeb.bama, channel: TestWeb.foxChannel }
+
+    const key = Tile.key(tile)
+
+    assert.strictEqual(key, TileKey.game(TestWeb.bama))
+  })
+
+  it("should key a data tile by its game", () => {
+    const tile: Tile = { _tag: "DataTile", game: TestWeb.bama, why: { _tag: "NoStream" } }
+
+    const key = Tile.key(tile)
+
+    assert.strictEqual(key, TileKey.game(TestWeb.bama))
+  })
+
+  it("should give an empty tile no key", () => {
+    const key = Tile.key({ _tag: "Empty" })
+
+    assert.isUndefined(key)
   })
 })
@@ -602,6 +627,6 @@ describe("Screen#benched", () => {
 
     assert.deepStrictEqual(pair.benched(), [
-      { tile: 2, game: usc },
-      { tile: 3, game: ohio }
+      { tile: 2, key: TileKey.game(usc) },
+      { tile: 3, key: TileKey.game(ohio) }
     ])
   })
@@ -614,6 +639,6 @@ describe("Screen#benched", () => {
 
     assert.deepStrictEqual(single.benched(), [
-      { tile: 1, game: TestWeb.irish },
-      { tile: 3, game: ohio }
+      { tile: 1, key: TileKey.game(TestWeb.irish) },
+      { tile: 3, key: TileKey.game(ohio) }
     ])
   })
@@ -674,5 +699,5 @@ describe("Screen swap and promote", () => {
     const swapped = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "Swap", a: 0, b: 1 })
 
-    assert.deepStrictEqual(swapped.audioFocus, Option.some(TestWeb.bama))
+    assert.deepStrictEqual(swapped.audioFocus, Option.some(TileKey.game(TestWeb.bama)))
   })
 
@@ -683,5 +708,5 @@ describe("Screen swap and promote", () => {
 
     assert.deepStrictEqual(promoted.tiles.map(gameOf), [TestWeb.irish, undefined, undefined, TestWeb.bama])
-    assert.deepStrictEqual(promoted.audioFocus, Option.some(TestWeb.irish))
+    assert.deepStrictEqual(promoted.audioFocus, Option.some(TileKey.game(TestWeb.irish)))
   })
 
@@ -705,6 +730,6 @@ describe("Screen solo", () => {
     const solo = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "Solo", tile: 1 })
 
-    assert.deepStrictEqual(solo.solo, Option.some(TestWeb.irish))
-    assert.deepStrictEqual(solo.audioFocus, Option.some(TestWeb.irish))
+    assert.deepStrictEqual(solo.solo, Option.some(TileKey.game(TestWeb.irish)))
+    assert.deepStrictEqual(solo.audioFocus, Option.some(TileKey.game(TestWeb.irish)))
   })
 
@@ -714,5 +739,5 @@ describe("Screen solo", () => {
     const swapped = run(solo, { _tag: "Swap", a: 0, b: 1 })
 
-    assert.deepStrictEqual(swapped.solo, Option.some(TestWeb.irish))
+    assert.deepStrictEqual(swapped.solo, Option.some(TileKey.game(TestWeb.irish)))
   })
 
```

Unchanged on purpose: `reportingOnly(game: GameId)` and every `refresh`/`apply` call (availability is still asked by
game), `gameOf` (reads `tile.game`), the `tiles` and `commands` wire tables under `describe("Tile")` and
`describe("ScreenCommand")` (they prove the encoded form is unchanged).

- [ ] **Step 5: Run the Screen tests**

```bash
pnpm vitest run apps/web/src/screen/Screen.test.ts
```

Expected: PASS (every existing test plus the 3 `Tile.key` tests).

### Task 4 (phase 2, was task 4): The Display fold and the views that read the Screen

**Files:**
- Modify: `apps/web/src/display/Display.ts`, `apps/web/src/display/Display.test.ts`
- Modify: `apps/web/src/display/DisplayState.ts`, `apps/web/src/display/DisplayState.test.ts`
- Modify: `apps/web/src/screen/TileAction.ts`, `apps/web/src/screen/TileAction.test.ts`
- Modify: `apps/web/src/screen/TileChrome.tsx`, `apps/web/src/screen/ScreenView.tsx`
- Modify: `apps/web/src/remote/ScreenMap.tsx`, `apps/web/src/remote/RemoteView.tsx`

**Interfaces:**
- Consumes: `Tile.key`, `Screen#slotOf/hears/soloes/benched` (Task 3), `TileKey.game` (Task 2).
- Produces: `Display.interacting: TileKey | undefined`, `Display#interactingOn(screen): TileKey | undefined`,
  `DisplayInput.VideoPressed({ key: TileKey })`. `DisplayInput.Chosen({ game: GameId })` and
  `Display#choose(game: GameId, screen)` are unchanged.

- [ ] **Step 1: `Display.ts`**

```diff
@@ -1,3 +1,4 @@
 import { Hotkey } from "@sportal/api/Hotkey"
+import { TileKey } from "@sportal/api/TileKey"
 import type { GameId } from "@sportal/domain/Game"
 import { Data, Option } from "effect"
@@ -17,5 +18,5 @@ export class Display extends Data.Class<{
   readonly selected: number
   /** Read it through `interactingOn`. */
-  readonly interacting: GameId | undefined
+  readonly interacting: TileKey | undefined
   readonly overlay: Overlay
 }> {
@@ -29,10 +30,10 @@ export class Display extends Data.Class<{
 
   /**
-   * The interacting game, while the selected slot still holds its stream; otherwise none. It returns when its game is
-   * back in the selected slot.
+   * The interacting tile's key, while the selected slot still holds its stream; otherwise none. It returns when that
+   * tile is back in the selected slot.
    */
-  interactingOn(screen: Screen): GameId | undefined {
+  interactingOn(screen: Screen): TileKey | undefined {
     const tile = screen.onScreen()[this.selectedOn(screen)]
-    return Tile.guards.StreamTile(tile) && tile.game === this.interacting ? this.interacting : undefined
+    return Tile.guards.StreamTile(tile) && Tile.key(tile) === this.interacting ? this.interacting : undefined
   }
 
@@ -42,6 +43,6 @@ export class Display extends Data.Class<{
       Pressed: ({ hotkey }) => this.press(hotkey, screen),
       Selected: ({ slot }) => this.select(slot, screen),
-      VideoPressed: ({ game }) => {
-        const slot = screen.slotOf(game)
+      VideoPressed: ({ key }) => {
+        const slot = screen.slotOf(key)
         return slot === undefined ? DisplayStep.of(this) : this.select(slot, screen)
       },
@@ -74,5 +75,5 @@ export class Display extends Data.Class<{
         const tile = screen.onScreen()[this.selectedOn(screen)]
         if (!Tile.guards.StreamTile(tile)) return DisplayStep.of(this)
-        const interacting = this.interactingOn(screen) === undefined ? tile.game : undefined
+        const interacting = this.interactingOn(screen) === undefined ? Tile.key(tile) : undefined
         return DisplayStep.of(new Display({ ...this, interacting }))
       },
@@ -100,7 +101,8 @@ export class Display extends Data.Class<{
    */
   choose(game: GameId, screen: Screen): DisplayStep {
-    if (screen.slotOf(game) !== undefined) return DisplayStep.of(this)
+    const key = TileKey.game(game)
+    if (screen.slotOf(key) !== undefined) return DisplayStep.of(this)
     const slot = this.selectedOn(screen)
-    const bench = screen.benched().find((each) => each.game === game)
+    const bench = screen.benched().find((each) => each.key === key)
     const { display, commands } = this.select(screen.nextEmptySlot(slot) ?? slot, screen)
     const placed: ScreenCommand =
@@ -142,5 +144,5 @@ export type DisplayInput = Data.TaggedEnum<{
   Pressed: { readonly hotkey: Hotkey }
   Selected: { readonly slot: number }
-  VideoPressed: { readonly game: GameId }
+  VideoPressed: { readonly key: TileKey }
   Chosen: { readonly game: GameId }
   Commanded: { readonly command: ScreenCommand }
```

- [ ] **Step 2: `DisplayState.ts`** (the shell's presses arrive as keys)

```diff
@@ -53,6 +53,6 @@ export const inputs = runtime.atom((get) =>
     const shell = yield* Shell
     const keys = Stream.runForEach(shell.hotkeys, (hotkey) => Effect.sync(() => get.set(pressed, hotkey)))
-    const videos = Stream.runForEach(shell.tilePressed, (game) =>
-      Effect.sync(() => get.set(display, DisplayInput.VideoPressed({ game })))
+    const videos = Stream.runForEach(shell.tilePressed, (key) =>
+      Effect.sync(() => get.set(display, DisplayInput.VideoPressed({ key })))
     )
 
```

- [ ] **Step 3: The views**

`TileAction.ts` (lines 25 and 40; `tile` is already narrowed past `Empty`, so `Tile.key` returns `TileKey`):

```diff
@@ -23,5 +23,5 @@ export class TileAction extends Data.Class<{
     if (tile === undefined || Tile.guards.Empty(tile)) return []
 
-    const hearLabel = screen.hears(tile.game) ? "Sound on" : "Hear this game"
+    const hearLabel = screen.hears(Tile.key(tile)) ? "Sound on" : "Hear this game"
     const hear = new TileAction({
       id: "hear",
@@ -38,5 +38,5 @@ export class TileAction extends Data.Class<{
       key: `Shift+${slot + 1}`
     })
-    const solo = screen.soloes(tile.game)
+    const solo = screen.soloes(Tile.key(tile))
       ? new TileAction({
           id: "unsolo",
```

`TileChrome.tsx` (line 28):

```diff
@@ -26,5 +26,5 @@ export function TileChrome(props: {
   const input = useAtomSet(DisplayState.display)
   const { tile, slot } = props
-  const onAir = !Tile.guards.Empty(tile) && props.screen.hears(tile.game)
+  const onAir = !Tile.guards.Empty(tile) && props.screen.hears(Tile.key(tile))
 
   return (
```

`ScreenView.tsx` (line 36: the section's React key is the tile's key, else its slot):

```diff
@@ -34,5 +34,5 @@ export function ScreenView() {
         return (
           <section
-            key={Tile.guards.Empty(tile) ? `slot-${index}` : tile.game}
+            key={Tile.key(tile) ?? `slot-${index}`}
             aria-hidden={hidden}
             className={`absolute flex flex-col overflow-hidden rounded-sm border ${
```

`ScreenMap.tsx` (lines 54–55; `gameIn` on line 29 still matches `snapshot.id === at.game` and stays):

```diff
@@ -52,6 +52,6 @@ export function ScreenMap(props: {
             const at = tiles[index]
             const game = gameIn(index)
-            const onAir = at !== undefined && !Tile.guards.Empty(at) && props.screen.hears(at.game)
-            const soloed = at !== undefined && !Tile.guards.Empty(at) && props.screen.soloes(at.game)
+            const onAir = at !== undefined && !Tile.guards.Empty(at) && props.screen.hears(Tile.key(at))
+            const soloed = at !== undefined && !Tile.guards.Empty(at) && props.screen.soloes(Tile.key(at))
 
             return (
```

`RemoteView.tsx` (line 134; `onChoose(game: GameId)` on line 103 stays):

```diff
@@ -2,4 +2,5 @@ import { useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react"
 import type { DisplayId } from "@sportal/api/DisplayId"
 import type { ListedGame } from "@sportal/api/ListedGame"
+import { TileKey } from "@sportal/api/TileKey"
 import type { GameId, Progress } from "@sportal/domain/Game"
 import { Array as Arr, Option } from "effect"
@@ -132,5 +133,5 @@ function GameTabs(props: {
           .filter(({ snapshot }) => sections[snapshot.progress()] === open)
           .map(({ snapshot }) => {
-            const slot = screen.slotOf(snapshot.id)
+            const slot = screen.slotOf(TileKey.game(snapshot.id))
             return (
               <li key={snapshot.id}>
```

`CommandPalette.tsx` needs no change: it reads `tile.game` to name a tile and `Option.isSome(screen.solo)`.

- [ ] **Step 4: Keep the Display and TileAction assertions under `TileKey`**

`Display.test.ts` (lines 228, 246, 265, 287 build a soloed Screen; 450, 462 build `VideoPressed`). Assertions such as
`assert.strictEqual(display.interactingOn(screen), "live")` stay as written. The `Assign` expectations on lines 88 and
137 keep `game: GameId.make("live")`, since `Assign` is unchanged:

```diff
@@ -1,3 +1,4 @@
 import { assert, describe, it } from "@effect/vitest"
+import { TileKey } from "@sportal/api/TileKey"
 import { GameId } from "@sportal/domain/Game"
 import { Option } from "effect"
@@ -226,5 +227,5 @@ describe("Display#press", () => {
     const screen = TestWeb.withTiles(["live", "soon"])
     const selected = Display.initial.select(1, screen).display
-    const soloed = new Screen({ ...screen, solo: Option.some(GameId.make("soon")) })
+    const soloed = new Screen({ ...screen, solo: Option.some(TileKey.game(GameId.make("soon"))) })
 
     const { commands } = selected.press({ _tag: "ToggleSolo" }, soloed)
@@ -244,5 +245,8 @@ describe("Display#press", () => {
 
   it("should unsolo with ToggleSolo on an Empty tile while soloed", () => {
-    const soloed = new Screen({ ...TestWeb.withTiles(["live"]), solo: Option.some(GameId.make("live")) })
+    const soloed = new Screen({
+      ...TestWeb.withTiles(["live"]),
+      solo: Option.some(TileKey.game(GameId.make("live")))
+    })
     const selected = Display.initial.select(1, soloed).display
 
@@ -263,5 +267,8 @@ describe("Display#press", () => {
 
   it("should close the key help with Esc and send no Unsolo, even while soloed", () => {
-    const soloed = new Screen({ ...TestWeb.withTiles(["live"]), solo: Option.some(GameId.make("live")) })
+    const soloed = new Screen({
+      ...TestWeb.withTiles(["live"]),
+      solo: Option.some(TileKey.game(GameId.make("live")))
+    })
     const keys = Display.initial.open("Keys")
 
@@ -285,5 +292,8 @@ describe("Display#press", () => {
 
   it("should unsolo with Esc and no overlay while soloed", () => {
-    const soloed = new Screen({ ...TestWeb.withTiles(["live"]), solo: Option.some(GameId.make("live")) })
+    const soloed = new Screen({
+      ...TestWeb.withTiles(["live"]),
+      solo: Option.some(TileKey.game(GameId.make("live")))
+    })
 
     const { display, commands } = Display.initial.press({ _tag: "Unsolo" }, soloed)
@@ -448,5 +458,5 @@ describe("Display#apply", () => {
 
     const { display, commands } = Display.initial.apply(
-      DisplayInput.VideoPressed({ game: GameId.make("soon") }),
+      DisplayInput.VideoPressed({ key: TileKey.game(GameId.make("soon")) }),
       screen
     )
@@ -460,5 +470,5 @@ describe("Display#apply", () => {
 
     const { display } = Display.initial.apply(
-      DisplayInput.VideoPressed({ game: GameId.make("gone") }),
+      DisplayInput.VideoPressed({ key: TileKey.game(GameId.make("gone")) }),
       screen
     )
```

`DisplayState.test.ts` (line 104):

```diff
@@ -1,3 +1,4 @@
 import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
+import { TileKey } from "@sportal/api/TileKey"
 import { GameId } from "@sportal/domain/Game"
 import { Effect, Queue, Stream } from "effect"
@@ -102,5 +103,7 @@ describe("DisplayState", () => {
     Effect.gen(function* () {
       yield* TestWeb.keep(TestWeb.withTiles(["live", "soon"]))
-      const { registry } = yield* TestWeb.withShell({ tilePressed: Stream.make(GameId.make("soon")) })
+      const { registry } = yield* TestWeb.withShell({
+        tilePressed: Stream.make(TileKey.game(GameId.make("soon")))
+      })
 
       const display = yield* Effect.gen(function* () {
```

`TileAction.test.ts` (line 72):

```diff
@@ -1,3 +1,4 @@
 import { assert, describe, it } from "@effect/vitest"
+import { TileKey } from "@sportal/api/TileKey"
 import type { GameId } from "@sportal/domain/Game"
 import * as TestWeb from "../TestWeb.ts"
@@ -70,5 +71,5 @@ describe("TileAction.of", () => {
   it("should word hear by whether the tile's sound is already on", () => {
     const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])
-    const wording = (game: GameId) => (screen.hears(game) ? "Sound on" : "Hear this game")
+    const wording = (game: GameId) => (screen.hears(TileKey.game(game)) ? "Sound on" : "Hear this game")
 
     const labels = [actionOf(screen, 0, true, "hear")?.label, actionOf(screen, 1, true, "hear")?.label]
```

`RemoteState.test.ts` needs no change: it sends `Chosen({ game })` and asserts the encoded `Assign`.

- [ ] **Step 5: Run them**

```bash
pnpm vitest run apps/web/src/display/Display.test.ts apps/web/src/display/DisplayState.test.ts apps/web/src/screen/TileAction.test.ts apps/web/src/remote/RemoteState.test.ts
```

Expected: PASS. (Typecheck is green only once Task 6 is done: `Shell.tilePressed` is still a `GameId` stream until
Task 5. Vitest does not typecheck, and a game's key is its id, so the run passes now.)

### Task 5 (phase 2, was task 5): The shell bridge, the Shell, placements and covering

**Files:**
- Modify: `packages/api/src/ShellBridge.ts`
- Modify: `apps/web/src/shell/Shell.ts`
- Modify: `apps/web/src/screen/TileRects.ts`, `apps/web/src/screen/TileRects.test.ts`
- Modify: `apps/web/src/screen/TilePlacements.ts`, `apps/web/src/screen/TilePlacements.test.ts`
- Modify: `apps/web/src/display/Covering.ts`, `apps/web/src/display/Covering.test.ts`

**Interfaces:**
- Consumes: `TileKey` (Task 2), `Tile.key`, `Screen#hears/slotOf` (Task 3), `Display#interactingOn` (Task 4).
- Produces: `TilePlacement = Schema.Struct({ key: TileKey, url, bounds, muted, interactive })`;
  `ShellBridge.setHidden(keys: ReadonlyArray<TileKey>): void`;
  `ShellBridge.onTilePressed(listener: (key: TileKey) => void): () => void`;
  `Shell.tilePressed: Stream<TileKey>`; `Shell.setHidden: (keys: ReadonlyArray<TileKey>) => Effect<void>`;
  `Shell.layerTest({ tilePressed?: Stream<TileKey>, record })` recording `{ _tag: "SetHidden"; keys }`;
  `TileRects.placements(screen, rects, origin, interacting: TileKey | undefined)`;
  `TileRects.coveredTiles(overlays, videos: ReadonlyArray<{ key: TileKey; bounds: TileBounds }>): ReadonlyArray<TileKey>`.

- [ ] **Step 1: `ShellBridge.ts`** (`TileKey` is imported as a value: the struct reads it)

```diff
@@ -1,5 +1,5 @@
-import { GameId } from "@sportal/domain/Game"
 import { Schema } from "effect"
 import type { Hotkey } from "./Hotkey.ts"
+import { TileKey } from "./TileKey.ts"
 
 /** A rectangle in the web UI's window, in whole CSS pixels. */
@@ -13,10 +13,10 @@ export type TileBounds = typeof TileBounds.Type
 
 /**
- * Where a game's provider view sits in the Display's window, in CSS pixels, and what it loads.
+ * Where a tile's provider view sits in the Display's window, in CSS pixels, and what it loads.
  * An `interactive` stream's player gets the mouse; every other stream's player never sees it.
- * A view belongs to its game, so a game that changes tiles keeps its player.
+ * A view belongs to its tile's key, so a game that changes tiles keeps its player.
  */
 export const TilePlacement = Schema.Struct({
-  game: GameId,
+  key: TileKey,
   url: Schema.String,
   bounds: TileBounds,
@@ -40,6 +40,6 @@ export interface ShellBridge {
    */
   syncTiles(placements: ReadonlyArray<TilePlacement>, transition?: ScreenTransition): void
-  /** Hides exactly these games' views, without unloading or muting them, and shows the rest. */
-  setHidden(games: ReadonlyArray<GameId>): void
+  /** Hides exactly these tiles' views, without unloading or muting them, and shows the rest. */
+  setHidden(keys: ReadonlyArray<TileKey>): void
   /** Puts the shell window in or out of full screen. */
   setFullScreen(on: boolean): void
@@ -48,6 +48,6 @@ export interface ShellBridge {
   /** Calls `listener` for each hotkey pressed while a stream view had keyboard focus. Returns a function that stops the calls. */
   onHotkey(listener: (hotkey: Hotkey) => void): () => void
-  /** Calls `listener` with the game whose stream view was clicked while it was not interactive. Returns a function that stops the calls. */
-  onTilePressed(listener: (game: GameId) => void): () => void
+  /** Calls `listener` with the key of the tile whose stream view was clicked while it was not interactive. Returns a function that stops the calls. */
+  onTilePressed(listener: (key: TileKey) => void): () => void
   /** Opens the sign-in window for YouTube TV, or focuses it if open. Its sign-in is shared by every tile. */
   openSignIn(): void
```

- [ ] **Step 2: `Shell.ts`**

```diff
@@ -1,5 +1,5 @@
 import { Hotkey } from "@sportal/api/Hotkey"
 import type { ScreenTransition, ShellBridge, TilePlacement } from "@sportal/api/ShellBridge"
-import type { GameId } from "@sportal/domain/Game"
+import type { TileKey } from "@sportal/api/TileKey"
 import { Context, Effect, Layer, Option, Queue, Stream } from "effect"
 
@@ -15,6 +15,6 @@ export class Shell extends Context.Service<
     /** Whether the window is full screen, each time it changes. */
     readonly fullScreen: Stream.Stream<boolean>
-    /** The game whose video was clicked while it was not interactive. */
-    readonly tilePressed: Stream.Stream<GameId>
+    /** The key of the tile whose video was clicked while it was not interactive. */
+    readonly tilePressed: Stream.Stream<TileKey>
     /** Each guide the shell reads from the source, unchanged. */
     readonly guideRead: Stream.Stream<string>
@@ -25,6 +25,6 @@ export class Shell extends Context.Service<
       transition: Option.Option<ScreenTransition>
     ) => Effect.Effect<void>
-    /** Hides exactly these games' videos and shows the rest. */
-    readonly setHidden: (games: ReadonlyArray<GameId>) => Effect.Effect<void>
+    /** Hides exactly these tiles' videos and shows the rest. */
+    readonly setHidden: (keys: ReadonlyArray<TileKey>) => Effect.Effect<void>
     /** Asks the shell to read the guide now. */
     readonly readGuide: Effect.Effect<void>
@@ -55,5 +55,5 @@ export class Shell extends Context.Service<
         syncTiles: (placements, transition) =>
           Effect.sync(() => bridge.syncTiles(placements, Option.getOrUndefined(transition))),
-        setHidden: (games) => Effect.sync(() => bridge.setHidden(games)),
+        setHidden: (keys) => Effect.sync(() => bridge.setHidden(keys)),
         readGuide: Effect.sync(() => bridge.readGuide()),
         openSignIn: Option.some(Effect.sync(() => bridge.openSignIn()))
@@ -92,5 +92,5 @@ export class Shell extends Context.Service<
     readonly hotkeys?: Stream.Stream<Hotkey>
     readonly fullScreen?: Stream.Stream<boolean>
-    readonly tilePressed?: Stream.Stream<GameId>
+    readonly tilePressed?: Stream.Stream<TileKey>
     readonly guideRead?: Stream.Stream<string>
     readonly record: (
@@ -102,5 +102,5 @@ export class Shell extends Context.Service<
             readonly transition: Option.Option<ScreenTransition>
           }
-        | { readonly _tag: "SetHidden"; readonly games: ReadonlyArray<GameId> }
+        | { readonly _tag: "SetHidden"; readonly keys: ReadonlyArray<TileKey> }
         | { readonly _tag: "ReadGuide" }
         | { readonly _tag: "OpenSignIn" }
@@ -117,5 +117,5 @@ export class Shell extends Context.Service<
         setFullScreen: (on) => record({ _tag: "SetFullScreen", on }),
         syncTiles: (placements, transition) => record({ _tag: "SyncTiles", placements, transition }),
-        setHidden: (games) => record({ _tag: "SetHidden", games }),
+        setHidden: (keys) => record({ _tag: "SetHidden", keys }),
         readGuide: record({ _tag: "ReadGuide" }),
         openSignIn: Option.some(record({ _tag: "OpenSignIn" }))
```

- [ ] **Step 3: `TileRects.ts`** (`Tile.key(tile)` is bound once after the `StreamTile` guard, so it is a `TileKey`)

```diff
@@ -1,4 +1,4 @@
 import type { TileBounds, TilePlacement } from "@sportal/api/ShellBridge"
-import type { GameId } from "@sportal/domain/Game"
+import type { TileKey } from "@sportal/api/TileKey"
 import { Option } from "effect"
 import { Layout } from "../layout/Layout.ts"
@@ -7,5 +7,5 @@ import { type Screen, Tile } from "./Screen.ts"
 /**
  * Each on-screen tile's rectangle in the Screen area, in whole pixels, main tile first. Slot edges are rounded
- * once, so neighbours share an edge and every gap is the same width. A soloed game gets the whole area; the
+ * once, so neighbours share an edge and every gap is the same width. A soloed tile gets the whole area; the
  * other tiles keep their place with no size, so they can grow back from it.
  */
@@ -15,5 +15,5 @@ export function tileRects(
 ): ReadonlyArray<TileBounds> {
   const whole = inset({ x: 0, y: 0, width: area.width, height: area.height })
-  const solo = Option.getOrUndefined(Option.map(screen.solo, (game) => screen.slotOf(game)))
+  const solo = Option.getOrUndefined(Option.map(screen.solo, (key) => screen.slotOf(key)))
 
   return Layout.of(screen)
@@ -34,5 +34,5 @@ export function tileRects(
 
 /**
- * What the shell must show for each stream tile with a size: its game's view, in window pixels.
+ * What the shell must show for each stream tile with a size: its view, by the tile's key, in window pixels.
  * `origin` is where the Screen area sits in the window. Only `interacting`'s stream gets the mouse.
  */
@@ -41,30 +41,31 @@ export function placements(
   rects: ReadonlyArray<TileBounds>,
   origin: { x: number; y: number },
-  interacting: GameId | undefined
+  interacting: TileKey | undefined
 ): Array<TilePlacement> {
   return screen.onScreen().flatMap((tile, index) => {
     const rect = rects[index]
     if (rect === undefined || rect.width === 0 || !Tile.guards.StreamTile(tile)) return []
+    const key = Tile.key(tile)
     const view = {
       url: tile.channel.locator.url,
-      muted: !screen.hears(tile.game),
-      interactive: tile.game === interacting
+      muted: !screen.hears(key),
+      interactive: key === interacting
     }
     const video = videoBounds(rect)
-    return [{ game: tile.game, ...view, bounds: { ...video, x: video.x + origin.x, y: video.y + origin.y } }]
+    return [{ key, ...view, bounds: { ...video, x: video.x + origin.x, y: video.y + origin.y } }]
   })
 }
 
 /**
- * The games whose video an open overlay covers, in the order of `videos`: those sharing any area with an
+ * The keys of the tiles whose video an open overlay covers, in the order of `videos`: those sharing any area with an
  * overlay. An overlay flush against a video, touching only its edge, leaves it shown.
  */
-export function coveredGames(
+export function coveredTiles(
   overlays: ReadonlyArray<TileBounds>,
-  videos: ReadonlyArray<{ game: GameId; bounds: TileBounds }>
-): ReadonlyArray<GameId> {
+  videos: ReadonlyArray<{ key: TileKey; bounds: TileBounds }>
+): ReadonlyArray<TileKey> {
   return videos
     .filter((video) => overlays.some((overlay) => overlaps(overlay, video.bounds)))
-    .map((video) => video.game)
+    .map((video) => video.key)
 }
 
```

- [ ] **Step 4: `TilePlacements.ts`** (`sameArrangement` compares the tile key in each slot; `Tile.key` of an empty tile is
  `undefined`, as `gamesIn` gave before)

```diff
@@ -79,10 +79,10 @@ const pending = Atom.make((get) => ({
 const samePlacements = Schema.toEquivalence(Schema.Array(TilePlacement))
 
-/** Whether two Screens put tiles in the same places: the layout, its split, solo, and the game in each slot. */
+/** Whether two Screens put tiles in the same places: the layout, its split, solo, and the tile key in each slot. */
 function sameArrangement(a: Screen, b: Screen): boolean {
   const split = a.splits[a.layout]
   const other = b.splits[b.layout]
-  const games = gamesIn(a)
-  const others = gamesIn(b)
+  const keys = keysIn(a)
+  const others = keysIn(b)
   return (
     a.layout === b.layout &&
@@ -90,10 +90,10 @@ function sameArrangement(a: Screen, b: Screen): boolean {
     split.y === other.y &&
     Option.getOrUndefined(a.solo) === Option.getOrUndefined(b.solo) &&
-    games.length === others.length &&
-    games.every((game, slot) => game === others[slot])
+    keys.length === others.length &&
+    keys.every((key, slot) => key === others[slot])
   )
 }
 
-function gamesIn(screen: Screen) {
-  return screen.onScreen().map((tile) => (Tile.guards.Empty(tile) ? undefined : tile.game))
+function keysIn(screen: Screen) {
+  return screen.onScreen().map((tile) => Tile.key(tile))
 }
```

- [ ] **Step 5: `Covering.ts`**

```diff
@@ -1,4 +1,4 @@
 import type { TileBounds } from "@sportal/api/ShellBridge"
-import type { GameId } from "@sportal/domain/Game"
+import type { TileKey } from "@sportal/api/TileKey"
 import { Effect, Stream } from "effect"
 import { Atom } from "effect/reactivity"
@@ -24,6 +24,6 @@ export const sync = runtime.atom((get) =>
     yield* get.stream(hidden).pipe(
       Stream.mapAccum(
-        (): ReadonlyArray<GameId> => [],
-        (last, next) => (sameGames(last, next) ? [last, []] : [next, [next]])
+        (): ReadonlyArray<TileKey> => [],
+        (last, next) => (sameKeys(last, next) ? [last, []] : [next, [next]])
       ),
       Stream.runForEach(shell.setHidden)
@@ -33,8 +33,8 @@ export const sync = runtime.atom((get) =>
 
 const hidden = Atom.make((get) =>
-  TileRects.coveredGames([...get(overlays).values()], get(TilePlacements.placements))
+  TileRects.coveredTiles([...get(overlays).values()], get(TilePlacements.placements))
 )
 
-function sameGames(a: ReadonlyArray<GameId>, b: ReadonlyArray<GameId>): boolean {
-  return a.length === b.length && a.every((game, index) => game === b[index])
+function sameKeys(a: ReadonlyArray<TileKey>, b: ReadonlyArray<TileKey>): boolean {
+  return a.length === b.length && a.every((key, index) => key === b[index])
 }
```

- [ ] **Step 6: Keep the placement and covering assertions under `TileKey`**

`TileRects.test.ts` (the `describe` follows the function's new name; `videoOf`/`belowOf` still take a `GameId` and
key it):

```diff
@@ -1,3 +1,4 @@
 import { assert, describe, it } from "@effect/vitest"
+import { TileKey } from "@sportal/api/TileKey"
 import type { GameId } from "@sportal/domain/Game"
 import { Result } from "effect"
@@ -42,5 +43,5 @@ describe("placements", () => {
 
     assert.deepStrictEqual(placement?.bounds, { x: 355, y: 79, width: 794, height: 416 })
-    assert.strictEqual(placement?.game, TestWeb.bama)
+    assert.strictEqual(placement?.key, TileKey.game(TestWeb.bama))
     assert.isFalse(placement?.muted)
   })
@@ -57,5 +58,5 @@ describe("placements", () => {
     const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])
 
-    const interactive = placed(screen, TestWeb.irish).map((placement) => placement.interactive)
+    const interactive = placed(screen, TileKey.game(TestWeb.irish)).map((placement) => placement.interactive)
 
     assert.deepStrictEqual(interactive, [false, true])
@@ -73,11 +74,11 @@ describe("placements", () => {
     const screen = TestWeb.soloed([TestWeb.bama, TestWeb.irish], 1)
 
-    const games = placed(screen).map((placement) => placement.game)
+    const keys = placed(screen).map((placement) => placement.key)
 
-    assert.deepStrictEqual(games, [TestWeb.irish])
+    assert.deepStrictEqual(keys, [TileKey.game(TestWeb.irish)])
   })
 })
 
-describe("coveredGames", () => {
+describe("coveredTiles", () => {
   it.each([
     { overlay: { x: 250, y: 150, width: 200, height: 200 }, shares: "a corner" },
@@ -86,7 +87,7 @@ describe("coveredGames", () => {
     const video = videoOf(TestWeb.bama)
 
-    const covered = TileRects.coveredGames([overlay], [video])
+    const covered = TileRects.coveredTiles([overlay], [video])
 
-    assert.deepStrictEqual(covered, [TestWeb.bama])
+    assert.deepStrictEqual(covered, [TileKey.game(TestWeb.bama)])
   })
 
@@ -97,5 +98,5 @@ describe("coveredGames", () => {
     const video = videoOf(TestWeb.bama)
 
-    const covered = TileRects.coveredGames([overlay], [video])
+    const covered = TileRects.coveredTiles([overlay], [video])
 
     assert.deepStrictEqual(covered, [])
@@ -105,5 +106,5 @@ describe("coveredGames", () => {
     const videos = [videoOf(TestWeb.bama), belowOf(TestWeb.irish)]
 
-    const covered = TileRects.coveredGames([sheet()], videos)
+    const covered = TileRects.coveredTiles([sheet()], videos)
 
     assert.deepStrictEqual(covered, [])
@@ -113,7 +114,7 @@ describe("coveredGames", () => {
     const videos = [videoOf(TestWeb.bama), belowOf(TestWeb.irish)]
 
-    const covered = TileRects.coveredGames([{ ...sheet(), height: 301 }], videos)
+    const covered = TileRects.coveredTiles([{ ...sheet(), height: 301 }], videos)
 
-    assert.deepStrictEqual(covered, [TestWeb.bama, TestWeb.irish])
+    assert.deepStrictEqual(covered, [TileKey.game(TestWeb.bama), TileKey.game(TestWeb.irish)])
   })
 })
@@ -122,5 +123,5 @@ const area = { width: 1600, height: 900 }
 
 /** The placements of `screen`'s streams in the Screen area, on the dev server's origin. */
-function placed(screen: Screen, interacting?: GameId, offset = { x: 0, y: 0 }) {
+function placed(screen: Screen, interacting?: TileKey, offset = { x: 0, y: 0 }) {
   return TileRects.placements(screen, TileRects.tileRects(screen, area), offset, interacting)
 }
@@ -128,10 +129,10 @@ function placed(screen: Screen, interacting?: GameId, offset = { x: 0, y: 0 }) {
 /** `game`'s video, 200 by 100 at 100,100. */
 function videoOf(game: GameId) {
-  return { game, bounds: { x: 100, y: 100, width: 200, height: 100 } }
+  return { key: TileKey.game(game), bounds: { x: 100, y: 100, width: 200, height: 100 } }
 }
 
 /** `game`'s video, 200 by 100 at 100,300: below the one `videoOf` places. */
 function belowOf(game: GameId) {
-  return { game, bounds: { x: 100, y: 300, width: 200, height: 100 } }
+  return { key: TileKey.game(game), bounds: { x: 100, y: 300, width: 200, height: 100 } }
 }
 
```

`TilePlacements.test.ts` (lines 30–32):

```diff
@@ -1,3 +1,4 @@
 import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
+import { TileKey } from "@sportal/api/TileKey"
 import { Effect, Option, Queue } from "effect"
 import { Atom } from "effect/reactivity"
@@ -28,6 +29,6 @@ describe("TilePlacements.sync", () => {
 
       assert.strictEqual(call._tag, "SyncTiles")
-      assert.deepStrictEqual(call._tag === "SyncTiles" && call.placements.map(({ game }) => game), [
-        TestWeb.bama
+      assert.deepStrictEqual(call._tag === "SyncTiles" && call.placements.map(({ key }) => key), [
+        TileKey.game(TestWeb.bama)
       ])
     })
```

`Covering.test.ts` (lines 29, 46, 64, 83):

```diff
@@ -1,3 +1,4 @@
 import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
+import { TileKey } from "@sportal/api/TileKey"
 import { Effect, Option, Queue } from "effect"
 import { Atom } from "effect/reactivity"
@@ -27,5 +28,5 @@ describe("Covering.sync", () => {
       }).pipe(Effect.scoped, Effect.provide(registry))
 
-      assert.deepStrictEqual(call, { _tag: "SetHidden", games: [TestWeb.bama] })
+      assert.deepStrictEqual(call, { _tag: "SetHidden", keys: [TileKey.game(TestWeb.bama)] })
     })
   )
@@ -44,5 +45,5 @@ describe("Covering.sync", () => {
       }).pipe(Effect.scoped, Effect.provide(registry))
 
-      assert.deepStrictEqual(call, Option.some({ _tag: "SetHidden", games: [TestWeb.bama] }))
+      assert.deepStrictEqual(call, Option.some({ _tag: "SetHidden", keys: [TileKey.game(TestWeb.bama)] }))
     })
   )
@@ -62,5 +63,5 @@ describe("Covering.sync", () => {
       }).pipe(Effect.scoped, Effect.provide(registry))
 
-      assert.deepStrictEqual(call, { _tag: "SetHidden", games: [] })
+      assert.deepStrictEqual(call, { _tag: "SetHidden", keys: [] })
     })
   )
@@ -81,5 +82,5 @@ describe("Covering.sync", () => {
       }).pipe(Effect.scoped, Effect.provide(registry))
 
-      assert.deepStrictEqual(call, { _tag: "SetHidden", games: [] })
+      assert.deepStrictEqual(call, { _tag: "SetHidden", keys: [] })
     })
   )
```

`Shell.test.ts` and `GuideRelay.test.ts` need no change (the latter's fake bridge has `setHidden: () => {}` and
`onTilePressed: () => () => {}`, which fit the new signatures).

- [ ] **Step 7: Run them**

```bash
pnpm vitest run apps/web/src/screen/TileRects.test.ts apps/web/src/screen/TilePlacements.test.ts apps/web/src/display/Covering.test.ts apps/web/src/shell/Shell.test.ts apps/web/src/hub/GuideRelay.test.ts
```

Expected: PASS.

### Task 6 (phase 2, was task 6): The desktop shell keyed by `TileKey`

**Files:**
- Modify: `apps/desktop/src/main/TileViews.ts`, `apps/desktop/src/main/TileViews.test.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/preload/ShellBridge.ts`

**Interfaces:**
- Consumes: `TileKey`, `TilePlacement.key` (Tasks 2, 5).
- Produces: `TileViews.hide(keys: ReadonlyArray<TileKey>): Effect<void>`, `TileViews.tilePresses: Stream<TileKey>`;
  views kept in a `Map<TileKey, Entry>`. Behaviour unchanged.

- [ ] **Step 1: `TileViews.ts`** (every `game` local becomes `key`; the refused-address warning says "tile")

```diff
@@ -1,5 +1,5 @@
 import { Hotkey } from "@sportal/api/Hotkey"
 import type { ScreenTransition, TileBounds, TilePlacement } from "@sportal/api/ShellBridge"
-import type { GameId } from "@sportal/domain/Game"
+import type { TileKey } from "@sportal/api/TileKey"
 import { Clock, Context, Effect, FiberHandle, Layer, Option, PubSub, Stream } from "effect"
 import type { WebContentsView } from "electron"
@@ -10,6 +10,6 @@ import { Transition } from "./Transition.ts"
 
 /**
- * Keeps one provider web view per game in a stream tile, laid over the web UI at the rectangle the UI
- * reports. A view belongs to its game, so a game that changes tiles keeps its player.
+ * Keeps one provider web view per stream tile, by the tile's key, laid over the web UI at the rectangle the UI
+ * reports. A view belongs to its tile's key, so a game that changes tiles keeps its player.
  * The shell only ever sets a view's address, bounds, visibility, mute flag, and focus, reads the keys pressed in
  * a view, and keeps the mouse from a view's player unless it is interactive; the provider's page is never modified.
@@ -19,17 +19,17 @@ export class TileViews extends Context.Service<
   {
     /**
-     * Makes the views match the placements: views for games not listed are closed. With a transition, views
+     * Makes the views match the placements: views for keys not listed are closed. With a transition, views
      * move from where they are to their new bounds along it, and views new in it appear when it ends.
      */
     sync(placements: ReadonlyArray<TilePlacement>, transition?: ScreenTransition): Effect.Effect<void>
-    /** Hides exactly these games' views, now and through later syncs, until a later call no longer names them. */
-    hide(games: ReadonlyArray<GameId>): Effect.Effect<void>
+    /** Hides exactly these tiles' views, now and through later syncs, until a later call no longer names them. */
+    hide(keys: ReadonlyArray<TileKey>): Effect.Effect<void>
     /** Each hotkey pressed while a stream view had keyboard focus. The page never receives it. */
     readonly hotkeys: Stream.Stream<Hotkey>
     /**
-     * Each game whose stream view was pressed with the left button while it was not interactive. The page never
-     * receives it.
+     * The key of each tile whose stream view was pressed with the left button while it was not interactive. The page
+     * never receives it.
      */
-    readonly tilePresses: Stream.Stream<GameId>
+    readonly tilePresses: Stream.Stream<TileKey>
   }
 >()("sportal/desktop/main/TileViews") {
@@ -41,14 +41,14 @@ export class TileViews extends Context.Service<
       const scope = yield* Effect.scope
       const hotkeys = yield* PubSub.unbounded<Hotkey>()
-      const presses = yield* PubSub.unbounded<GameId>()
+      const presses = yield* PubSub.unbounded<TileKey>()
       const animation = yield* FiberHandle.make<void>()
 
-      const views = new Map<GameId, Entry>()
-      let hidden: ReadonlySet<GameId> = new Set()
+      const views = new Map<TileKey, Entry>()
+      let hidden: ReadonlySet<TileKey> = new Set()
       // Views created during a transition, kept out of sight until it ends.
-      const arriving = new Set<GameId>()
+      const arriving = new Set<TileKey>()
 
       const showWhereDue = () => {
-        for (const [game, { view }] of views) view.setVisible(!hidden.has(game) && !arriving.has(game))
+        for (const [key, { view }] of views) view.setVisible(!hidden.has(key) && !arriving.has(key))
       }
       const place = (entry: Entry, bounds: TileBounds) => {
@@ -68,5 +68,5 @@ export class TileViews extends Context.Service<
       )
 
-      const create = Effect.fn("TileViews.create")(function* (game: GameId) {
+      const create = Effect.fn("TileViews.create")(function* (key: TileKey) {
         const view = yield* providers.createView
         const entry: Entry = {
@@ -77,5 +77,5 @@ export class TileViews extends Context.Service<
         }
         entry.view.webContents.on("before-input-event", (event, input) => {
-          if (views.get(game) !== entry || input.type !== "keyDown") return
+          if (views.get(key) !== entry || input.type !== "keyDown") return
           const hotkey = Hotkey.of(input)
           if (hotkey === undefined) return
@@ -85,7 +85,7 @@ export class TileViews extends Context.Service<
         // YouTube TV shows its title and controls whenever the pointer moves over a player.
         entry.view.webContents.on("before-mouse-event", (event, mouse) => {
-          if (views.get(game) !== entry || entry.interactive) return
+          if (views.get(key) !== entry || entry.interactive) return
           event.preventDefault()
-          if (mouse.type === "mouseDown" && mouse.button === "left") PubSub.publishUnsafe(presses, game)
+          if (mouse.type === "mouseDown" && mouse.button === "left") PubSub.publishUnsafe(presses, key)
         })
         window.contentView.addChildView(entry.view)
@@ -101,24 +101,24 @@ export class TileViews extends Context.Service<
             ? Effect.succeed(true)
             : Effect.logWarning(
-                `TileViews: refused the address for game ${placement.game} on ${hostOf(placement.url)}`
+                `TileViews: refused the address for tile ${placement.key} on ${hostOf(placement.url)}`
               ).pipe(Effect.as(false))
         )
 
-        for (const [game, entry] of views) {
-          if (permitted.some((placement) => placement.game === game)) continue
+        for (const [key, entry] of views) {
+          if (permitted.some((placement) => placement.key === key)) continue
           remove(entry.view)
-          views.delete(game)
-          arriving.delete(game)
+          views.delete(key)
+          arriving.delete(key)
         }
 
-        const moves: Array<{ game: GameId; entry: Entry; from: TileBounds; to: TileBounds }> = []
+        const moves: Array<{ key: TileKey; entry: Entry; from: TileBounds; to: TileBounds }> = []
         for (const placement of permitted) {
-          let entry = views.get(placement.game)
+          let entry = views.get(placement.key)
           if (entry === undefined) {
-            entry = yield* create(placement.game)
-            views.set(placement.game, entry)
+            entry = yield* create(placement.key)
+            views.set(placement.key, entry)
             // A new view has nowhere to move from: it waits at its place until the others arrive.
             place(entry, placement.bounds)
-            if (transition !== undefined) arriving.add(placement.game)
+            if (transition !== undefined) arriving.add(placement.key)
           }
           if (!Option.contains(entry.url, placement.url)) {
@@ -130,5 +130,5 @@ export class TileViews extends Context.Service<
           entry.interactive = placement.interactive
           entry.view.webContents.setAudioMuted(placement.muted)
-          moves.push({ game: placement.game, entry, from: entry.bounds, to: placement.bounds })
+          moves.push({ key: placement.key, entry, from: entry.bounds, to: placement.bounds })
         }
 
@@ -146,5 +146,5 @@ export class TileViews extends Context.Service<
 
       const animate = (
-        moves: ReadonlyArray<{ game: GameId; entry: Entry; from: TileBounds; to: TileBounds }>,
+        moves: ReadonlyArray<{ key: TileKey; entry: Entry; from: TileBounds; to: TileBounds }>,
         transition: ScreenTransition
       ) =>
@@ -157,6 +157,6 @@ export class TileViews extends Context.Service<
               Effect.sync(() => {
                 const eased = Transition.progress(transition.easing, t)
-                moves.forEach(({ game, entry, from, to }) => {
-                  if (views.get(game) === entry) place(entry, Transition.between(from, to, eased))
+                moves.forEach(({ key, entry, from, to }) => {
+                  if (views.get(key) === entry) place(entry, Transition.between(from, to, eased))
                 })
               })
@@ -168,7 +168,7 @@ export class TileViews extends Context.Service<
         })
 
-      const hide = (games: ReadonlyArray<GameId>) =>
+      const hide = (keys: ReadonlyArray<TileKey>) =>
         Effect.sync(() => {
-          hidden = new Set(games)
+          hidden = new Set(keys)
           showWhereDue()
         })
@@ -187,5 +187,5 @@ export class TileViews extends Context.Service<
 const frame = "16 millis"
 
-/** One game's view, the address last placed in it, whether its player gets the mouse, and where it is now. */
+/** One tile's view, the address last placed in it, whether its player gets the mouse, and where it is now. */
 interface Entry {
   view: WebContentsView
```

- [ ] **Step 2: `main.ts`** (`@sportal/domain` is no longer imported by `main.ts`; it stays a devDependency, still read
  by `TileViews.test.ts`)

```diff
@@ -1,5 +1,5 @@
 import { ScreenTransition, TilePlacement } from "@sportal/api/ShellBridge"
 import { ShellChannel } from "@sportal/api/ShellChannel"
-import { GameId } from "@sportal/domain/Game"
+import { TileKey } from "@sportal/api/TileKey"
 import { Cause, Effect, FiberSet, Layer, Option, Queue, Schedule, Schema, Stream } from "effect"
 import { app, components, type IpcMainEvent, ipcMain } from "electron"
@@ -70,6 +70,6 @@ const serveHub = Effect.gen(function* () {
       Queue.offerUnsafe(pending, { placements: decoded.value, transition: along.value })
   })
-  yield* listen(ShellChannel.setHidden, (games) => {
-    const decoded = decodeGames(games)
+  yield* listen(ShellChannel.setHidden, (keys) => {
+    const decoded = decodeKeys(keys)
     if (Option.isSome(decoded)) run(tiles.hide(decoded.value))
   })
@@ -154,5 +154,5 @@ const listen = Effect.fn("main.listen")(function* (
 const decodePlacements = Schema.decodeUnknownOption(Schema.Array(TilePlacement))
 const decodeTransition = Schema.decodeUnknownOption(Schema.UndefinedOr(ScreenTransition))
-const decodeGames = Schema.decodeUnknownOption(Schema.Array(GameId))
+const decodeKeys = Schema.decodeUnknownOption(Schema.Array(TileKey))
 
 function allWindowsClosed() {
```

- [ ] **Step 3: the preload** (parameter name only)

```diff
@@ -5,5 +5,5 @@ import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"
 const bridge: ShellBridge = {
   syncTiles: (placements, transition) => ipcRenderer.send(ShellChannel.syncTiles, placements, transition),
-  setHidden: (games) => ipcRenderer.send(ShellChannel.setHidden, games),
+  setHidden: (keys) => ipcRenderer.send(ShellChannel.setHidden, keys),
   setFullScreen: (on) => ipcRenderer.send(ShellChannel.setFullScreen, on),
   onFullScreenChanged: subscribe(ShellChannel.fullScreenChanged),
```

- [ ] **Step 4: Keep the TileViews assertions under `TileKey`**

The fixtures `one`, `two` become a game's tile key and `placement`/`secondGame()` carry `key`; every assertion stays
as written (`expect(reported).toEqual([one])` and `[two]` now compare keys):

```diff
@@ -1,3 +1,4 @@
 import { describe, expect, it } from "@effect/vitest"
+import { TileKey } from "@sportal/api/TileKey"
 import { GameId } from "@sportal/domain/Game"
 import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect"
@@ -135,5 +136,5 @@ describe("TileViews.sync", () => {
       const scope = yield* Scope.make()
       const { window, tiles } = yield* attached().pipe(Scope.provide(scope))
-      yield* tiles.sync([placement, { ...placement, game: two }])
+      yield* tiles.sync([placement, { ...placement, key: two }])
 
       yield* Scope.close(scope, Exit.void)
@@ -399,5 +400,5 @@ describe("TileViews mouse filter", () => {
       mouse(0, "mouseDown", "left")
       yield* tiles.sync([placement])
-      yield* tiles.sync([{ ...placement, game: two }])
+      yield* tiles.sync([{ ...placement, key: two }])
       mouse(0, "mouseDown", "left")
       mouse(1, "mouseDown", "left")
@@ -409,8 +410,8 @@ describe("TileViews mouse filter", () => {
 })
 
-const one = GameId.make("one")
-const two = GameId.make("two")
+const one = TileKey.game(GameId.make("one"))
+const two = TileKey.game(GameId.make("two"))
 const placement = {
-  game: one,
+  key: one,
   url: "https://tv.youtube.com/watch/one",
   bounds: { x: 10, y: 20, width: 640, height: 360 },
@@ -436,5 +437,5 @@ function attached() {
 /** The second game's placement, on its own address, where `placement` is. */
 function secondGame() {
-  return { ...placement, game: two, url: "https://tv.youtube.com/watch/two" }
+  return { ...placement, key: two, url: "https://tv.youtube.com/watch/two" }
 }
 
```

- [ ] **Step 5: Run them**

```bash
pnpm vitest run apps/desktop/src/main/TileViews.test.ts
```

Expected: PASS.

- [ ] **Step 6: Confirm nothing still passes a `GameId` where a tile is meant**

```bash
grep -rn "GameId" apps/web/src/screen/TileRects.ts apps/web/src/screen/TilePlacements.ts apps/web/src/display/Covering.ts apps/web/src/shell/Shell.ts apps/desktop/src/main/TileViews.ts apps/desktop/src/main/main.ts packages/api/src/ShellBridge.ts
grep -rn "coveredGames\|placement\.game\|\.benched().*\.game\|VideoPressed({ game" apps packages --include=*.ts --include=*.tsx
```

Expected: no matches.

### Task 7 (phase 2, was task 7): The glossary row, the tree line, and the check — then commit

**Files:**
- Modify: `CONTEXT.md`
- Modify: `docs/technical-spec.md`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces: phase 2 committed.

- [ ] **Step 1: `CONTEXT.md`**

`AGENTS.md` asks for a new exported type's row in the same commit, so `TileKey` gets its row now (phase 8 then skips
it). Under "### Viewing", directly below the `| **Tile** | …` row, insert:

```markdown
| **Tile key** | What a tile shows, as one string: a game's stream or data tile is the game's id. Audio focus, solo, the interacting tile, tile placements and the shell's provider views name a tile by it, so what a tile shows keeps them when it moves; `TileKey` in `packages/api/src/TileKey.ts`, and `Tile.key` gives a tile's. | tile id, slot id |
```

- [ ] **Step 2: `docs/technical-spec.md`**

In the `packages/api` tree (around line 235), directly below the `ShellBridge.ts` line, insert:

```text
│           ├── TileKey.ts          What a tile shows, as the one string the Screen, the shell and a Remote name it by
```

- [ ] **Step 3: Format and check**

```bash
pnpm format
pnpm check
```

Expected: `pnpm format` fixes nothing beyond what the diffs above already show (they are biome-formatted); `pnpm check`
passes: biome, `tsc --noEmit` everywhere with the `@effect/tsgo` diagnostics, depcruise, knip, `knip --production`, and
every test.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: tiles keyed by TileKey, not GameId

A tile now has an identity that is not only a game: TileKey, a branded
string in packages/api, with TileKey.game(id) (the game's id itself) and
Tile.key(tile) (none for an empty tile). Audio focus, solo, slotOf,
benched, the interacting tile, VideoPressed, TilePlacement.key,
setHidden, onTilePressed, Shell.tilePressed, TileRects.coveredTiles and
the desktop TileViews all name tiles by it. Chosen, choose and Assign
still name a game. No behaviour changes, and the Screen's encoded form
and every IPC payload are unchanged, since a game's key is its id.

New tests: TileKey (should send a key as its plain string), TileKey.game
(should key a game's tile by the game's id), Tile.key (should key a
stream tile by its game; should key a data tile by its game; should give
an empty tile no key).

Rewritten tests, each kept under its own name with every assertion it
had, a GameId value wrapped in TileKey.game where it now meets a TileKey:

apps/web/src/screen/Screen.test.ts
- Screen#apply: should give audio to the first game on screen when no
  game has it -> same name; should move audio focus to a tile's game ->
  same name; should keep audio focus where it is when another game is
  assigned -> same name; should move audio to the main tile's game when
  the focused game is cleared -> same name
- Screen#refresh: should leave audio focus where it was -> same name
- Screen layouts and the bench: should move audio off a benched game to
  the main tile's game -> same name
- Screen#hears and Screen#soloes: should hear the on-air game; should
  not hear the soloed game when another is on air; should solo the
  soloed game; should not solo the game on air; should not hear a game
  in no tile; should not solo a game in no tile -> each the same name
- Screen#benched: should list the games a shrunk layout benched, with
  their tiles; should skip the empty tiles past the slots -> each the
  same name (entries carry key in place of game)
- Screen swap and promote: should keep audio with its game through a
  swap; should promote a tile into the main tile and give it audio ->
  each the same name
- Screen solo: should solo a tile's game and give it audio; should
  follow its game through a swap -> each the same name

apps/web/src/display/Display.test.ts
- Display#press: should unsolo with ToggleSolo while soloed; should
  unsolo with ToggleSolo on an Empty tile while soloed; should close the
  key help with Esc and send no Unsolo, even while soloed; should unsolo
  with Esc and no overlay while soloed -> each the same name
- Display#apply: should select the slot a pressed video's game is in;
  should do nothing for a pressed video whose game is not on screen ->
  each the same name (VideoPressed carries key)

apps/web/src/display/DisplayState.test.ts
- DisplayState: should select the slot of a video the shell says was
  pressed -> same name

apps/web/src/screen/TileAction.test.ts
- TileAction.of: should word hear by whether the tile's sound is already
  on -> same name

apps/web/src/screen/TileRects.test.ts
- placements: should place a stream tile's video below its header,
  offset by the Screen area's position; should give the mouse only to
  the interacting game's stream; should place nothing for a tile with no
  size -> each the same name
- coveredGames, now describe coveredTiles: should cover a video an
  overlay shares area with: \$shares; should leave a video an overlay
  shares no area with: \$is; should leave a video shown under an
  overlay flush against its top edge; should cover every video an
  overlay reaches -> each the same name

apps/web/src/screen/TilePlacements.test.ts
- TilePlacements.sync: should tell the shell nothing until the area has
  a size, then its placements -> same name

apps/web/src/display/Covering.test.ts
- Covering.sync: should hide the videos an open overlay covers; should
  tell the shell before the registry's scheduler runs a task; should
  show the videos again once the overlay closes; should tell the shell
  nothing while what is hidden is unchanged -> each the same name
  (SetHidden carries keys)

apps/desktop/src/main/TileViews.test.ts
- every test, under its own name: the fixtures one, two, placement and
  secondGame key by TileKey; should remove and close every view when
  the shell shuts down and should report neither a press on an
  interactive view nor one on a view removed in a sync spread key in
  place of game

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Contract notes

- **`TileKey` constructors.** As the contract says, `TileKey` is `Schema.String.pipe(Schema.brand("TileKey"))` with
  `game` attached by `Object.assign`, in `packages/api/src/TileKey.ts`, the shape `GamesQuery.ts` uses. Only `game`
  exists after phase 2; `custom`, `stats`, `clip` join the same `Object.assign` in their phases (each a hoisted
  function below, prefixing `custom:`, `stats:`, `clip:`).
- **`Tile.key` has two overloads.** `key(tile: Occupied): TileKey` and `key(tile: Tile): TileKey | undefined`. The
  contract's `TileKey | undefined` holds for any `Tile`; the first overload lets code that has already ruled out `Empty`
  (`TileRects.placements`, `TileAction.of`, `Screen#benched`, `Promote`/`FocusAudio`/`Solo`) get a `TileKey` with no
  `undefined` check. Later phases that add tile cases add them to `key`'s body, not to callers.
- **`ScreenCommand` does not change.** The contract renames "ScreenCommand fields naming an on-screen thing". None does:
  `Clear`, `FocusAudio`, `Swap`, `Promote`, `Solo` name slots by index, and `Assign({ tile, game })` names a game to
  resolve through `availabilityOf`, so it stays a `GameId` (as `Chosen` does).
- **`Screen#benched` is renamed too.** Not in the contract's list, but it names benched tiles, and `Display#choose`
  matches a benched tile against the chosen game's key, so it returns `{ tile, key: TileKey }`. Phase 4's custom tiles
  need this to bench and swap back.
- **`TileRects.coveredGames` is renamed `coveredTiles`.** The contract lists `TileRects` without naming its members;
  a function that returns tile keys should not say "games". Private `gamesIn` (`TilePlacements.ts`) and `sameGames`
  (`Covering.ts`) become `keysIn` and `sameKeys` for the same reason.
- **The Remote's report needs no code change.** `RemoteReport` is `{ screen: Screen }`, so it follows the Screen's
  schema; its encoded JSON is the same strings. `RemoteMessage.ts` and `DisplayMessage.ts` carry `Schema.Json` and do
  not change. "The Remote's report and `ScreenMap`" comes down to `ScreenMap.tsx` (hears/soloes by `Tile.key`) and
  `RemoteView.tsx` (`slotOf(TileKey.game(snapshot.id))`).
- **The `TileKey` glossary row lands in phase 2**, not phase 8, because `AGENTS.md` asks for a new exported type's row
  in the same commit. Phase 8 should not add it again. The `docs/technical-spec.md` tree also gains its `TileKey.ts` line
  here.
## Phase 3 — Guide by league, two themes, no top bar

Phase 3 is two commits, and `pnpm check` is green after each one.

- **Commit 3a (Tasks 1–5): the guide's keys and state.** This covers `Hotkey`, the shell plumbing for `setGuideOpen`
  (bridge, preload, desktop main, `TileViews`, web `Shell`), `GuideItem`, `guideShelves`, the `Display` fold and
  `DisplayState`. The guide opens and moves (G, arrows, Enter) and the shell hears that it is open. Nothing draws it
  yet.
- **Commit 3b (Tasks 6–12): what the guide looks like.** This covers `theme.css`, `Theme`, `teamColor`, `GameChip`,
  `GameCard`, `Shelf`, `Ribbon`, `GuideRail`, `FullGuide`, the connection toast and the new `DisplayView`. `TopBar` is
  deleted.

The split follows `knip --production`. Theme, cards and views have no production user until the new `DisplayView`
mounts them, so they all land in 3b. `DisplayState.shelves` stays private in 3a (only its own writer reads it) and is
exported in 3b, when the views read it.

Before starting, phase 2 has already landed: `TileKey` in `packages/api/src/TileKey.ts`, with
`Display.interacting: TileKey | undefined`, `DisplayInput.VideoPressed({ key })`, `Screen.solo: Option<TileKey>`,
`Screen.slotOf(key)`, `TilePlacement.key`, `setHidden(keys)` and `TileRects.coveredTiles`. `ScreenCommand` has not
changed (`Assign({ tile, game })` still names a `GameId`). Where this phase's code meets those, it uses phase 2's
spelling. Where a `GameId` meets a `TileKey`, it is wrapped in `TileKey.game(...)`.

Run a single test file with `pnpm vitest run <path>`. The root `vitest.config.ts` runs every workspace as a project.

---

### Task 8 (phase 3, was task 1): The guide's hotkeys

**Files:**
- Modify: `packages/api/src/Hotkey.ts`
- Modify: `packages/api/src/Hotkey.test.ts`

**Interfaces:**
- Produces: `Hotkey` cases `Guide: {}`, `Move: { direction: "up" | "down" | "left" | "right" }`, `Confirm: {}`,
  `NextEntry: {}`, `PreviousEntry: {}`, `Info: {}`.
  `Hotkey.of(key: { code; shift; alt; control; meta; guideOpen: boolean }): Hotkey | undefined`.
  `Hotkey.keys` gains rows with `group: "Guide"`. A row's `press` may set `guideOpen: true`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

In `packages/api/src/Hotkey.test.ts`:

1. Widen the `Modifiers` type at the bottom, and add `guideOpen: false` to `key`:

```ts
type Modifiers = Partial<{ shift: boolean; alt: boolean; control: boolean; meta: boolean; guideOpen: boolean }>

function key(code: string, modifiers: Modifiers = {}) {
  return Hotkey.of({ code, shift: false, alt: false, control: false, meta: false, guideOpen: false, ...modifiers })
}
```

2. In `describe("Hotkey.keys")`, add `guideOpen: false` to the first test's `press`:

```ts
    const press = { shift: false, alt: false, control: false, meta: false, guideOpen: false, ...binding.press }
```

3. Add to `wire`, after `{ _tag: "ShowKeys" }`:

```ts
  { _tag: "Guide" },
  { _tag: "Move", direction: "up" },
  { _tag: "Confirm" },
  { _tag: "NextEntry" },
  { _tag: "PreviousEntry" },
  { _tag: "Info" }
```

4. Add a new `describe` after `describe("Hotkey.of")`:

```ts
describe("Hotkey.of in the guide", () => {
  it.each<{ code: string; direction: "up" | "down" | "left" | "right" }>([
    { code: "ArrowUp", direction: "up" },
    { code: "ArrowDown", direction: "down" },
    { code: "ArrowLeft", direction: "left" },
    { code: "ArrowRight", direction: "right" }
  ])("should read $code as a move $direction while the guide is open", ({ code, direction }) => {
    const hotkey = key(code, { guideOpen: true })

    assert.deepStrictEqual(hotkey, { _tag: "Move", direction })
  })

  it.each(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])(
    "should leave %s to the page while the guide is closed",
    (code) => {
      const hotkey = key(code)

      assert.isUndefined(hotkey)
    }
  )

  it.each([false, true])("should read G as the guide, whether it is open or not: open %s", (guideOpen) => {
    const hotkey = key("KeyG", { guideOpen })

    assert.deepStrictEqual(hotkey, { _tag: "Guide" })
  })

  it.each<{ code: string; hotkey: Hotkey }>([
    { code: "Enter", hotkey: { _tag: "Confirm" } },
    { code: "BracketRight", hotkey: { _tag: "NextEntry" } },
    { code: "BracketLeft", hotkey: { _tag: "PreviousEntry" } },
    { code: "KeyI", hotkey: { _tag: "Info" } }
  ])("should read $code as $hotkey._tag while the guide is open", ({ code, hotkey }) => {
    const read = key(code, { guideOpen: true })

    assert.deepStrictEqual(read, hotkey)
  })

  it.each(["Enter", "BracketRight", "BracketLeft"])("should leave %s to the page while the guide is closed", (code) => {
    const hotkey = key(code)

    assert.isUndefined(hotkey)
  })

  it("should read I as interacting while the guide is closed", () => {
    const hotkey = key("KeyI")

    assert.deepStrictEqual(hotkey, { _tag: "Interact" })
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/api/src/Hotkey.test.ts`
Expected: FAIL. The guide cases do not exist yet, and `guideOpen` is not part of `of`'s parameter.

- [ ] **Step 3: Write the cases, `of`, and the key rows**

In `packages/api/src/Hotkey.ts`:

1. Add the cases to the `Schema.TaggedUnion` after `ShowKeys: {}`:

```ts
    /** Open the guide's ribbon, or from the ribbon the full guide. */
    Guide: {},
    /** An arrow, while the guide is open. */
    Move: { direction: Schema.Literals(["up", "down", "left", "right"]) },
    /** Watch what the guide has focused. */
    Confirm: {},
    /** The guide's next entry. */
    NextEntry: {},
    /** The guide's previous entry. */
    PreviousEntry: {},
    /** Open the focused game's page. */
    Info: {}
```

2. Replace `of` with:

```ts
    /**
     * What a key press means, read by its physical `code`; none for a key the page should have. While the guide is
     * open, the arrows, Enter, the brackets and I are the guide's.
     */
    of(key: {
      code: string
      shift: boolean
      alt: boolean
      control: boolean
      meta: boolean
      guideOpen: boolean
    }): Hotkey | undefined {
      if (key.control || key.meta) return key.code === "KeyK" ? { _tag: "CommandPalette" } : undefined
      const digit = /^Digit([1-9])$/.exec(key.code)?.[1]
      if (key.alt) return digit === undefined ? undefined : { _tag: "SelectTile", slot: Number(digit) - 1 }
      if (digit !== undefined) return { _tag: key.shift ? "Promote" : "FocusAudio", slot: Number(digit) - 1 }
      const guide = key.guideOpen ? guideKey(key.code) : undefined
      if (guide !== undefined) return guide
      switch (key.code) {
        case "KeyF":
          return { _tag: "ToggleSolo" }
        case "Escape":
          return { _tag: "Unsolo" }
        case "F11":
          return { _tag: "FullScreen" }
        case "KeyL":
          return { _tag: "NextLayout" }
        case "KeyI":
          return { _tag: "Interact" }
        case "KeyG":
          return { _tag: "Guide" }
        case "Slash":
          return key.shift ? { _tag: "ShowKeys" } : undefined
        default:
          return undefined
      }
    },
```

3. In `keys`, change the Esc row's `does` to `"Close what is open (the full guide goes back to the ribbon), or unsolo"`.
   Then add these rows after the last `Screen` row:

```ts
      {
        group: "Guide",
        keys: ["G"],
        does: "Open the guide, then the full guide",
        press: { code: "KeyG" },
        hotkey: { _tag: "Guide" }
      },
      {
        group: "Guide",
        keys: ["←", "↑", "→", "↓"],
        does: "Move in the guide (up from the ribbon opens the full guide)",
        press: { code: "ArrowLeft", guideOpen: true },
        hotkey: { _tag: "Move", direction: "left" }
      },
      {
        group: "Guide",
        keys: ["Enter"],
        does: "Watch the focused game in the selected tile",
        press: { code: "Enter", guideOpen: true },
        hotkey: { _tag: "Confirm" }
      },
      {
        group: "Guide",
        keys: ["]"],
        does: "Next league",
        press: { code: "BracketRight", guideOpen: true },
        hotkey: { _tag: "NextEntry" }
      },
      {
        group: "Guide",
        keys: ["["],
        does: "Previous league",
        press: { code: "BracketLeft", guideOpen: true },
        hotkey: { _tag: "PreviousEntry" }
      },
      {
        group: "Guide",
        keys: ["I"],
        does: "The focused game's page",
        press: { code: "KeyI", guideOpen: true },
        hotkey: { _tag: "Info" }
      }
```

4. Add this below `export type Hotkey = typeof Hotkey.Type`:

```ts
/** A key that is the guide's while it is open: the arrows, Enter, the brackets, and I. */
function guideKey(code: string): Hotkey | undefined {
  switch (code) {
    case "ArrowUp":
      return { _tag: "Move", direction: "up" }
    case "ArrowDown":
      return { _tag: "Move", direction: "down" }
    case "ArrowLeft":
      return { _tag: "Move", direction: "left" }
    case "ArrowRight":
      return { _tag: "Move", direction: "right" }
    case "Enter":
      return { _tag: "Confirm" }
    case "BracketRight":
      return { _tag: "NextEntry" }
    case "BracketLeft":
      return { _tag: "PreviousEntry" }
    case "KeyI":
      return { _tag: "Info" }
    default:
      return undefined
  }
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run packages/api/src/Hotkey.test.ts`
Expected: PASS. "should list the hotkey %s" now also covers the six new tags.

---

### Task 9 (phase 3, was task 2): `setGuideOpen` through the bridge to the desktop's tile views

**Files:**
- Modify: `packages/api/src/ShellBridge.ts`, `packages/api/src/ShellChannel.ts`
- Modify: `apps/desktop/src/preload/ShellBridge.ts`, `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/main/TileViews.ts`, `apps/desktop/src/main/TileViews.test.ts`

**Interfaces:**
- Consumes: `Hotkey.of` with `guideOpen` (Task 1).
- Produces: `ShellBridge.setGuideOpen(on: boolean): void`, `ShellChannel.setGuideOpen`, and
  `TileViews.setGuideOpen(on: boolean): Effect.Effect<void>`.

- [ ] **Step 1: Write the failing tests**

Add to `describe("TileViews.hotkeys")` in `apps/desktop/src/main/TileViews.test.ts`:

```ts
  it.effect("should leave an arrow to the stream view's page while the guide is closed", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])

      const prevented = press("ArrowDown")

      expect(prevented).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should keep an arrow from the stream view's page while the guide is open", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.setGuideOpen(true)

      const prevented = press("ArrowDown")

      expect(prevented).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should forward an arrow as a move while the guide is open", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.setGuideOpen(true)
      const hotkeys = yield* TestDesktop.collect(tiles.hotkeys, 1)

      press("ArrowDown")
      const forwarded = yield* Fiber.join(hotkeys)

      expect(forwarded).toEqual([{ _tag: "Move", direction: "down" }])
    }).pipe(Effect.scoped)
  )

  it.effect("should leave arrows to the stream view's page again once the guide closes", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.setGuideOpen(true)
      yield* tiles.setGuideOpen(false)

      const prevented = press("ArrowDown")

      expect(prevented).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )
```

Also add `alt: false,` to the input object that the file's `press` helper emits, after `shift: false,`. `Hotkey.of` now
reads every modifier by name.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/desktop/src/main/TileViews.test.ts`
Expected: FAIL. `tiles.setGuideOpen` is not a function.

- [ ] **Step 3: Add the bridge call and its channel**

In `packages/api/src/ShellChannel.ts`, add `setGuideOpen: "sportal:set-guide-open",` after `readGuide`.

In `packages/api/src/ShellBridge.ts`, add to the `ShellBridge` interface after `readGuide()`:

```ts
  /**
   * Tells the shell whether the guide is open. While it is, a stream view's arrows, Enter, brackets and I are hotkeys
   * and the player never sees them; while it is closed, the player keeps them.
   */
  setGuideOpen(on: boolean): void
```

In `apps/desktop/src/preload/ShellBridge.ts`, add to `bridge` after `readGuide`:

```ts
  setGuideOpen: (on) => ipcRenderer.send(ShellChannel.setGuideOpen, on)
```

- [ ] **Step 4: Keep the flag in `TileViews`**

In `apps/desktop/src/main/TileViews.ts`:

1. Add this member to the service interface, after `hide`:

```ts
    /** Whether the guide is open: while it is, the guide's keys pressed in a stream view are hotkeys, not the player's. */
    setGuideOpen(on: boolean): Effect.Effect<void>
```

2. In the layer, add `let guideOpen = false` on the line after `let hidden: ReadonlySet<…> = new Set()`.

3. In `create`'s `before-input-event` handler, replace `const hotkey = Hotkey.of(input)` with:

```ts
          const hotkey = Hotkey.of({
            code: input.code,
            shift: input.shift,
            alt: input.alt,
            control: input.control,
            meta: input.meta,
            guideOpen
          })
```

4. Add `setGuideOpen` to the returned service:

```ts
      return TileViews.of({
        sync,
        hide,
        setGuideOpen: (on) =>
          Effect.sync(() => {
            guideOpen = on
          }),
        hotkeys: Stream.fromPubSub(hotkeys),
        tilePresses: Stream.fromPubSub(presses)
      })
```

5. Add one sentence to the class doc comment, after "reads the keys pressed in a view": "— the guide's keys only
   while the web UI says the guide is open —".

- [ ] **Step 5: Hear it in the desktop main**

In `apps/desktop/src/main/main.ts`, add this after the `ShellChannel.setFullScreen` listener:

```ts
  yield* listen(ShellChannel.setGuideOpen, (on) => {
    if (typeof on === "boolean") run(tiles.setGuideOpen(on))
  })
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm vitest run apps/desktop/src/main/TileViews.test.ts`
Expected: PASS.

---

### Task 10 (phase 3, was task 3): The web `Shell` tells the shell, and reads the flag for page keys

**Files:**
- Modify: `apps/web/src/shell/Shell.ts`, `apps/web/src/shell/Shell.test.ts`

**Interfaces:**
- Consumes: `ShellBridge.setGuideOpen` (Task 2) and `Hotkey.of` with `guideOpen` (Task 1).
- Produces: `Shell` member `setGuideOpen: (on: boolean) => Effect.Effect<void>`. A `layerTest` call is recorded as
  `{ _tag: "SetGuideOpen"; on: boolean }`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/shell/Shell.test.ts`, replace `firstHotkey` with:

```ts
/** The first hotkey the browser Shell gives, listening from the moment it is forked. */
const firstHotkey = Effect.gen(function* () {
  const shell = yield* Shell
  return yield* firstOf(shell)
}).pipe(Effect.provide(Shell.layerBrowser))

/** The first hotkey `shell` gives, listening from the moment it is forked. */
function firstOf(shell: Shell["Service"]) {
  return shell.hotkeys.pipe(
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
    Effect.forkChild({ startImmediately: true })
  )
}
```

Then add these tests to `describe("Shell.layerBrowser hotkeys")`:

```ts
  it.effect("should give an arrow as a move once the guide is open", () =>
    Effect.gen(function* () {
      const shell = yield* Shell
      yield* shell.setGuideOpen(true)
      const next = yield* firstOf(shell)

      window.dispatchEvent(keydown({ code: "ArrowDown" }))
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "Move", direction: "down" })
    }).pipe(Effect.provide(Shell.layerBrowser))
  )

  it.effect("should leave an arrow to the page while the guide is closed", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey
      const arrow = keydown({ code: "ArrowDown" })

      window.dispatchEvent(arrow)
      window.dispatchEvent(keydown({ code: "Slash", shiftKey: true }))
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "ShowKeys" })
      assert.isFalse(arrow.defaultPrevented)
    })
  )
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/web/src/shell/Shell.test.ts`
Expected: FAIL. `shell.setGuideOpen` is not a function.

- [ ] **Step 3: Add `setGuideOpen` to `Shell`**

In `apps/web/src/shell/Shell.ts`:

1. Add `Ref` to the `effect` import.

2. Add this member to the service interface, after `setHidden`:

```ts
    /**
     * Whether the guide is open. While it is, the arrows, Enter, the brackets and I are the guide's hotkeys, on the
     * page and in a focused stream view; while it is closed, the page and the players keep them.
     */
    readonly setGuideOpen: (on: boolean) => Effect.Effect<void>
```

3. Replace `layerBridge` with:

```ts
  static layerBridge(bridge: ShellBridge): Layer.Layer<Shell> {
    return Layer.effect(
      Shell,
      Effect.gen(function* () {
        const guideOpen = yield* Ref.make(false)

        return Shell.of({
          hotkeys: Stream.merge(
            pageHotkeys(guideOpen),
            listened<Hotkey>((listener) => bridge.onHotkey(listener))
          ),
          fullScreen: listened((listener) => bridge.onFullScreenChanged(listener)),
          tilePressed: listened((listener) => bridge.onTilePressed(listener)),
          guideRead: listened((listener) => bridge.onGuideRead(listener)),
          setFullScreen: (on) => Effect.sync(() => bridge.setFullScreen(on)),
          syncTiles: (placements, transition) =>
            Effect.sync(() => bridge.syncTiles(placements, Option.getOrUndefined(transition))),
          setHidden: (keys) => Effect.sync(() => bridge.setHidden(keys)),
          setGuideOpen: (on) =>
            Ref.set(guideOpen, on).pipe(Effect.andThen(Effect.sync(() => bridge.setGuideOpen(on)))),
          readGuide: Effect.sync(() => bridge.readGuide()),
          openSignIn: Option.some(Effect.sync(() => bridge.openSignIn()))
        })
      })
    )
  }
```

(`setHidden`'s parameter name follows whatever phase 2 named it.)

4. Replace `layerBrowser` with:

```ts
  /**
   * The browser's own Shell, for a page outside the desktop shell: hotkeys pressed on the page and the document's full
   * screen, and no calls to a shell. Built lazily because the helpers it reads sit below the class.
   */
  static readonly layerBrowser: Layer.Layer<Shell> = Layer.effect(
    Shell,
    Effect.gen(function* () {
      const guideOpen = yield* Ref.make(false)

      return Shell.of({
        hotkeys: pageHotkeys(guideOpen),
        fullScreen: listened((listener) => {
          const changed = () => listener(document.fullscreenElement !== null)
          document.addEventListener("fullscreenchange", changed)
          return () => document.removeEventListener("fullscreenchange", changed)
        }),
        tilePressed: Stream.empty,
        guideRead: Stream.empty,
        // A browser refuses full screen outside a user gesture, or when the page may not have it.
        setFullScreen: (on) =>
          Effect.tryPromise(() =>
            on ? document.documentElement.requestFullscreen() : document.exitFullscreen()
          ).pipe(Effect.catch((error) => Effect.logWarning("The browser did not change full screen", error))),
        syncTiles: () => Effect.void,
        setHidden: () => Effect.void,
        setGuideOpen: (on) => Ref.set(guideOpen, on),
        readGuide: Effect.void,
        openSignIn: Option.none()
      })
    })
  )
```

5. In `layerTest`, add `| { readonly _tag: "SetGuideOpen"; readonly on: boolean }` to `record`'s call union, and add
   `setGuideOpen: (on) => record({ _tag: "SetGuideOpen", on }),` after `setHidden` in the built service.

6. Replace the `pageHotkeys` const with a hoisted function in the same place:

```ts
/**
 * Hotkeys pressed on the page, the guide's keys among them while `guideOpen` holds. Keys typed into a text field are the
 * field's, and a key already handled is ignored, except Ctrl+K.
 */
function pageHotkeys(guideOpen: Ref.Ref<boolean>): Stream.Stream<Hotkey> {
  return listened<Hotkey>((listener) => {
    const pressed = (event: KeyboardEvent) => {
      const hotkey = Hotkey.of({
        code: event.code,
        shift: event.shiftKey,
        alt: event.altKey,
        control: event.ctrlKey,
        meta: event.metaKey,
        guideOpen: Ref.getUnsafe(guideOpen)
      })
      if (hotkey === undefined || event.repeat) return
      if (!Hotkey.guards.CommandPalette(hotkey) && (isTyping(event.target) || event.defaultPrevented)) return
      // In the listener itself: a default prevented after the event has been dispatched is too late.
      event.preventDefault()
      listener(hotkey)
    }
    window.addEventListener("keydown", pressed)
    return () => window.removeEventListener("keydown", pressed)
  })
}
```

7. In the class doc comment, change "hotkeys, full screen, presses on a video, and the guide the shell reads" to
   "hotkeys (the guide's while it is open), full screen, presses on a video, and the guide the shell reads".

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run apps/web/src/shell/Shell.test.ts`
Expected: PASS.

---

### Task 11 (phase 3, was task 4): Guide items and the pure shelves

**Files:**
- Create: `apps/web/src/guide/GuideItem.ts`
- Create: `apps/web/src/guide/GuideShelves.ts`, `apps/web/src/guide/GuideShelves.test.ts`

**Interfaces:**
- Consumes: `GamesQuery.answer` (`packages/api/src/GamesQuery.ts`), `ListedGame`, and the types `GuideEntry` and
  `GuideLevel` from `display/Display.ts` (Task 5; the import is type-only, which `no-circular` allows).
- Produces:
  - `type GuideItem = Data.TaggedEnum<{ Game: { readonly game: GameId } }>` and `const GuideItem`. Phase 4 adds
    `Custom` and `AddCustom`; phase 7 adds `Clip`.
  - `type GuideShelves = (entry: GuideEntry, level: GuideLevel) => ReadonlyArray<ReadonlyArray<GuideItem>>`.
  - `guideShelves(games: ReadonlyArray<ListedGame>): GuideShelves`.

Shelves contract (later phases depend on it):

| Entry | Ribbon | Full |
| --- | --- | --- |
| `AllLive` | `[live of every league]` | `[live of every league]` |
| a league | `[live, then upcoming]` | `[live, upcoming, over]`: **Live now**, **Later today**, **Final** (phase 7 appends **Highlights**) |
| `Custom` | `[[]]` (phase 4 fills it) | `[[]]` (phase 4 fills it) |

Every shelf is in `GameSnapshot.watchOrder`, as `GamesQuery.answer` orders it. A league's full guide always has its
three shelves, even when some are empty, so a shelf's index always means the same thing.

- [ ] **Step 1: Write `GuideItem.ts`**

```ts
import type { GameId } from "@sportal/domain/Game"
import { Data } from "effect"

/** One thing on a shelf of the Display's guide: a game, for now. */
export type GuideItem = Data.TaggedEnum<{
  Game: { readonly game: GameId }
}>
export const GuideItem = Data.taggedEnum<GuideItem>()
```

- [ ] **Step 2: Write the failing tests**

`apps/web/src/guide/GuideShelves.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import type { ListedGame } from "@sportal/api/ListedGame"
import { GameId, type GameStatus } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { snapshot } from "@sportal/domain/TestGame"
import { DateTime } from "effect"
import { GuideItem } from "./GuideItem.ts"
import * as GuideShelves from "./GuideShelves.ts"

describe("GuideShelves.guideShelves", () => {
  it("should shelve every league's live games for All live in the ribbon, and nothing else", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves("AllLive", "Ribbon"), [[item("kc"), item("osu")]])
  })

  it("should shelve All live the same in the full guide", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves("AllLive", "Full"), [[item("kc"), item("osu")]])
  })

  it("should give a league's live then upcoming games in the ribbon, without its final ones", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves("nfl", "Ribbon"), [[item("kc"), item("gb"), item("sf")]])
  })

  it("should shelve a league's games as live now, later today and final in the full guide", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves("nfl", "Full"), [[item("kc")], [item("gb"), item("sf")], [item("nyj")]])
  })

  it("should order upcoming games by their start", () => {
    const shelves = GuideShelves.guideShelves(today)

    const [, later] = shelves("nfl", "Full")

    assert.deepStrictEqual(later, [item("gb"), item("sf")])
  })

  it("should give a league with no games today empty shelves at either level", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves("nba", "Ribbon"), [[]])
    assert.deepStrictEqual(shelves("nba", "Full"), [[], [], []])
  })

  it("should give Custom one empty shelf for now", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves("Custom", "Full"), [[]])
  })
})

// Listed out of order on purpose: sf starts after gb.
const today: ReadonlyArray<ListedGame> = [
  listed("sf", "nfl", "scheduled", "2026-10-03T20:00:00Z"),
  listed("nyj", "nfl", "final"),
  listed("kc", "nfl", "live"),
  listed("gb", "nfl", "scheduled", "2026-10-03T17:00:00Z"),
  listed("osu", "fbs", "live")
]

function listed(
  id: string,
  league: LeagueId,
  status: GameStatus,
  startsAt = "2026-10-03T16:00:00Z"
): ListedGame {
  const at = DateTime.makeUnsafe(startsAt)
  return { snapshot: snapshot({ id: GameId.make(id), league, status, startsAt: at }), availability: [] }
}

function item(id: string): GuideItem {
  return GuideItem.Game({ game: GameId.make(id) })
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run apps/web/src/guide/GuideShelves.test.ts`
Expected: FAIL. `./GuideShelves.ts` does not exist.

- [ ] **Step 4: Write `GuideShelves.ts`**

```ts
import { GamesQuery } from "@sportal/api/GamesQuery"
import type { ListedGame } from "@sportal/api/ListedGame"
import type { GuideEntry, GuideLevel } from "../display/Display.ts"
import { GuideItem } from "./GuideItem.ts"

/** What the guide shows for an entry at a level: its shelves, each a row of items in order. The ribbon has one. */
export type GuideShelves = (entry: GuideEntry, level: GuideLevel) => ReadonlyArray<ReadonlyArray<GuideItem>>

/**
 * The guide's shelves over today's `games`, each in watch order. All live: every league's live games, on one shelf at
 * either level. A league: in the ribbon its live then upcoming games; in the full guide three shelves, always, live
 * now, later today, and final. Custom has one empty shelf until there are custom streams.
 */
export function guideShelves(games: ReadonlyArray<ListedGame>): GuideShelves {
  return (entry, level) => {
    if (entry === "Custom") return [[]]
    if (entry === "AllLive") return [items({ progress: ["live"] }, games)]
    const league = [entry]
    if (level === "Ribbon") return [items({ league, progress: ["live", "upcoming"] }, games)]
    return [
      items({ league, progress: ["live"] }, games),
      items({ league, progress: ["upcoming"] }, games),
      items({ league, progress: ["over"] }, games)
    ]
  }
}

function items(query: Omit<GamesQuery, "date">, games: ReadonlyArray<ListedGame>): ReadonlyArray<GuideItem> {
  return GamesQuery.answer(query, games).map(({ snapshot }) => GuideItem.Game({ game: snapshot.id }))
}
```

- [ ] **Step 5: Run them to see them pass**

This needs Task 5's `GuideEntry` and `GuideLevel` types to compile. Do Task 5 Step 3 first, or run this step after it.

Run: `pnpm vitest run apps/web/src/guide/GuideShelves.test.ts`
Expected: PASS.

---

### Task 12 (phase 3, was task 5): The guide in the Display fold, its state atoms, and commit 3a

**Files:**
- Modify: `apps/web/src/display/Display.ts`, `apps/web/src/display/Display.test.ts`
- Modify: `apps/web/src/display/DisplayState.ts`, `apps/web/src/display/DisplayState.test.ts`
- Modify: `apps/web/src/display/DisplayView.tsx` (one mount), `apps/web/src/display/TopBar.tsx` (one line, until
  Task 11 deletes it), `apps/web/src/display/KeysDialog.tsx`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `GuideItem` and `GuideShelves` (Task 4), the new `Hotkey` cases (Task 1), `Shell.setGuideOpen` (Task 3).
- Produces:
  - `Overlay` case `Guide: { level: GuideLevel; entry: GuideEntry; focus: GuideFocus }`.
  - `export type GuideLevel = "Ribbon" | "Full"`.
  - `export type GuideEntry = "AllLive" | LeagueId | "Custom"`.
  - `export interface GuideFocus { readonly rail: boolean; readonly shelf: number; readonly item: number }`.
  - `Display.lastEntry: GuideEntry` (initially `"AllLive"`) and `static readonly guideEntries: ReadonlyArray<GuideEntry>`
    (`["AllLive", ...LeagueId.literals]`; phase 4 appends `"Custom"`).
  - `Display#apply(input, screen, shelves: GuideShelves)` and `Display#press(hotkey, screen, shelves: GuideShelves)`.
  - `DisplayInput` cases `GuideOpened({ entry })`, `GuideEntryChosen({ entry })`, `GuideItemChosen({ shelf, item })`.
  - `DisplayState.guideOpenSync`, a mounted atom that tells the Shell whether the overlay is a `Guide`.
  - `Display#shows` accepts `"Guide"`. `Display#open` takes only the overlays that need no arguments.

Guide rules, as the fold implements them:

- **`Guide`.** With nothing open, it opens the Ribbon on `lastEntry` (All live at first). From the Ribbon it opens
  Full, and Full stays Full. A level change keeps the focused item when the other level shows it; otherwise focus goes
  to the first item.
- **`Unsolo` (Esc).** Full goes back to the Ribbon, keeping the item. The Ribbon or any other overlay closes. With
  nothing open, it unsolos as before.
- **`Move` in the Ribbon.** Left and right move along the row, clamped. Up opens Full. Down does nothing.
- **`Move` in Full, on a shelf.** Left and right move along the shelf, clamped. Left on item 0 moves to the rail.
  Up and down go to the next shelf in that direction that has items, keeping the item index clamped, and stay put if
  there is none.
- **`Move` in Full, on the rail.** Up and down change the entry, clamped at both ends, and focus its first item while
  staying on the rail. Right leaves the rail. Left does nothing.
- **`NextEntry` / `PreviousEntry`.** These change the entry at either level, clamped at both ends, and focus the first
  item: the first shelf that has items.
- **`Confirm`.** On the rail, it leaves the rail. On a game, it follows the existing `choose` path and closes the guide.
  On an empty shelf, it does nothing.
- **`Info`.** It does nothing in phase 3; phase 6 opens the game page.
- **Focus clamps on every step.** A shelf index past the last becomes the last. An empty shelf gives way to the nearest
  shelf with items. The item stays within its shelf.
- **Closed guide.** `Move`, `Confirm`, `NextEntry`, `PreviousEntry` and `Info` do nothing while the guide is closed.

- [ ] **Step 1: Thread the shelves through the existing tests**

In `apps/web/src/display/Display.test.ts`:

1. Add `none` as the last argument of every `.press(` and every `.apply(` call. No test name or assertion changes.
   Run `pnpm vitest run apps/web/src/display/Display.test.ts` once Step 3 has landed: tsc reports any call that was
   missed.
2. Replace the imports and the trailing `const live` with:

```ts
import { assert, describe, it } from "@effect/vitest"
import type { Hotkey } from "@sportal/api/Hotkey"
import { TileKey } from "@sportal/api/TileKey"
import { GameId } from "@sportal/domain/Game"
import { Option } from "effect"
import { GuideItem } from "../guide/GuideItem.ts"
import type { GuideShelves } from "../guide/GuideShelves.ts"
import { Screen, type ScreenCommand } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import {
  Display,
  DisplayInput,
  DisplayStep,
  type GuideEntry,
  type GuideFocus,
  type GuideLevel,
  Overlay
} from "./Display.ts"
```

(Keep any other imports phase 2 added, such as `TileKey` if it is already there.)

```ts
const live = GameId.make("live")

/** No guide: every entry has no shelves. */
const none: GuideShelves = () => []

/** An empty Quad, for the guide's tests. */
const emptyQuad = TestWeb.withTiles([])

/** Today's guide for the guide's tests: NFL with all three shelves, FBS with an empty middle one, MLB with only later. */
const shelves: GuideShelves = (entry, level) => {
  switch (entry) {
    case "AllLive":
      return [[item("kc"), item("dal"), item("osu")]]
    case "nfl":
      return level === "Ribbon"
        ? [[item("kc"), item("dal"), item("sf")]]
        : [[item("kc"), item("dal")], [item("sf")], [item("nyj")]]
    case "fbs":
      return level === "Ribbon" ? [[item("osu")]] : [[item("osu")], [], [item("mich")]]
    case "mlb":
      return level === "Ribbon" ? [[item("nyy")]] : [[], [item("nyy")], []]
    default:
      return level === "Ribbon" ? [[]] : [[], [], []]
  }
}

function item(id: string): GuideItem {
  return GuideItem.Game({ game: GameId.make(id) })
}

/** The guide overlay at `level` on `entry`, focused at `focus` (the first item of the first shelf unless said). */
function guide(level: GuideLevel, entry: GuideEntry, focus: Partial<GuideFocus> = {}): Overlay {
  return Overlay.Guide({ level, entry, focus: { rail: false, shelf: 0, item: 0, ...focus } })
}

/** `display` after pressing `hotkeys` in order on an empty Quad, over `on`. */
function after(display: Display, hotkeys: ReadonlyArray<Hotkey>, on: GuideShelves = shelves): Display {
  return hotkeys.reduce((each, hotkey) => each.press(hotkey, emptyQuad, on).display, display)
}

function move(direction: "up" | "down" | "left" | "right"): Hotkey {
  return { _tag: "Move", direction }
}
```

3. Add this to `describe("Display.initial")`:

```ts
  it("should open the guide on All live first", () => {
    const display = Display.initial

    assert.strictEqual(display.lastEntry, "AllLive")
  })
```

- [ ] **Step 2: Write the failing guide tests**

Append to `apps/web/src/display/Display.test.ts`, before the trailing consts:

```ts
describe("Display#press in the guide", () => {
  it("should open the ribbon on All live with Guide when nothing is open", () => {
    const { display, commands } = Display.initial.press({ _tag: "Guide" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "AllLive"))
    assert.deepStrictEqual(commands, [])
  })

  it("should open the ribbon on the entry last shown", () => {
    const closed = after(Display.initial, [{ _tag: "Guide" }, { _tag: "NextEntry" }, { _tag: "Unsolo" }])

    const { display } = closed.press({ _tag: "Guide" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "nfl"))
  })

  it("should open the full guide with Guide from the ribbon", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.press({ _tag: "Guide" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
  })

  it("should keep the full guide open with Guide", () => {
    const full = after(Display.initial, [{ _tag: "Guide" }, { _tag: "Guide" }])

    const { display } = full.press({ _tag: "Guide" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
  })

  it("should open the full guide with up from the ribbon", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.press(move("up"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
  })

  it("should keep the focused game when the ribbon opens the full guide, on its own shelf", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }, { _tag: "NextEntry" }, move("right"), move("right")])

    const { display } = ribbon.press({ _tag: "Guide" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "nfl", { shelf: 1, item: 0 }))
  })

  it("should go back to the ribbon with Esc from the full guide, on the game it had focused", () => {
    const full = after(Display.initial, [{ _tag: "Guide" }, { _tag: "NextEntry" }, move("up"), move("down")])

    const { display, commands } = full.press({ _tag: "Unsolo" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "nfl", { item: 2 }))
    assert.deepStrictEqual(commands, [])
  })

  it("should close the ribbon with Esc and send no Unsolo, even while soloed", () => {
    const soloed = new Screen({ ...TestWeb.withTiles(["live"]), solo: Option.some(TileKey.game(live)) })
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display, commands } = ribbon.press({ _tag: "Unsolo" }, soloed, shelves)

    assert.strictEqual(display.overlay._tag, "None")
    assert.deepStrictEqual(commands, [])
  })

  it("should move along the ribbon with right", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.press(move("right"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "AllLive", { item: 1 }))
  })

  it("should stay on the ribbon's first chip with left", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.press(move("left"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "AllLive"))
  })

  it("should stay on the ribbon's last chip with right", () => {
    const last = after(Display.initial, [{ _tag: "Guide" }, move("right"), move("right")])

    const { display } = last.press(move("right"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "AllLive", { item: 2 }))
  })

  it("should do nothing with down in the ribbon", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.press(move("down"), emptyQuad, shelves)

    assert.strictEqual(display, ribbon)
  })

  it("should move along a shelf with right in the full guide", () => {
    const full = after(Display.initial, [{ _tag: "Guide" }, { _tag: "NextEntry" }, move("up")])

    const { display } = full.press(move("right"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "nfl", { item: 1 }))
  })

  it("should move with down to the next shelf with items, past an empty one", () => {
    const fbs = Display.initial.apply(DisplayInput.GuideOpened({ entry: "fbs" }), emptyQuad, shelves).display

    const { display } = fbs.press(move("down"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "fbs", { shelf: 2 }))
  })

  it("should keep the item's place, clamped, moving to a shorter shelf", () => {
    const second = after(Display.initial, [{ _tag: "Guide" }, { _tag: "NextEntry" }, move("up"), move("right")])

    const { display } = second.press(move("down"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "nfl", { shelf: 1, item: 0 }))
  })

  it("should stay on the last shelf with items with down", () => {
    const fbs = Display.initial.apply(DisplayInput.GuideOpened({ entry: "fbs" }), emptyQuad, shelves).display
    const last = after(fbs, [move("down")])

    const { display } = last.press(move("down"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "fbs", { shelf: 2 }))
  })

  it("should move to the rail with left on a shelf's first item", () => {
    const full = after(Display.initial, [{ _tag: "Guide" }, { _tag: "Guide" }])

    const { display } = full.press(move("left"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive", { rail: true }))
  })

  it("should change the entry with down on the rail, focused on its first item", () => {
    const rail = after(Display.initial, [{ _tag: "Guide" }, { _tag: "Guide" }, move("right"), move("left"), move("left")])

    const { display } = rail.press(move("down"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "nfl", { rail: true }))
  })

  it("should come back from the rail with right", () => {
    const rail = after(Display.initial, [{ _tag: "Guide" }, { _tag: "Guide" }, move("left")])

    const { display } = rail.press(move("right"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
  })

  it("should change the entry with NextEntry, focused on its first item", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }, move("right")])

    const { display } = ribbon.press({ _tag: "NextEntry" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "nfl"))
  })

  it("should change the entry with PreviousEntry in the full guide", () => {
    const nfl = Display.initial.apply(DisplayInput.GuideOpened({ entry: "nfl" }), emptyQuad, shelves).display

    const { display } = nfl.press({ _tag: "PreviousEntry" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
  })

  it("should stay on the last entry with NextEntry", () => {
    const nba = Display.initial.apply(DisplayInput.GuideOpened({ entry: "nba" }), emptyQuad, shelves).display

    const { display } = nba.press({ _tag: "NextEntry" }, emptyQuad, shelves)

    assert.strictEqual(display, nba)
  })

  it("should focus a new entry's first shelf with items", () => {
    const fbs = Display.initial.apply(DisplayInput.GuideOpened({ entry: "fbs" }), emptyQuad, shelves).display

    const { display } = fbs.press({ _tag: "NextEntry" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "mlb", { shelf: 1 }))
  })

  it("should watch the focused game with Confirm and close the guide", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }, move("right")])

    const { display, commands } = ribbon.press({ _tag: "Confirm" }, emptyQuad, shelves)

    assert.strictEqual(display.overlay._tag, "None")
    assert.deepStrictEqual(commands, [{ _tag: "Assign", tile: 0, game: GameId.make("dal") }])
  })

  it("should watch the last game with Confirm once the focus is past what its shelf now holds", () => {
    const third = after(Display.initial, [{ _tag: "Guide" }, { _tag: "NextEntry" }, move("right"), move("right")])
    const fewer: GuideShelves = () => [[item("kc")]]

    const { commands } = third.press({ _tag: "Confirm" }, emptyQuad, fewer)

    assert.deepStrictEqual(commands, [{ _tag: "Assign", tile: 0, game: GameId.make("kc") }])
  })

  it("should leave the rail with Confirm on it", () => {
    const rail = after(Display.initial, [{ _tag: "Guide" }, { _tag: "Guide" }, move("left")])

    const { display, commands } = rail.press({ _tag: "Confirm" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
    assert.deepStrictEqual(commands, [])
  })

  it("should do nothing with Confirm on an entry with no games", () => {
    const nba = Display.initial.apply(DisplayInput.GuideOpened({ entry: "nba" }), emptyQuad, shelves).display

    const { display, commands } = nba.press({ _tag: "Confirm" }, emptyQuad, shelves)

    assert.strictEqual(display, nba)
    assert.deepStrictEqual(commands, [])
  })

  it.each<Hotkey>([move("down"), { _tag: "Confirm" }, { _tag: "NextEntry" }, { _tag: "PreviousEntry" }, { _tag: "Info" }])(
    "should do nothing with $_tag while the guide is closed",
    (hotkey) => {
      const { display, commands } = Display.initial.press(hotkey, emptyQuad, shelves)

      assert.strictEqual(display, Display.initial)
      assert.deepStrictEqual(commands, [])
    }
  )
})

describe("Display#apply in the guide", () => {
  it("should open the full guide on an entry", () => {
    const { display } = Display.initial.apply(DisplayInput.GuideOpened({ entry: "mlb" }), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "mlb", { shelf: 1 }))
  })

  it("should change the entry at the ribbon's own level when one is clicked", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.apply(DisplayInput.GuideEntryChosen({ entry: "fbs" }), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "fbs"))
  })

  it("should open the full guide on an entry clicked while the guide is closed", () => {
    const { display } = Display.initial.apply(DisplayInput.GuideEntryChosen({ entry: "fbs" }), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "fbs"))
  })

  it("should watch a clicked game and close the guide", () => {
    const nfl = Display.initial.apply(DisplayInput.GuideOpened({ entry: "nfl" }), emptyQuad, shelves).display

    const { display, commands } = nfl.apply(DisplayInput.GuideItemChosen({ shelf: 2, item: 0 }), emptyQuad, shelves)

    assert.strictEqual(display.overlay._tag, "None")
    assert.deepStrictEqual(commands, [{ _tag: "Assign", tile: 0, game: GameId.make("nyj") }])
  })
})
```

How the arranged states work out, for the reviewer:

- "should change the entry with down on the rail" goes to Full on All live, item 1 (dal), item 0 (kc), and then the
  rail, so its starting overlay is `{ rail: true, shelf: 0, item: 0 }` on All live.
- In the `shelves` fixture, `nba` is the last entry, because `guideEntries` is `AllLive, nfl, fbs, mlb, nba`.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run apps/web/src/display/Display.test.ts`
Expected: FAIL to compile. `Overlay.Guide`, `GuideFocus`, `lastEntry` and `GuideOpened` do not exist, and `press` and
`apply` take two arguments.

- [ ] **Step 4: Write the fold**

Edit `apps/web/src/display/Display.ts` as follows. Lines phase 2 wrote (the `TileKey` fields, `interactingOn`,
`VideoPressed({ key })`) stay exactly as phase 2 left them.

1. Imports: add `LeagueId` from `@sportal/domain/League`, `Equal` to the `effect` import,
   `import { GuideItem } from "../guide/GuideItem.ts"`, and `import type { GuideShelves } from "../guide/GuideShelves.ts"`.

2. Replace the `Overlay` type with:

```ts
/** The one overlay a Display has open, or none. Above the class: `Display.initial` reads it when the class is defined. */
export type Overlay = Data.TaggedEnum<{
  None: object
  Keys: object
  Palette: object
  JoinRemote: object
  /** The guide, at its level, on its entry, with its focus. */
  Guide: { readonly level: GuideLevel; readonly entry: GuideEntry; readonly focus: GuideFocus }
}>
```

3. Add this field to the class, after `overlay`:

```ts
  /** The guide entry last shown; the guide opens on it. */
  readonly lastEntry: GuideEntry
```

   Then make `initial`:

```ts
  /** Slot 0, nothing interacting, no overlay, and the guide to open on All live. */
  static readonly initial = new Display({
    selected: 0,
    interacting: undefined,
    overlay: Overlay.None(),
    lastEntry: "AllLive"
  })

  /** The guide's entries, in the rail's order: every league's live games, then each league. */
  static readonly guideEntries: ReadonlyArray<GuideEntry> = ["AllLive", ...LeagueId.literals]
```

4. Replace `apply` with:

```ts
  /** What an input does on this Screen, with the guide's shelves as they are now. */
  apply(input: DisplayInput, screen: Screen, shelves: GuideShelves): DisplayStep {
    return DisplayInput.$match(input, {
      Pressed: ({ hotkey }) => this.press(hotkey, screen, shelves),
      Selected: ({ slot }) => this.select(slot, screen),
      VideoPressed: ({ key }) => {
        const slot = screen.slotOf(key)
        return slot === undefined ? DisplayStep.of(this) : this.select(slot, screen)
      },
      Chosen: ({ game }) => this.choose(game, screen),
      Commanded: ({ command }) => DisplayStep.of(this, [command]),
      Opened: ({ overlay }) => DisplayStep.of(this.open(overlay)),
      Closed: () => DisplayStep.of(this.close()),
      GuideOpened: ({ entry }) => DisplayStep.of(this.guide("Full", entry, start, shelves)),
      GuideEntryChosen: ({ entry }) => DisplayStep.of(this.chooseEntry(entry, shelves)),
      GuideItemChosen: ({ shelf, item }) => this.confirm({ rail: false, shelf, item }, screen, shelves)
    })
  }
```

5. Change `press`'s signature, doc and the guide entries in its `Hotkey.match`:

```ts
  /**
   * What a hotkey does. `FullScreen` does nothing here: it is the shell's or browser's. `Info` waits for the game page.
   */
  press(hotkey: Hotkey, screen: Screen, shelves: GuideShelves): DisplayStep {
    return Hotkey.match(hotkey, {
```

   Replace the `Unsolo` entry with `Unsolo: () => this.escape(screen, shelves),`. After `FullScreen`, add:

```ts
      Guide: () => DisplayStep.of(this.guideUp(shelves)),
      Move: ({ direction }) => DisplayStep.of(this.move(direction, shelves)),
      Confirm: () => this.confirm(undefined, screen, shelves),
      NextEntry: () => DisplayStep.of(this.nextEntry(1, shelves)),
      PreviousEntry: () => DisplayStep.of(this.nextEntry(-1, shelves)),
      Info: () => DisplayStep.of(this)
```

6. Change `shows` so it accepts the guide:

```ts
  /** Whether this overlay is the one open. */
  shows(overlay: Exclude<Overlay["_tag"], "None">): boolean {
    return Overlay.$is(overlay)(this.overlay)
  }
```

7. After `close()`, add the guide's steps:

```ts
  /** `G`: closed, the ribbon opens on the entry last shown; the ribbon opens the full guide, which stays open. */
  private guideUp(shelves: GuideShelves): Display {
    const overlay = this.overlay
    return Overlay.$is("Guide")(overlay)
      ? this.relevel(overlay, "Full", shelves)
      : this.guide("Ribbon", this.lastEntry, start, shelves)
  }

  /** Esc: the full guide goes back to the ribbon; the ribbon or any other overlay closes; with none open, it unsolos. */
  private escape(screen: Screen, shelves: GuideShelves): DisplayStep {
    const overlay = this.overlay
    if (Overlay.$is("Guide")(overlay) && overlay.level === "Full")
      return DisplayStep.of(this.relevel(overlay, "Ribbon", shelves))
    if (!Overlay.$is("None")(overlay)) return DisplayStep.of(this.close())
    return DisplayStep.of(this, Option.isNone(screen.solo) ? [] : [{ _tag: "Unsolo" }])
  }

  /**
   * An arrow in the open guide. In the ribbon, left and right move along its row and up opens the full guide. In the
   * full guide, up and down move to the next shelf with items and left and right along a shelf; left from a shelf's
   * first item goes to the rail, where up and down change the entry and right comes back. With the guide closed,
   * nothing.
   */
  private move(direction: "up" | "down" | "left" | "right", shelves: GuideShelves): Display {
    const overlay = this.overlay
    if (!Overlay.$is("Guide")(overlay)) return this
    const { level, entry } = overlay
    const focus = clamped(overlay.focus, shelves(entry, level))
    const along = direction === "left" ? -1 : 1

    if (level === "Ribbon") {
      if (direction === "up") return this.relevel(overlay, "Full", shelves)
      return direction === "down" ? this : this.guide(level, entry, { ...focus, item: focus.item + along }, shelves)
    }
    if (focus.rail) {
      if (direction === "right") return this.guide(level, entry, { ...focus, rail: false }, shelves)
      return direction === "left" ? this : this.nextEntry(direction === "up" ? -1 : 1, shelves)
    }
    if (direction === "left" && focus.item === 0) return this.guide(level, entry, { ...focus, rail: true }, shelves)
    if (direction === "left" || direction === "right")
      return this.guide(level, entry, { ...focus, item: focus.item + along }, shelves)
    const shelf = nextFilled(shelves(entry, level), focus.shelf, direction === "up" ? -1 : 1)
    return shelf === undefined ? this : this.guide(level, entry, { ...focus, shelf }, shelves)
  }

  /**
   * `]` or `[` (`step` 1 or -1), or up and down on the rail: the open guide on the entry `step` from its own in the
   * rail's order, at the same level and on or off the rail as it was, focused on the entry's first item. Past either
   * end it stays; with the guide closed, nothing.
   */
  private nextEntry(step: 1 | -1, shelves: GuideShelves): Display {
    const overlay = this.overlay
    if (!Overlay.$is("Guide")(overlay)) return this
    const entries = Display.guideEntries
    const index = Math.min(Math.max(entries.indexOf(overlay.entry) + step, 0), entries.length - 1)
    const entry = entries[index] ?? overlay.entry
    if (entry === overlay.entry) return this
    return this.guide(overlay.level, entry, { ...start, rail: overlay.focus.rail }, shelves)
  }

  /** A click on an entry: the guide on it at the level open, or the full guide when none is, on its first item. */
  private chooseEntry(entry: GuideEntry, shelves: GuideShelves): Display {
    const overlay = this.overlay
    const level = Overlay.$is("Guide")(overlay) ? overlay.level : "Full"
    return this.guide(level, entry, start, shelves)
  }

  /**
   * Enter, or a click on the item at `at`: on the rail it leaves the rail; on a game it watches the game as `choose`
   * does and closes the guide. With the guide closed, or nothing there, nothing.
   */
  private confirm(at: GuideFocus | undefined, screen: Screen, shelves: GuideShelves): DisplayStep {
    const overlay = this.overlay
    if (!Overlay.$is("Guide")(overlay)) return DisplayStep.of(this)
    const shown = shelves(overlay.entry, overlay.level)
    const focus = clamped(at ?? overlay.focus, shown)
    if (focus.rail)
      return DisplayStep.of(this.guide(overlay.level, overlay.entry, { ...focus, rail: false }, shelves))
    const item = shown[focus.shelf]?.[focus.item]
    if (item === undefined) return DisplayStep.of(this)
    return GuideItem.$match(item, { Game: ({ game }) => this.close().choose(game, screen) })
  }

  /**
   * The guide at `level` on `entry`, focused on `focus` as far as the entry's shelves allow (never the rail in the
   * ribbon); `entry` is the one the guide opens on next.
   */
  private guide(level: GuideLevel, entry: GuideEntry, focus: GuideFocus, shelves: GuideShelves): Display {
    const asked = level === "Ribbon" ? { ...focus, rail: false } : focus
    const at = clamped(asked, shelves(entry, level))
    return new Display({ ...this, lastEntry: entry, overlay: Overlay.Guide({ level, entry, focus: at }) })
  }

  /** The open guide at `level` instead, on the item it had focused when that level shows it, else on its first. */
  private relevel(open: GuideOpen, level: GuideLevel, shelves: GuideShelves): Display {
    const shown = shelves(open.entry, open.level)
    const focus = clamped(open.focus, shown)
    const item = focus.rail ? undefined : shown[focus.shelf]?.[focus.item]
    const found = item === undefined ? undefined : focusOf(item, shelves(open.entry, level))
    return this.guide(level, open.entry, found ?? start, shelves)
  }
```

8. Replace `type OpenOverlay` with these member types, keeping them in the same place below the class:

```ts
/** An overlay that opens with no more to say: any but `None` and the guide, which opens at a level on an entry. */
type OpenOverlay = Exclude<Overlay["_tag"], "None" | "Guide">

/** Which level of the guide is open: the ribbon docked under the Screen, or the full guide over the whole Display. */
export type GuideLevel = "Ribbon" | "Full"

/** An entry of the guide's rail: every league's live games, one league, or the custom streams. */
export type GuideEntry = "AllLive" | LeagueId | "Custom"

/** Where the open guide's focus is: on the rail, or on item `item` of shelf `shelf` (the ribbon's row is shelf 0). */
export interface GuideFocus {
  readonly rail: boolean
  readonly shelf: number
  readonly item: number
}

/** The guide as the open overlay. */
type GuideOpen = Data.TaggedEnum.Value<Overlay, "Guide">
```

9. Add these cases to `DisplayInput`, after `Closed: object`, and widen its doc to "…, an overlay opened or closed, or
   the guide clicked":

```ts
  /** The full guide opened on `entry`, by a click. */
  GuideOpened: { readonly entry: GuideEntry }
  /** An entry clicked in the guide's rail or the ribbon's tabs. */
  GuideEntryChosen: { readonly entry: GuideEntry }
  /** An item clicked on a shelf of the open guide. */
  GuideItemChosen: { readonly shelf: number; readonly item: number }
```

10. At the end of the file, add the private helpers, in the order they are first used:

```ts
/** Off the rail, on the first item of the first shelf. */
const start: GuideFocus = { rail: false, shelf: 0, item: 0 }

/**
 * `focus` on what `shelves` hold: a shelf past the last is the last, an empty shelf gives way to the nearest one with
 * items (the later one on a tie), and the item stays within its shelf.
 */
function clamped(focus: GuideFocus, shelves: ReadonlyArray<ReadonlyArray<GuideItem>>): GuideFocus {
  const asked = Math.max(0, Math.min(focus.shelf, shelves.length - 1))
  const shelf = nearestFilled(shelves, asked) ?? asked
  const length = shelves[shelf]?.length ?? 0
  return { rail: focus.rail, shelf, item: Math.max(0, Math.min(focus.item, length - 1)) }
}

/** The shelf with items nearest `from`: `from` itself first, then outward, the later one on a tie. */
function nearestFilled(shelves: ReadonlyArray<ReadonlyArray<GuideItem>>, from: number): number | undefined {
  for (let distance = 0; distance < shelves.length; distance++)
    for (const shelf of [from + distance, from - distance])
      if ((shelves[shelf]?.length ?? 0) > 0) return shelf
  return undefined
}

/** Where `item` is on `shelves`, if it is there. */
function focusOf(item: GuideItem, shelves: ReadonlyArray<ReadonlyArray<GuideItem>>): GuideFocus | undefined {
  for (const [shelf, items] of shelves.entries()) {
    const at = items.findIndex((each) => Equal.equals(each, item))
    if (at >= 0) return { rail: false, shelf, item: at }
  }
  return undefined
}

/** The next shelf with items after `from`, going `step` (1 down, -1 up); none past either end. */
function nextFilled(
  shelves: ReadonlyArray<ReadonlyArray<GuideItem>>,
  from: number,
  step: 1 | -1
): number | undefined {
  for (let shelf = from + step; shelf >= 0 && shelf < shelves.length; shelf += step)
    if ((shelves[shelf]?.length ?? 0) > 0) return shelf
  return undefined
}
```

`Equal.equals` compares a `GuideItem`'s plain objects structurally (`effect/src/Equal.ts`: "plain objects compare
enumerable keys recursively").

- [ ] **Step 5: Run the fold's tests to see them pass**

Run: `pnpm vitest run apps/web/src/display/Display.test.ts apps/web/src/guide/GuideShelves.test.ts`
Expected: PASS.

- [ ] **Step 6: Give the Display's atom the shelves, and tell the shell**

In `apps/web/src/display/DisplayState.ts`:

1. Imports: add `import * as GuideShelves from "../guide/GuideShelves.ts"` and `import * as Games from "../hub/Games.ts"`.

2. In `display`'s writer, replace the `const step` line with:

```ts
    const step = ctx.get(kept).apply(input, ctx.get(DisplayScreen.screen), ctx.get(shelves))
```

3. After `openSignIn`, add:

```ts
/**
 * Tells the shell whether the guide is open, each time that changes: while it is, the arrows and Enter are the guide's,
 * and while it is closed a player keeps them. Mounted once, by the Display.
 */
export const guideOpenSync = runtime.atom((get) =>
  Effect.gen(function* () {
    const shell = yield* Shell

    yield* get.stream(guideOpen).pipe(Stream.changes, Stream.runForEach(shell.setGuideOpen))
  }).pipe(logDefect("The guide-open sync"))
)
```

4. After `const kept`, add:

```ts
/** The guide's shelves over today's games: every entry empty before the first answer. */
const shelves: Atom.Atom<GuideShelves.GuideShelves> = Atom.make((get) => {
  const games = Option.match(get(Games.today).value, { onNone: () => [], onSome: ({ games }) => games })
  return GuideShelves.guideShelves(games)
})

const guideOpen = Atom.make((get) => get(display).shows("Guide"))
```

   Both consts are read only lazily (inside the writer and the generator), so they can sit below their users, as
   `kept` already does.

5. Add this test to `apps/web/src/display/DisplayState.test.ts`. Import `Equal` and `Option` from `effect`. Add
   `Option` to the existing `effect` import if it is not there.

```ts
  it.effect("should tell the shell once the guide is open", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.guideOpenSync)
        yield* Atom.set(DisplayState.display, DisplayInput.Pressed({ hotkey: { _tag: "Guide" } }))
        return yield* Stream.fromQueue(calls).pipe(
          Stream.filter((each) => Equal.equals(each, { _tag: "SetGuideOpen", on: true })),
          Stream.runHead
        )
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, Option.some({ _tag: "SetGuideOpen", on: true }))
    })
  )
```

- [ ] **Step 7: Mount the sync, keep the top bar compiling, and list the Guide keys**

In `apps/web/src/display/DisplayView.tsx`, add `useAtomMount(DisplayState.guideOpenSync)` after
`useAtomMount(DisplayState.inputs)`.

In `apps/web/src/display/TopBar.tsx`, replace the `soloToggles` line with this one. The top bar has no shelves, and
Task 11 deletes the file:

```ts
  const soloToggles =
    Option.isSome(screen.solo) || !Tile.guards.Empty(screen.onScreen()[display.selectedOn(screen)])
```

and add `import { Tile } from "../screen/Screen.ts"`.

In `apps/web/src/display/KeysDialog.tsx`, read the groups from the table instead of a fixed list. Replace
`{(["Tiles", "Screen"] as const).map((group) => (` with:

```tsx
        {[...new Set(Hotkey.keys.map((binding) => binding.group))].map((group) => (
```

- [ ] **Step 8: Add the `CONTEXT.md` rows**

In `CONTEXT.md`'s **Viewing** table, after **Overlay**'s neighbours (keep the table's order by concept), add:

```markdown
| **Guide level** | Which level of a Display's guide is open: the **ribbon** (league tabs over one row of a league's live then upcoming games, docked under the Screen, which shrinks above it) or the **full guide** (over the whole Display: the rail of guide entries, and the entry's shelves); `GuideLevel` beside `Display`. A Display's guide shows games by league; it is not a source's **Guide**. | menu, EPG |
| **Guide entry** | One entry of the guide's rail: All live, a league, or Custom; `GuideEntry` beside `Display`, in the rail's order `Display.guideEntries`. The guide opens on the one last shown (`lastEntry`). | tab, category |
| **Guide focus** | Where the open guide's focus is: on the rail, or on one item of one shelf; `GuideFocus` beside `Display`. Arrows move it, and every step clamps it to what the shelves hold. | cursor, selection |
| **Guide shelves** | What the guide shows for an entry at a level: rows of guide items from today's games (live now, later today, final, for a league in the full guide); `GuideShelves` in `apps/web/src/guide/GuideShelves.ts`, built by `guideShelves`, given to the Display's fold. | rows, lists |
| **Guide item** | One thing on a guide shelf: a game, for now; `GuideItem` in `apps/web/src/guide/GuideItem.ts`. | card, tile |
```

Then update these existing rows:

- **Overlay**: "The one overlay a Display has open — the key help, the command palette, Join Remote, or the guide (at
  its level, on its entry, with its focus) — or none; …" (the rest unchanged).
- **Display input**: insert ", the guide opened, an entry or an item clicked in it" before ", a screen command".
- **Hotkey**: append "The guide's keys (arrows, Enter, `[`, `]`, `I`) are read only while the guide is open; `G` always."
- **Shell**: insert ", whether the guide is open (`setGuideOpen`)" after "presses on a video".
- **Tile views**: append "While the web UI says the guide is open, a view's guide keys are hotkeys, not the player's."

- [ ] **Step 9: Run the full check**

```bash
pnpm format
pnpm check
```

Expected: PASS. If `knip --production` flags anything, it is an export Task 5 meant to keep private (`shelves`,
`guideOpen`). Make that one private, without `export`.

- [ ] **Step 10: Commit 3a**

```bash
git add packages/api/src/Hotkey.ts packages/api/src/Hotkey.test.ts packages/api/src/ShellBridge.ts \
  packages/api/src/ShellChannel.ts apps/desktop/src/preload/ShellBridge.ts apps/desktop/src/main/main.ts \
  apps/desktop/src/main/TileViews.ts apps/desktop/src/main/TileViews.test.ts apps/web/src/shell/Shell.ts \
  apps/web/src/shell/Shell.test.ts apps/web/src/guide apps/web/src/display/Display.ts \
  apps/web/src/display/Display.test.ts apps/web/src/display/DisplayState.ts apps/web/src/display/DisplayState.test.ts \
  apps/web/src/display/DisplayView.tsx apps/web/src/display/TopBar.tsx apps/web/src/display/KeysDialog.tsx CONTEXT.md
git commit -F - <<'EOF'
feat: the guide's keys and state

The Display's guide by league, as state: G opens the ribbon on the entry
last shown, G or up again the full guide, Esc steps back down. Arrows move
along the ribbon, across and between a full guide's shelves and onto its
rail; ] and [ change the entry; Enter watches the focused game in the
selected tile as the palette chooses, and closes the guide. Focus clamps to
what the shelves hold. Display.apply and press take the guide's shelves
(guideShelves over today's games) so the fold stays pure.

Hotkey gains Guide, Move, Confirm, NextEntry, PreviousEntry and Info;
Hotkey.of takes guideOpen and maps the arrows, Enter, the brackets and I
only while it holds (I is Interact otherwise). The web Shell gains
setGuideOpen, followed from the Display's overlay by
DisplayState.guideOpenSync; the browser layer reads the flag for page keys,
and the shell bridge passes it to the desktop's TileViews, so a player keeps
its arrows while the guide is closed. The key help lists the Guide group
from Hotkey.keys.

Nothing draws the guide yet.

Rewritten tests, old name -> new:

apps/web/src/display/Display.test.ts
- Every test keeps its name and assertions; each press and apply call takes
  the guide's shelves (`none`) as a new last argument.

packages/api/src/Hotkey.test.ts
- Every test keeps its name and assertions; the `key` helper and the
  Hotkey.keys read-back pass guideOpen: false.

apps/web/src/shell/Shell.test.ts
- Every test keeps its name and assertions; firstHotkey listens through a
  new firstOf(shell), which the guide tests share.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 13 (phase 3, was task 6): Themes in `theme.css`, and the theme atom

**Files:**
- Modify: `apps/web/src/theme.css`
- Create: `apps/web/src/ui/Theme.ts`, `apps/web/src/ui/Theme.test.ts`

**Interfaces:**
- Produces:
  - `ThemeName = Schema.Literals(["glass", "team"])` and `type ThemeName`.
  - `theme: Atom.Writable<ThemeName>`, kept under `localStorage` `sportal.theme`.
  - `useTheme(): ThemeName`, which also sets `data-theme` on `document.documentElement`.
  - Tokens `--guide`, `--guide-rail`, `--guide-blur`, `--card-surface`, `--card-edge`, `--card-footer`,
    `--card-radius`, `--focus-outline`, `--focus-outline-width`, `--focus-offset`, `--focus-scale`, `--focus-shadow`.
  - Tailwind names `bg-guide`, `bg-guide-rail`, `border-card-edge`, `bg-card-footer` and `rounded-card`.
  - Utility `guide-focus`, which reads `data-focused="true"`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/ui/Theme.test.ts`:

```ts
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as TestWeb from "../TestWeb.ts"
import * as Theme from "./Theme.ts"

describe("Theme.theme", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should read Glass when no theme is kept", () =>
    Effect.gen(function* () {
      const theme = yield* Atom.get(Theme.theme).pipe(Effect.provide(AtomRegistry.layer))

      assert.strictEqual(theme, "glass")
    })
  )

  it.effect("should read Glass when what is kept is not a theme", () =>
    Effect.gen(function* () {
      localStorage.setItem("sportal.theme", JSON.stringify("neon"))

      const theme = yield* Atom.get(Theme.theme).pipe(Effect.provide(AtomRegistry.layer))

      assert.strictEqual(theme, "glass")
    })
  )

  it.effect("should read the theme kept in this browser", () =>
    Effect.gen(function* () {
      localStorage.setItem("sportal.theme", JSON.stringify("team"))

      const theme = yield* Atom.get(Theme.theme).pipe(Effect.provide(AtomRegistry.layer))

      assert.strictEqual(theme, "team")
    })
  )

  it.effect("should keep a chosen theme in this browser", () =>
    Effect.gen(function* () {
      yield* Atom.set(Theme.theme, "team").pipe(Effect.provide(AtomRegistry.layer))

      const kept = localStorage.getItem("sportal.theme") ?? ""

      assert.include(kept, "team")
    })
  )
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/web/src/ui/Theme.test.ts`
Expected: FAIL. `./Theme.ts` does not exist.

- [ ] **Step 3: Write `Theme.ts`**

`Atom.kvs` falls back to `defaultValue` when the stored value does not decode or the store fails
(`effect/src/reactivity/Atom.ts`: the sync read keeps the default unless the store's read succeeds with a value), as
`DisplayScreen`'s kept Screen already relies on.

```ts
import { useAtomValue } from "@effect/atom-react"
import { Schema } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import { useEffect } from "react"

/** The two looks a Display has: Glass, translucent and soft, the default; and Team, painted in the teams' colors. */
export const ThemeName = Schema.Literals(["glass", "team"])
export type ThemeName = typeof ThemeName.Type

/**
 * This Display's theme, kept in this browser under `sportal.theme`. Glass until another is chosen, and Glass when what
 * is kept is not a theme or the browser's storage cannot be read.
 */
export const theme: Atom.Writable<ThemeName> = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: "sportal.theme",
  schema: ThemeName,
  defaultValue: (): ThemeName => "glass"
}).pipe(Atom.keepAlive)

/** This Display's theme, set on the document as `data-theme` so the theme's tokens in `theme.css` apply. */
export function useTheme(): ThemeName {
  const name = useAtomValue(theme)
  useEffect(() => {
    document.documentElement.dataset.theme = name
  }, [name])
  return name
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run apps/web/src/ui/Theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the theme blocks to `theme.css`**

In `apps/web/src/theme.css`, after the `:root { … }` block (which stays as the shared base), add:

```css
/*
 * Glass, the default: translucent blurred surfaces, soft rounded cards with full team names and a thin edge in the two
 * teams' colors; the focused card lifts and grows.
 */
:root[data-theme="glass"] {
  --background: oklch(0.135 0.008 262);
  --card: oklch(0.2 0.008 262 / 0.82);
  --popover: oklch(0.2 0.008 262 / 0.94);
  --border: oklch(1 0 0 / 0.09);

  --guide: oklch(0.15 0.008 262 / 0.8);
  --guide-rail: oklch(0.12 0.008 262 / 0.55);
  --guide-blur: 18px;
  --card-surface: linear-gradient(180deg, oklch(1 0 0 / 0.07), oklch(1 0 0 / 0.025));
  --card-edge: oklch(1 0 0 / 0.08);
  --card-footer: transparent;
  --card-radius: 14px;
  --focus-outline: oklch(1 0 0 / 0.35);
  --focus-outline-width: 1px;
  --focus-offset: 0px;
  --focus-scale: 1.04;
  --focus-shadow: 0 10px 30px oklch(0 0 0 / 0.5);
}

/*
 * Team: opaque graphite; a card is split into two halves painted in each team's color, with big logos and scores over a
 * dark footer; focus is a white outline.
 */
:root[data-theme="team"] {
  --card: oklch(0.18 0.004 260);

  --guide: oklch(0.13 0.004 260 / 0.97);
  --guide-rail: oklch(0.11 0.004 260);
  --guide-blur: 0px;
  --card-surface: oklch(0.19 0.005 260);
  --card-edge: transparent;
  --card-footer: oklch(0.14 0.004 260);
  --card-radius: 10px;
  --focus-outline: oklch(1 0 0);
  --focus-outline-width: 3px;
  --focus-offset: 2px;
  --focus-scale: 1;
  --focus-shadow: none;
}
```

In `@theme inline`, after `--color-well: var(--well);`, add:

```css
  --color-guide: var(--guide);
  --color-guide-rail: var(--guide-rail);
  --color-card-edge: var(--card-edge);
  --color-card-footer: var(--card-footer);
  --radius-card: var(--card-radius);
```

After the `label-caps` utility, add:

```css
/* A guide card, chip or rail entry: the theme says how the one with focus shows. Focus moves animate, unless reduced. */
@utility guide-focus {
  outline: var(--focus-outline-width, 2px) solid transparent;
  outline-offset: var(--focus-offset, 2px);
  transition:
    transform 100ms ease-out,
    box-shadow 100ms ease-out,
    outline-color 100ms ease-out;
  &[data-focused="true"] {
    outline-color: var(--focus-outline, var(--ring));
    transform: scale(var(--focus-scale, 1));
    box-shadow: var(--focus-shadow, none);
  }
  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
}
```

The tile chrome (`bg-card`, `border`) and the data tile's scoreboard read `--card`, `--border` and `--background`, so
the theme blocks restyle them with no change to their structure.

---

### Task 14 (phase 3, was task 7): Team colors

**Files:**
- Create: `apps/web/src/game/TeamColors.ts`, `apps/web/src/game/TeamColors.test.ts`

**Interfaces:**
- Produces:
  - `teamColor(team: Team): string`, a CSS `#rrggbb`.
  - `teamEdge(game: GameSnapshot): string`, the Glass edge.
  - `teamHalf(team: Team, side: "home" | "away"): string`, the Team half's paint.
- Consumes: `Team.color` and `Team.alternateColor`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/game/TeamColors.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { snapshot, team } from "@sportal/domain/TestGame"
import { Team } from "@sportal/domain/Team"
import * as TeamColors from "./TeamColors.ts"

describe("TeamColors.teamColor", () => {
  it("should paint a team in its own color when it shows on a dark surface", () => {
    const chiefs = colored("E31837")

    const color = TeamColors.teamColor(chiefs)

    assert.strictEqual(color, "#e31837")
  })

  it("should paint a team too dark to see in its alternate color", () => {
    const bears = colored("0B162A", "C83803")

    const color = TeamColors.teamColor(bears)

    assert.strictEqual(color, "#c83803")
  })

  it("should lighten a team too dark to see that has no alternate color", () => {
    const navy = colored("0B162A")

    const color = TeamColors.teamColor(navy)

    assert.strictEqual(color, "#545c6a")
  })

  it("should lighten a team whose alternate color is too dark as well", () => {
    const night = colored("0B162A", "000000")

    const color = TeamColors.teamColor(night)

    assert.strictEqual(color, "#545c6a")
  })

  it("should paint a team with no color in graphite", () => {
    const plain = team("ZZZ", "nfl")

    const color = TeamColors.teamColor(plain)

    assert.strictEqual(color, "#3a3d44")
  })

  it("should paint a team whose color does not read as six hex digits in graphite", () => {
    const odd = colored("red")

    const color = TeamColors.teamColor(odd)

    assert.strictEqual(color, "#3a3d44")
  })
})

describe("TeamColors.teamEdge", () => {
  it("should split the edge between the away team's color above and the home team's below", () => {
    const game = snapshot({ away: { team: colored("E31837"), score: 0 }, home: { team: colored("00338D"), score: 0 } })

    const edge = TeamColors.teamEdge(game)

    assert.strictEqual(edge, "linear-gradient(#e31837 50%, #00338d 50%)")
  })
})

describe("TeamColors.teamHalf", () => {
  it("should paint a half from the team's color to a darker one, the away half leaning the other way", () => {
    const chiefs = colored("E31837")

    const half = TeamColors.teamHalf(chiefs, "away")

    assert.strictEqual(half, "linear-gradient(160deg, #e31837, color-mix(in oklab, #e31837 55%, black))")
  })
})

function colored(color: string, alternateColor?: string): Team {
  const plain = team("TM", "nfl")
  return alternateColor === undefined ? new Team({ ...plain, color }) : new Team({ ...plain, color, alternateColor })
}
```

The expected values were computed with the WCAG relative-luminance formula. `E31837` has a luminance of 0.173.
`0B162A` has 0.008, and mixing it 30% toward white gives `#545c6a`. `C83803` has 0.151, and `000000` has 0.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/web/src/game/TeamColors.test.ts`
Expected: FAIL. `./TeamColors.ts` does not exist.

- [ ] **Step 3: Write `TeamColors.ts`**

```ts
import type { GameSnapshot } from "@sportal/domain/Game"
import type { Team } from "@sportal/domain/Team"

/**
 * The color to paint `team` in on Sportal's dark surfaces, as CSS: its own color; or, when that is too dark to see
 * (relative luminance under 0.03), its alternate color when that one is not, else its own color lightened. A neutral
 * graphite for a team with no color.
 */
export function teamColor(team: Team): string {
  const color = rgbOf(team.color)
  if (color === undefined) return graphite
  if (luminance(color) >= darkest) return css(color)
  const alternate = rgbOf(team.alternateColor)
  return alternate !== undefined && luminance(alternate) >= darkest ? css(alternate) : css(lightened(color))
}

/** A Glass card's thin edge: the away team's color above, the home team's below. */
export function teamEdge(game: GameSnapshot): string {
  return `linear-gradient(${teamColor(game.away.team)} 50%, ${teamColor(game.home.team)} 50%)`
}

/** A Team card's half for `team`: its color running darker, the away half leaning left and the home half right. */
export function teamHalf(team: Team, side: "home" | "away"): string {
  const color = teamColor(team)
  return `linear-gradient(${side === "away" ? 160 : 200}deg, ${color}, color-mix(in oklab, ${color} 55%, black))`
}

function rgbOf(hex: string | undefined): readonly [number, number, number] | undefined {
  if (hex === undefined || !/^[0-9a-f]{6}$/i.test(hex)) return undefined
  const value = Number.parseInt(hex, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance([red, green, blue]: readonly [number, number, number]): number {
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

function linear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** 30% of the way to white: enough to lift even black (to a luminance of 0.074) above `darkest`. */
function lightened([red, green, blue]: readonly [number, number, number]): readonly [number, number, number] {
  return [toWhite(red), toWhite(green), toWhite(blue)]
}

function toWhite(channel: number): number {
  return Math.round(channel + (255 - channel) * 0.3)
}

function css(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

/** The darkest a team color may be and still show on a dark surface, as relative luminance. */
const darkest = 0.03

const graphite = "#3a3d44"
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run apps/web/src/game/TeamColors.test.ts`
Expected: PASS.

---

### Task 15 (phase 3, was task 8): Cards, chips and the shelf

**Files:**
- Create: `apps/web/src/ui/Shelf.tsx`
- Create: `apps/web/src/game/GameCard.tsx`, `apps/web/src/game/GameChip.tsx`

**Interfaces:**
- Consumes: `useTheme` (Task 6), `teamColor`, `teamEdge` and `teamHalf` (Task 7), and the existing `TeamLogo`,
  `Score` and `GameStatus`.
- Produces:
  - `Shelf({ title?, live?, focus, children })`, a sideways row that scrolls the focused child into view.
  - `GameCard({ game, focused, onChoose })` and `GameChip({ game, focused, onChoose })`, each with a Glass and a Team
    variant.

Components and UI-only state need no tests (spec section 1).

- [ ] **Step 1: Write `ui/Shelf.tsx`**

```tsx
import { type ReactNode, useEffect, useRef } from "react"
import { cn } from "@/design/ClassName"

interface ShelfProps {
  title?: string | undefined
  live?: boolean
  focus: number | undefined
  children: ReactNode
}

/**
 * A row of cards under an optional title, scrolling sideways without a scrollbar and keeping the child at `focus` in
 * view. `live` lights the title in the live color.
 */
export function Shelf({ title, live = false, focus, children }: ShelfProps) {
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focus === undefined) return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    row.current?.children
      .item(focus)
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced ? "auto" : "smooth" })
  }, [focus])

  return (
    <section className="flex min-h-0 flex-col gap-1.5">
      {title !== undefined && (
        <h2 className={cn("label-caps text-xs", live ? "text-live" : "text-muted-foreground")}>{title}</h2>
      )}
      <div ref={row} className="flex min-h-0 gap-3 overflow-x-auto px-1 py-2 [scrollbar-width:none]">
        {children}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Write `game/GameChip.tsx`**

```tsx
import type { GameSnapshot } from "@sportal/domain/Game"
import { useTheme } from "../ui/Theme.ts"
import { GameStatus } from "./GameStatus.tsx"
import { Score } from "./Score.tsx"
import { TeamLogo } from "./TeamLogo.tsx"
import { teamEdge, teamHalf } from "./TeamColors.ts"

interface GameChipProps {
  game: GameSnapshot
  focused: boolean
  onChoose: () => void
}

/** A game as the ribbon shows it, in the theme's shape: the two teams and their score, over the game's status. */
export function GameChip({ game, focused, onChoose }: GameChipProps) {
  const theme = useTheme()
  return (
    <button
      type="button"
      tabIndex={-1}
      data-focused={focused}
      aria-label={game.scoreline()}
      onClick={onChoose}
      className="guide-focus h-full max-h-32 w-52 shrink-0 rounded-card text-left"
    >
      {theme === "glass" ? <GlassChip game={game} /> : <TeamChip game={game} />}
    </button>
  )
}

function GlassChip({ game }: { game: GameSnapshot }) {
  return (
    <div className="relative flex h-full flex-col justify-center gap-1.5 overflow-hidden rounded-card border border-card-edge py-2 pr-3 pl-4 backdrop-blur-[var(--guide-blur)] [background:var(--card-surface)]">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: teamEdge(game) }} />
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 font-mono text-sm">
        <Score game={game} side="away" />
        <Score game={game} side="home" />
      </div>
      <GameStatus game={game} className="truncate text-[11px]" />
    </div>
  )
}

function TeamChip({ game }: { game: GameSnapshot }) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-card">
      <div className="grid min-h-0 flex-1 grid-cols-2">
        {(["away", "home"] as const).map((side) => (
          <div
            key={side}
            className="flex items-center justify-center gap-1.5 px-1"
            style={{ background: teamHalf(game[side].team, side) }}
          >
            <TeamLogo team={game[side].team} size={26} />
            <span className="font-bold font-mono text-lg text-white drop-shadow">
              {game.scored() ? game[side].score : game[side].team.abbreviation}
            </span>
          </div>
        ))}
      </div>
      <div className="bg-card-footer px-2 py-1">
        <GameStatus game={game} className="block truncate text-[11px]" />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Write `game/GameCard.tsx`**

```tsx
import type { GameSnapshot } from "@sportal/domain/Game"
import { Situation } from "@sportal/domain/Situation"
import { cn } from "@/design/ClassName"
import { useTheme } from "../ui/Theme.ts"
import { GameStatus } from "./GameStatus.tsx"
import { TeamLogo } from "./TeamLogo.tsx"
import { teamEdge, teamHalf } from "./TeamColors.ts"

interface GameCardProps {
  game: GameSnapshot
  focused: boolean
  onChoose: () => void
}

/**
 * A game as the full guide shows it, in the theme's shape: both teams with their logos, rankings or records, and
 * scores; its status; the situation's short line while it is live; and its networks.
 */
export function GameCard({ game, focused, onChoose }: GameCardProps) {
  const theme = useTheme()
  return (
    <button
      type="button"
      tabIndex={-1}
      data-focused={focused}
      aria-label={game.scoreline()}
      onClick={onChoose}
      className="guide-focus shrink-0 rounded-card text-left"
    >
      {theme === "glass" ? <GlassCard game={game} /> : <TeamCard game={game} />}
    </button>
  )
}

function GlassCard({ game }: { game: GameSnapshot }) {
  return (
    <div className="relative w-60 overflow-hidden rounded-card border border-card-edge px-3.5 py-3 backdrop-blur-[var(--guide-blur)] [background:var(--card-surface)]">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: teamEdge(game) }} />
      {(["away", "home"] as const).map((side) => (
        <div key={side} className="flex items-center gap-2.5 py-0.5">
          <TeamLogo team={game[side].team} size={30} />
          <span className={cn("min-w-0 flex-1 truncate text-[15px]", trails(game, side) && "text-muted-foreground")}>
            {game[side].team.name}
            <span className="ml-1.5 text-muted-foreground text-xs">{standing(game, side)}</span>
          </span>
          <span className={cn("font-mono font-semibold text-[22px]", trails(game, side) && "text-muted-foreground")}>
            {game.scored() ? game[side].score : null}
          </span>
        </div>
      ))}
      <div className="mt-1.5 flex justify-between gap-2 text-muted-foreground text-xs">
        <GameStatus game={game} className="shrink-0" />
        <span className="truncate">{footer(game)}</span>
      </div>
    </div>
  )
}

function TeamCard({ game }: { game: GameSnapshot }) {
  return (
    <div className="w-64 overflow-hidden rounded-card">
      <div className="grid h-24 grid-cols-2">
        {(["away", "home"] as const).map((side) => (
          <div
            key={side}
            className="flex flex-col items-center justify-center gap-0.5"
            style={{ background: teamHalf(game[side].team, side) }}
          >
            <span className="drop-shadow-md">
              <TeamLogo team={game[side].team} size={40} />
            </span>
            <span className="font-bold font-mono text-2xl text-white drop-shadow">
              {game.scored() ? game[side].score : game[side].team.abbreviation}
            </span>
            <span className="text-[10px] text-white/75">{standing(game, side)}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-between gap-2 bg-card-footer px-2.5 py-1.5 text-muted-foreground text-xs">
        <GameStatus game={game} className="shrink-0" />
        <span className="label-caps truncate">{footer(game)}</span>
      </div>
    </div>
  )
}

/** Whether `side` trails once there is a score. */
function trails(game: GameSnapshot, side: "home" | "away"): boolean {
  return game.scored() && game[side].score < game[side === "home" ? "away" : "home"].score
}

/** A side's ranking ("#5") when it has one, else its record ("8-2"), else nothing. */
function standing(game: GameSnapshot, side: "home" | "away"): string {
  const { ranking, record } = game[side]
  if (ranking !== undefined) return `#${ranking}`
  return record === undefined ? "" : `${record.wins}-${record.losses}`
}

/** The card's footer after the status: the situation's short line while live, then the networks. */
function footer(game: GameSnapshot): string {
  return [situationLine(game), game.networks()].filter((part) => part !== undefined && part !== "").join(" · ")
}

/** Down and distance ("2nd & 7", "1st & Goal"), or the count and outs ("2-1, 1 out"); none unless live. */
function situationLine(game: GameSnapshot): string | undefined {
  if (game.progress() !== "live" || game.situation === undefined) return undefined
  return Situation.match(game.situation, {
    Football: (football) =>
      football.down === undefined
        ? undefined
        : `${ordinals[football.down - 1] ?? `${football.down}th`} & ${football.goalToGo() ? "Goal" : (football.distance ?? "")}`,
    Baseball: ({ balls, strikes, outs }) => `${balls}-${strikes}, ${outs} ${outs === 1 ? "out" : "outs"}`
  })
}

const ordinals = ["1st", "2nd", "3rd", "4th"]
```

---

### Task 16 (phase 3, was task 9): Ribbon, rail and full guide

**Files:**
- Create: `apps/web/src/guide/Ribbon.tsx`, `apps/web/src/guide/GuideRail.tsx`, `apps/web/src/guide/FullGuide.tsx`
- Modify: `apps/web/src/hub/Games.ts` (add `byId`)
- Modify: `apps/web/src/display/Display.ts` (add `entryName`), `apps/web/src/display/DisplayState.ts` (export `shelves`)

**Interfaces:**
- Consumes: `Display.guideEntries`, the guide inputs (Task 5), `GameCard`, `GameChip` and `Shelf` (Task 8), `Theme`
  (Task 6), and `useOverlayRef`.
- Produces:
  - `Games.byId: Atom.Atom<ReadonlyMap<GameId, ListedGame>>`.
  - `Display.entryName(entry): string`.
  - `DisplayState.shelves: Atom.Atom<GuideShelves>` (exported).
  - `Ribbon({ entry, focus })`, `GuideRail({ entry, focused })` and `FullGuide({ entry, focus })`.

- [ ] **Step 1: Add `Games.byId`**

In `apps/web/src/hub/Games.ts`, after `today`:

```ts
/** Today's games by id, from `today`: none before the first answer. What the guide's cards read. */
export const byId: Atom.Atom<ReadonlyMap<GameId, ListedGame>> = Atom.make(
  (get) =>
    new Map(
      Option.match(get(today).value, {
        onNone: () => [],
        onSome: ({ games }) => games.map((listed) => [listed.snapshot.id, listed] as const)
      })
    )
)
```

- [ ] **Step 2: Add `Display.entryName` and export the shelves**

In `apps/web/src/display/Display.ts`, add `League` to the `@sportal/domain/League` import, and add this static after
`guideEntries`:

```ts
  /** How the guide names an entry: "All live", the league's name, or "Custom". */
  static entryName(entry: GuideEntry): string {
    if (entry === "AllLive") return "All live"
    return entry === "Custom" ? "Custom" : League.of(entry).name
  }
```

In `apps/web/src/display/DisplayState.ts`, move `shelves` up to directly after `display`, and export it:

```ts
/** The guide's shelves over today's games, every entry empty before the first answer: what the fold and the guide read. */
export const shelves: Atom.Atom<GuideShelves.GuideShelves> = Atom.make((get) => {
  const games = Option.match(get(Games.today).value, { onNone: () => [], onSome: ({ games }) => games })
  return GuideShelves.guideShelves(games)
})
```

- [ ] **Step 3: Write `guide/Ribbon.tsx`**

```tsx
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { ChevronUp } from "lucide-react"
import { Button } from "@/design/button"
import { cn } from "@/design/ClassName"
import { Display, DisplayInput, type GuideEntry, type GuideFocus } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { GameChip } from "../game/GameChip.tsx"
import * as Games from "../hub/Games.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { Shelf } from "../ui/Shelf.tsx"
import { GuideItem } from "./GuideItem.ts"

interface RibbonProps {
  entry: GuideEntry
  focus: GuideFocus
}

/**
 * The guide's first level, docked under the Screen: the entries as tabs, which tile a pick goes to, and one row of the
 * entry's live then upcoming games. It slides up as it opens.
 */
export function Ribbon({ entry, focus }: RibbonProps) {
  const input = useAtomSet(DisplayState.display)
  const display = useAtomValue(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const shelves = useAtomValue(DisplayState.shelves)
  const games = useAtomValue(Games.byId)
  const [row = []] = shelves(entry, "Ribbon")

  return (
    <section
      aria-label="Guide"
      className="flex min-h-0 animate-in flex-col gap-2 border-t bg-guide px-4 pt-2.5 pb-3 backdrop-blur-[var(--guide-blur)] duration-150 slide-in-from-bottom motion-reduce:animate-none"
    >
      <div className="flex items-center gap-1">
        {Display.guideEntries.map((each) => (
          <button
            key={each}
            type="button"
            tabIndex={-1}
            onClick={() => input(DisplayInput.GuideEntryChosen({ entry: each }))}
            className={cn(
              "label-caps rounded-sm px-2.5 py-1 text-xs",
              each === entry ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {Display.entryName(each)}
          </button>
        ))}
        <span className="label-caps ml-auto text-[11px] text-muted-foreground">
          Puts the pick in tile {display.selectedOn(screen) + 1}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="label-caps text-[11px] text-muted-foreground"
          aria-keyshortcuts="G"
          onClick={() => input(DisplayInput.GuideOpened({ entry }))}
        >
          <ChevronUp />
          Full guide
        </Button>
      </div>
      {row.length === 0 ? (
        <p className="m-auto text-muted-foreground text-sm">
          {entry === "AllLive"
            ? "Nothing live right now"
            : `Nothing live or later in ${Display.entryName(entry)} today`}
        </p>
      ) : (
        <Shelf focus={focus.item}>
          {row.map((item, index) =>
            GuideItem.$match(item, {
              Game: ({ game }) => {
                const listed = games.get(game)
                return listed === undefined ? null : (
                  <GameChip
                    key={game}
                    game={listed.snapshot}
                    focused={focus.item === index}
                    onChoose={() => input(DisplayInput.GuideItemChosen({ shelf: 0, item: index }))}
                  />
                )
              }
            })
          )}
        </Shelf>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Write `guide/GuideRail.tsx`**

```tsx
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Expand, Keyboard, LogIn, Minimize2, Smartphone } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/design/button"
import { cn } from "@/design/ClassName"
import { ToggleGroup, ToggleGroupItem } from "@/design/toggle-group"
import { BrandMark, ConnectionPill } from "../display/Brand.tsx"
import { Display, DisplayInput, type GuideEntry } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import * as Games from "../hub/Games.ts"
import { LayoutPicker } from "../layout/LayoutPicker.tsx"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import * as Theme from "../ui/Theme.ts"

interface GuideRailProps {
  entry: GuideEntry
  focused: boolean
}

/**
 * The full guide's left rail: Sportal's mark; the guide's entries, the one shown lit, All live with its count of live
 * games; and at its foot what the top bar had: theme, layout, YouTube TV, Remote, keys, full screen, and the Hub.
 */
export function GuideRail({ entry, focused }: GuideRailProps) {
  const input = useAtomSet(DisplayState.display)
  const shelves = useAtomValue(DisplayState.shelves)
  const live = shelves("AllLive", "Ribbon")[0]?.length ?? 0

  return (
    <nav aria-label="Guide entries" className="flex min-h-0 flex-col gap-1 border-r bg-guide-rail px-3 py-4">
      <div className="px-2 pb-5">
        <BrandMark />
      </div>
      {Display.guideEntries.map((each) => (
        <button
          key={each}
          type="button"
          tabIndex={-1}
          data-focused={focused && each === entry}
          onClick={() => input(DisplayInput.GuideEntryChosen({ entry: each }))}
          className={cn(
            "guide-focus flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm",
            each === entry
              ? "bg-foreground font-semibold text-background"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          {Display.entryName(each)}
          {each === "AllLive" && live > 0 && (
            <span className="flex items-center gap-1 font-mono text-live text-xs" title="Games live now">
              <span className="size-1.5 rounded-full bg-live" />
              {live}
            </span>
          )}
        </button>
      ))}
      <RailFoot />
    </nav>
  )
}

function RailFoot() {
  const input = useAtomSet(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const { connection } = useAtomValue(Games.today)
  const fullScreen = useAtomValue(DisplayState.fullScreen)
  const toggleFullScreen = useAtomSet(DisplayState.toggleFullScreen)
  const signIn = useAtomValue(DisplayState.signIn)
  const openSignIn = useAtomSet(DisplayState.openSignIn)
  const theme = Theme.useTheme()
  const setTheme = useAtomSet(Theme.theme)

  return (
    <div className="mt-auto flex flex-col gap-2 border-t pt-3">
      <ToggleGroup
        type="single"
        size="sm"
        value={theme}
        onValueChange={(value) => {
          const name = Theme.ThemeName.literals.find((each) => each === value)
          if (name !== undefined) setTheme(name)
        }}
        aria-label="Theme"
        className="w-full"
      >
        {Theme.ThemeName.literals.map((name) => (
          <ToggleGroupItem
            key={name}
            value={name}
            className="label-caps flex-1 text-[11px] text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
          >
            {themeLabels[name]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <LayoutPicker
        current={screen.layout}
        onChoose={(layout) => input(DisplayInput.Commanded({ command: { _tag: "SetLayout", layout } }))}
      />
      {signIn && (
        <RailButton onClick={() => openSignIn(undefined)}>
          <LogIn />
          YouTube TV
        </RailButton>
      )}
      <RailButton onClick={() => input(DisplayInput.Opened({ overlay: "JoinRemote" }))}>
        <Smartphone />
        Remote
      </RailButton>
      <RailButton keys="?" onClick={() => input(DisplayInput.Opened({ overlay: "Keys" }))}>
        <Keyboard />
        Keys
      </RailButton>
      <RailButton keys="F11" onClick={() => toggleFullScreen(undefined)}>
        {fullScreen ? <Minimize2 /> : <Expand />}
        Full screen
      </RailButton>
      <div className="px-2 pt-1">
        <ConnectionPill connection={connection} />
      </div>
    </div>
  )
}

function RailButton(props: { keys?: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-keyshortcuts={props.keys}
      className="label-caps w-full justify-start text-muted-foreground text-xs"
      onClick={props.onClick}
    >
      {props.children}
      {props.keys !== undefined && (
        <kbd className="ml-auto font-mono text-[10px] text-muted-foreground">{props.keys}</kbd>
      )}
    </Button>
  )
}

const themeLabels: Record<Theme.ThemeName, string> = { glass: "Glass", team: "Team" }
```

- [ ] **Step 5: Write `guide/FullGuide.tsx`**

```tsx
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Display, DisplayInput, type GuideEntry, type GuideFocus } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { useOverlayRef } from "../display/OverlayRef.ts"
import { GameCard } from "../game/GameCard.tsx"
import * as Games from "../hub/Games.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { Shelf } from "../ui/Shelf.tsx"
import { GuideItem } from "./GuideItem.ts"
import { GuideRail } from "./GuideRail.tsx"

interface FullGuideProps {
  entry: GuideEntry
  focus: GuideFocus
}

/**
 * The guide's second level, over the whole Display: the rail at the left, and the entry's shelves at the right (live
 * now, later today, final for a league; live now for All live). It covers every video, which hides under it, and fades
 * in.
 */
export function FullGuide({ entry, focus }: FullGuideProps) {
  const ref = useOverlayRef()
  const input = useAtomSet(DisplayState.display)
  const display = useAtomValue(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const shelves = useAtomValue(DisplayState.shelves)(entry, "Full")
  const games = useAtomValue(Games.byId)
  const titles = entry === "AllLive" ? ["Live now"] : shelfTitles
  const empty = shelves.every((shelf) => shelf.length === 0)

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Guide"
      className="fixed inset-0 z-40 grid animate-in grid-cols-[15rem_minmax(0,1fr)] bg-guide backdrop-blur-[var(--guide-blur)] duration-120 fade-in motion-reduce:animate-none"
    >
      <GuideRail entry={entry} focused={focus.rail} />
      <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-8 py-6">
        <header className="flex items-baseline gap-4">
          <h1 className="label-caps text-2xl">{Display.entryName(entry)}</h1>
          <span className="label-caps text-[11px] text-muted-foreground">
            Puts the pick in tile {display.selectedOn(screen) + 1}
          </span>
          <span className="label-caps ml-auto font-mono text-[11px] text-muted-foreground">Esc · back</span>
        </header>
        {empty ? (
          <p className="m-auto text-lg text-muted-foreground">
            {entry === "AllLive" ? "Nothing live right now" : `No ${Display.entryName(entry)} games today`}
          </p>
        ) : (
          shelves.map((shelf, index) =>
            shelf.length === 0 ? null : (
              <Shelf
                key={titles[index] ?? index}
                title={titles[index]}
                live={index === 0}
                focus={!focus.rail && focus.shelf === index ? focus.item : undefined}
              >
                {shelf.map((item, at) =>
                  GuideItem.$match(item, {
                    Game: ({ game }) => {
                      const listed = games.get(game)
                      return listed === undefined ? null : (
                        <GameCard
                          key={game}
                          game={listed.snapshot}
                          focused={!focus.rail && focus.shelf === index && focus.item === at}
                          onChoose={() => input(DisplayInput.GuideItemChosen({ shelf: index, item: at }))}
                        />
                      )
                    }
                  })
                )}
              </Shelf>
            )
          )
        )}
      </div>
    </div>
  )
}

/** A league's shelves' titles, in `guideShelves`' order. Phase 7 appends "Highlights". */
const shelfTitles = ["Live now", "Later today", "Final"]
```

---

### Task 17 (phase 3, was task 10): The connection toast

**Files:**
- Create: `apps/web/src/display/ConnectionToast.ts`

**Interfaces:**
- Consumes: `Games.today`'s `connection` and `Connection`.
- Produces: `useConnectionToast()`.

- [ ] **Step 1: Write it**

```ts
import { useAtomValue } from "@effect/atom-react"
import { useEffect } from "react"
import { toast } from "sonner"
import * as Games from "../hub/Games.ts"
import { Connection } from "../hub/HubSocket.ts"

/**
 * Shows one toast for as long as the Hub socket is lost: from the moment it is lost until it is back, then dismisses
 * it. Before the socket has ever connected there is none.
 */
export function useConnectionToast() {
  const { connection } = useAtomValue(Games.today)
  const lost = Connection.$is("Lost")(connection)
  useEffect(() => {
    if (!lost) return undefined
    toast.warning("Lost the Hub. Reconnecting…", { id: lostToast, duration: Number.POSITIVE_INFINITY })
    return () => {
      toast.dismiss(lostToast)
    }
  }, [lost])
}

/** The one toast's id, so a second loss replaces it instead of stacking. */
const lostToast = "sportal-hub-lost"
```

---

### Task 18 (phase 3, was task 11): The new `DisplayView`, without the top bar

**Files:**
- Modify: `apps/web/src/display/DisplayView.tsx` (rewrite)
- Delete: `apps/web/src/display/TopBar.tsx`
- Modify: `apps/web/src/display/CommandPalette.tsx` (a Guide item)
- Modify: `apps/web/src/screen/TileChrome.tsx` (the empty tile's hint)

**Interfaces:**
- Consumes: `Ribbon` and `FullGuide` (Task 9), `useConnectionToast` (Task 10), `useTheme` (Task 6), and
  `DisplayState.guideOpenSync` (Task 5).

- [ ] **Step 1: Rewrite `DisplayView.tsx`**

```tsx
import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Toaster } from "@/design/sonner"
import { FullGuide } from "../guide/FullGuide.tsx"
import { Ribbon } from "../guide/Ribbon.tsx"
import * as GuideRelay from "../hub/GuideRelay.ts"
import { JoinRemote } from "../remote/JoinRemote.tsx"
import * as RemoteLink from "../remote/RemoteLink.ts"
import { useScreenRejectionToasts } from "../screen/Rejections.ts"
import { ScreenView } from "../screen/ScreenView.tsx"
import * as TilePlacements from "../screen/TilePlacements.ts"
import { useTheme } from "../ui/Theme.ts"
import { CommandPalette } from "./CommandPalette.tsx"
import { useConnectionToast } from "./ConnectionToast.ts"
import * as Covering from "./Covering.ts"
import { DisplayInput, Overlay } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"
import { KeysDialog } from "./KeysDialog.tsx"

/**
 * A Display: one column of the Screen and, while the guide's ribbon is open, the ribbon docked under it (the Screen
 * shrinks above it, and every video moves with it). The full guide, the key help, Join Remote and the palette open over
 * it, one at a time. Toasts sit at the bottom center, above the ribbon while it is open.
 */
export function DisplayView() {
  const display = useAtomValue(DisplayState.display)
  const input = useAtomSet(DisplayState.display)
  const closeOverlay = (open: boolean) => {
    if (!open) input(DisplayInput.Closed())
  }
  useAtomMount(DisplayState.inputs)
  useAtomMount(DisplayState.guideOpenSync)
  useAtomMount(GuideRelay.relay)
  useAtomMount(TilePlacements.sync)
  useAtomMount(Covering.sync)
  useAtomMount(RemoteLink.link)
  useScreenRejectionToasts()
  useConnectionToast()
  useTheme()
  const guide = Overlay.$is("Guide")(display.overlay) ? display.overlay : undefined
  const ribbon = guide?.level === "Ribbon" ? guide : undefined
  const toastOffset = { bottom: ribbon === undefined ? 16 : "calc(25vh + 12px)" }

  return (
    <>
      <div
        className={`grid h-screen ${ribbon === undefined ? "grid-rows-[minmax(0,1fr)]" : "grid-rows-[minmax(0,1fr)_25%]"}`}
      >
        <ScreenView />
        {ribbon !== undefined && <Ribbon entry={ribbon.entry} focus={ribbon.focus} />}
      </div>
      {guide?.level === "Full" && <FullGuide entry={guide.entry} focus={guide.focus} />}
      <KeysDialog open={display.shows("Keys")} onOpenChange={closeOverlay} />
      {display.shows("JoinRemote") && <JoinRemote open onOpenChange={closeOverlay} />}
      <CommandPalette open={display.shows("Palette")} onOpenChange={closeOverlay} />
      <Toaster
        position="bottom-center"
        offset={toastOffset}
        mobileOffset={toastOffset}
        visibleToasts={1}
        toastOptions={{ style: { paddingBlock: 6, paddingInline: 12 } }}
      />
    </>
  )
}
```

- [ ] **Step 2: Delete the top bar**

```bash
git rm apps/web/src/display/TopBar.tsx
```

`Brand.tsx` keeps `BrandMark` and `ConnectionPill`, both now used by `GuideRail`. `Brand.test.ts` is unchanged.

- [ ] **Step 3: Open the guide from the palette, and point an empty tile at it**

In `apps/web/src/display/CommandPalette.tsx`, add this as the first item of the `Display` group. It replaces the
palette with the guide, as the Keys item replaces it with the key help:

```tsx
          <CommandItem
            value="guide games league tv"
            onSelect={() => input(DisplayInput.GuideOpened({ entry: display.lastEntry }))}
          >
            Guide
            <CommandShortcut>G</CommandShortcut>
          </CommandItem>
```

In `apps/web/src/screen/TileChrome.tsx`, change `"Empty — Ctrl K to choose a game"` to `"Empty — G to choose a game"`.

---

### Task 19 (phase 3, was task 12): Docs rows, check, and commit 3b

**Files:**
- Modify: `CONTEXT.md`

- [ ] **Step 1: Add the theme row**

In `CONTEXT.md`'s **Viewing** table, after the guide rows from Task 5, add:

```markdown
| **Theme** | How a Display's guide, cards and tile chrome look: Glass (translucent and blurred, full team names, a thin edge in the teams' colors; the default) or Team (cards split into the teams' colors, big logos and scores); `ThemeName` and the `theme` atom in `apps/web/src/ui/Theme.ts`, kept in the browser under `sportal.theme`, set on the page as `data-theme`. Dark only. | skin, mode |
```

Update **Team colors**: append "The web paints a team with `teamColor` (`apps/web/src/game/TeamColors.ts`): its
alternate color, or its own lightened, when its own is too dark to see (relative luminance under 0.03); graphite when
it has none."

Update **Guide level**: change "(…docked under the Screen, which shrinks above it)" to also say "the full guide's rail
holds what the top bar had". The top bar has no row of its own to remove.

- [ ] **Step 2: Verify nothing still names the top bar**

Run: `grep -rn "TopBar\|top bar" apps/web/src CONTEXT.md`
Expected: no matches (`docs/technical-spec.md` is phase 8's).

- [ ] **Step 3: Run the full check**

```bash
pnpm format
pnpm check
```

Expected: PASS.

- [ ] **Step 4: Commit 3b**

```bash
git add apps/web/src CONTEXT.md
git commit -F - <<'EOF'
feat: the guide by league in two themes, and no top bar

The Display is one column: the Screen and, while open, the guide's ribbon
docked under it (25% of the height; the Screen shrinks and every provider
view resizes with it). The ribbon has the entries as tabs, which tile a pick
goes to, and one row of game chips: the entry's live then upcoming games.
The full guide covers the whole Display, hiding every video under it through
Covering: the rail (Sportal's mark, All live with its live count, each
league, and at its foot theme, layout, YouTube TV, Remote, keys, full screen
and the Hub's pill) and the entry's shelves, Live now, Later today and Final,
of cards with logos, scores, rankings or records, status, down and distance
or count and outs, and networks. Empty entries say so.

Two themes, Glass (default) and Team, as token blocks in theme.css under
data-theme, kept in localStorage under sportal.theme (anything unreadable is
Glass). Cards and chips render a Glass and a Team variant from the same
snapshot; team colors come from teamColor, which swaps a too-dark color for
the alternate or lightens it. The tile chrome and the data tile's scoreboard
take the theme's tokens. The ribbon slides up, the full guide fades in, focus
moves animate, all off under prefers-reduced-motion.

TopBar goes. A lost Hub connection shows one persistent toast until it is
back; the Toaster sits at the bottom center, above the ribbon while it is
open. The palette gains Guide (G).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Contract notes

1. **`DisplayState.shelves`, not `GuideShelves.shelves`.** The contract puts both the atom `shelves` and the pure
   `guideShelves` in `guide/GuideShelves.ts`. Then `guideShelves` would be exported only for its tests, because the
   atom in the same file is its only other user. `knip --production` fails on that, and `AGENTS.md` forbids it. So
   `guide/GuideShelves.ts` holds the type `GuideShelves` and the pure `guideShelves(games: ReadonlyArray<ListedGame>)`.
   The atom is `DisplayState.shelves`: private in commit 3a, where only the Display's writer reads it, and exported in
   3b for the views. Phases 4 and 7 should widen `guideShelves(games, …)` with the custom list and highlights, and
   feed them into `DisplayState.shelves`.
2. **`teamColor(team)` takes no `surface`.** The spec's rule is absolute (relative luminance under 0.03), so a surface
   argument would decide nothing. A team with no color, or a color that is not six hex digits, gets graphite
   `#3a3d44`. The alternate color is used only if it is itself not too dark; otherwise the main color is mixed 30%
   toward white. `TeamColors.ts` also exports `teamEdge(game)` (Glass's two-color edge) and `teamHalf(team, side)`
   (Team's half paint), because both `GameCard` and `GameChip` use them.
3. **`Display#press` takes the shelves too, not only `apply`.** `press` handles `Move` and `Confirm`, so it is
   `press(hotkey, screen, shelves)`. Every existing `Display.test.ts` call gains a `none` argument, and the commit body
   says so.
4. **`Display#open` excludes `Guide`.** `Guide` needs arguments, so `open` takes
   `Exclude<Overlay["_tag"], "None" | "Guide">`, and `DisplayInput.Opened` stays the plain overlays. `shows` accepts
   `"Guide"`. Phase 6's `GamePage` should be added to the same exclusion.
5. **What the guide inputs do.** `GuideOpened({ entry })` opens the **Full** guide on that entry. It is used by the
   ribbon's "Full guide" button and the palette's new "Guide" item. `GuideEntryChosen({ entry })` changes the entry at
   the open level, or opens Full if nothing is open. `GuideItemChosen({ shelf, item })` focuses that item and confirms
   it.
6. **Additions not in the contract.** `Display.guideEntries` (static, `["AllLive", ...LeagueId.literals]`; phase 4
   appends `"Custom"`), `Display.entryName(entry)` (static), `Games.byId` (atom, so the ribbon and the full guide look
   up a `GuideItem.Game`'s snapshot without each building the map), and `DisplayState.guideOpenSync` (the mounted atom
   that calls `Shell.setGuideOpen`).
7. **Shelf shapes are fixed.** A league's full guide is always `[live, upcoming, over]`, even when shelves are empty,
   so shelf index 0, 1, 2 always means Live now, Later today, Final. Phase 7 appends Highlights as index 3. All live is
   one shelf at both levels. Custom is `[[]]` until phase 4, and it is not in `guideEntries` until then.
8. **`Info` is inert in phase 3.** It is mapped (KeyI while the guide is open) and listed in the key help, but the fold
   returns the Display unchanged until phase 6.
9. **`KeysDialog` changes after all.** The spec says it stays "unchanged in code", but it hard-coded
   `["Tiles", "Screen"]`. It now derives its groups from `Hotkey.keys`, so the Guide group (and phase 4's Remove) shows
   without further edits.
10. **Toasts in the shell.** A bottom-center toast is drawn under the provider views, which sit above the page, so in
    the desktop shell it is hidden wherever a tile's video is. The plan follows the spec. Phase 8's eye-check should
    look at this; one fix would be giving the Toaster `useOverlayRef`, which would hide one tile while a toast shows.
11. **Phase 2 facts used.** `Assign({ tile, game })` keeps a `GameId`, so the guide's Confirm tests assert
    `{ _tag: "Assign", tile: 0, game: GameId.make(…) }`. Solo is `Option.some(TileKey.game(live))`.
    `VideoPressed({ key })` and `screen.slotOf(key)` appear in `apply` as phase 2 left them.
## Phase 4 — Custom tile (YouTube videos and playlists)

Phase 4 is one commit, made by its last task: every export a task adds is first read by production code in a later
task, and `knip --production` fails on an export only tests read. Tasks do not commit; a reviewer gates each task on the
working-tree diff.

Phases 1–3 are in. This part relies on what they made, by these names (phase 2's facts as its draft states them):

- `packages/api/src/TileKey.ts`: `TileKey` (branded string) with `TileKey.game(id)`. A GameId meeting a TileKey is
  wrapped in `TileKey.game(...)`.
- `Tile.key` in `apps/web/src/screen/Screen.ts` has overloads (an occupied tile → `TileKey`; any tile →
  `TileKey | undefined`); a new tile case is added inside `key`'s body. `ScreenCommand` is unchanged by phase 2 (its
  fields are slots; `Assign({ tile, game })` keeps a `GameId`). `Screen#benched()` returns `{ tile, key: TileKey }`,
  `Screen#hears`, `#soloes` and `#slotOf` take a `TileKey`, and `Display#choose` matches the bench on the key.
  `TileRects.coveredGames` is now `coveredTiles`. `TilePlacement` has `key: TileKey` in place of `game`.
- Phase 3: `Overlay.Guide({ level, entry, focus })`, `GuideEntry` (`"AllLive" | LeagueId | "Custom"`), `GuideFocus`
  (`{ rail, shelf, item }`), `GuideShelves` (`(entry, level) => ReadonlyArray<ReadonlyArray<GuideItem>>`),
  `Display.apply(input, screen, shelves)`, `DisplayInput.GuideOpened({ entry })` / `GuideItemChosen({ shelf, item })`,
  `guide/GuideItem.ts` (`GuideItem` with only `Game({ game })`), `guide/GuideShelves.ts` (atom `shelves`, pure
  `guideShelves(...)`), `guide/FullGuide.tsx`, `guide/Ribbon.tsx`, `guide/GuideRail.tsx`, `game/GameCard.tsx`, and
  `Hotkey.of(key)` with `key.guideOpen`, mapping arrows, Enter, `[`, `]` and `I` (as `Info`) only while it is true; the
  `Hotkey.keys` group `"Guide"`; `KeysDialog` listing that group.

Where a step edits code phase 3 wrote, it names the function or `$match` case to edit and gives the code to add, since
phase 3's exact text is not known while this part is written. Every new name below is either in the contract or listed
under "Contract notes".

Run one test file with `pnpm vitest run <path>` from the repository root (checked: the root `vitest.config.ts` lists
every workspace as a project, so a path from the root runs in its own project).

---

### Task 20 (phase 4, was task 1): `CustomStream`: a YouTube address, read (test-first)

**Files:**
- Create: `apps/web/src/custom/CustomStream.ts`
- Create: `apps/web/src/custom/CustomStream.test.ts`

**Interfaces:**
- Consumes: `StreamLocator` (`packages/domain/src/Channel.ts`).
- Produces: `CustomStreamId` (branded string, `video.<id>` / `list.<id>` / `list.<id>.<video id>`), `CustomTarget`
  (`Schema.TaggedUnion`: `Video({ videoId })`, `Playlist({ listId, videoId?: string })`), `class CustomStream`
  (`id`, `name`, `target`; `static parse(url: string, name?: string): Result<CustomStream, NotYouTube>`,
  `watchUrl(): string`, `embedUrl(): string`, `locator(): StreamLocator`), `class NotYouTube` (`Schema.TaggedError`,
  field `url: string`).

The id is read from what the stream plays, not drawn at random: `crypto.randomUUID` exists only in a secure context, and
a Display opened at a LAN address is not one (`RemoteLink.displayId` says so). A target-derived id keeps `parse` pure,
keeps one video saved once, and needs no second copy of `displayId`'s random-hex code. See "Contract notes".

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/custom/CustomStream.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { CustomStream } from "./CustomStream.ts"

describe("CustomStream.parse", () => {
  it.each(["youtube.com", "www.youtube.com", "m.youtube.com"])(
    "should read a watch address on %s as its video",
    (host) => {
      const target = targetOf(`https://${host}/watch?v=dQw4w9WgXcQ`)

      assert.deepStrictEqual(target, { _tag: "Video", videoId: "dQw4w9WgXcQ" })
    }
  )

  it("should read a youtu.be address as its video", () => {
    const target = targetOf("https://youtu.be/dQw4w9WgXcQ")

    assert.deepStrictEqual(target, { _tag: "Video", videoId: "dQw4w9WgXcQ" })
  })

  it("should read a live address as its video", () => {
    const target = targetOf("https://www.youtube.com/live/jfKfPfyJRdk")

    assert.deepStrictEqual(target, { _tag: "Video", videoId: "jfKfPfyJRdk" })
  })

  it("should read a shorts address as its video", () => {
    const target = targetOf("https://www.youtube.com/shorts/aqz-KE-bpKQ")

    assert.deepStrictEqual(target, { _tag: "Video", videoId: "aqz-KE-bpKQ" })
  })

  it("should read an embed address as its video", () => {
    const target = targetOf("https://www.youtube.com/embed/dQw4w9WgXcQ")

    assert.deepStrictEqual(target, { _tag: "Video", videoId: "dQw4w9WgXcQ" })
  })

  it("should read a playlist address as the playlist from its start", () => {
    const target = targetOf("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")

    assert.deepStrictEqual(target, { _tag: "Playlist", listId: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" })
  })

  it("should read a watch address with a list as the playlist from that video", () => {
    const target = targetOf(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    )

    assert.deepStrictEqual(target, {
      _tag: "Playlist",
      listId: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
      videoId: "dQw4w9WgXcQ"
    })
  })

  it("should read a playlist's own watch address, with no video, as the playlist", () => {
    const target = targetOf("https://www.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")

    assert.deepStrictEqual(target, { _tag: "Playlist", listId: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" })
  })

  it("should read the embedded player's playlist address as the playlist", () => {
    const target = targetOf(
      "https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    )

    assert.deepStrictEqual(target, { _tag: "Playlist", listId: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" })
  })

  it("should read an address pasted without its scheme", () => {
    const target = targetOf("youtu.be/dQw4w9WgXcQ")

    assert.deepStrictEqual(target, { _tag: "Video", videoId: "dQw4w9WgXcQ" })
  })

  it("should name a video with no name given YouTube video", () => {
    const stream = parsed("https://youtu.be/dQw4w9WgXcQ")

    assert.strictEqual(stream.name, "YouTube video")
  })

  it("should name a playlist with only a blank name given YouTube playlist", () => {
    const stream = parsed("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG", "  ")

    assert.strictEqual(stream.name, "YouTube playlist")
  })

  it("should keep the name given, trimmed", () => {
    const stream = parsed("https://youtu.be/dQw4w9WgXcQ", " Week 6 recap ")

    assert.strictEqual(stream.name, "Week 6 recap")
  })

  it("should give one video the same id whichever address names it", () => {
    const short = parsed("https://youtu.be/dQw4w9WgXcQ")

    const watch = parsed("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42")

    assert.strictEqual(short.id, watch.id)
  })

  it("should give a playlist from a video another id than the playlist from its start", () => {
    const start = parsed("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")

    const fromVideo = parsed(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    )

    assert.notStrictEqual(start.id, fromVideo.id)
  })

  it.each(["https://vimeo.com/76979871", "https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ"])(
    "should refuse an address off YouTube: %s",
    (url) => {
      const refusal = refused(url)

      assert.deepStrictEqual(refusal?._tag, "NotYouTube")
    }
  )

  it.each(["https://www.youtube.com/watch", "https://www.youtube.com/@NFL", "https://youtu.be/short"])(
    "should refuse a YouTube address with no video or playlist id: %s",
    (url) => {
      const refusal = refused(url)

      assert.deepStrictEqual(refusal?._tag, "NotYouTube")
    }
  )

  it("should say which address it refused", () => {
    const refusal = refused("not an address")

    assert.strictEqual(refusal?.url, "not an address")
  })
})

describe("CustomStream#watchUrl", () => {
  it("should be a video's watch page", () => {
    const url = parsed("https://youtu.be/dQw4w9WgXcQ").watchUrl()

    assert.strictEqual(url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
  })

  it("should be a playlist's watch page from its start", () => {
    const url = parsed("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG").watchUrl()

    assert.strictEqual(url, "https://www.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")
  })

  it("should be a playlist's watch page from its video", () => {
    const url = parsed(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    ).watchUrl()

    assert.strictEqual(
      url,
      "https://www.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&v=dQw4w9WgXcQ"
    )
  })

  it("should read back as the same stream", () => {
    const stream = parsed(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
      "Recap"
    )

    const again = parsed(stream.watchUrl(), stream.name)

    assert.deepStrictEqual(again, stream)
  })
})

describe("CustomStream#embedUrl", () => {
  it("should be a video's embedded player", () => {
    const url = parsed("https://youtu.be/dQw4w9WgXcQ").embedUrl()

    assert.strictEqual(url, "https://www.youtube.com/embed/dQw4w9WgXcQ")
  })

  it("should be a playlist's embedded player", () => {
    const url = parsed(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    ).embedUrl()

    assert.strictEqual(
      url,
      "https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    )
  })
})

describe("CustomStream#locator", () => {
  it("should be a web view at the watch page", () => {
    const stream = parsed("https://youtu.be/dQw4w9WgXcQ")

    const locator = stream.locator()

    assert.deepStrictEqual(locator, { _tag: "WebView", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })
  })
})

function parsed(url: string, name?: string) {
  return Result.getOrThrow(CustomStream.parse(url, name))
}

function targetOf(url: string) {
  return parsed(url).target
}

function refused(url: string) {
  const result = CustomStream.parse(url)
  return Result.isFailure(result) ? result.failure : undefined
}
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run apps/web/src/custom/CustomStream.test.ts`
Expected: FAIL — `Cannot find module './CustomStream.ts'` (or every test failing on the missing export).

- [ ] **Step 3: Write `CustomStream.ts`**

Create `apps/web/src/custom/CustomStream.ts`:

```ts
import type { StreamLocator } from "@sportal/domain/Channel"
import { Result, Schema } from "effect"

/**
 * A custom stream's id, read from what it plays (`video.<id>`, `list.<id>`, or `list.<id>.<video id>`), so one video or
 * playlist is saved once however its address was written.
 */
export const CustomStreamId = Schema.String.pipe(Schema.brand("CustomStreamId"))
export type CustomStreamId = typeof CustomStreamId.Type

/** What a custom stream plays on YouTube: one video, or a playlist, from its start or from one of its videos. */
export const CustomTarget = Schema.TaggedUnion({
  Video: { videoId: Schema.String },
  Playlist: { listId: Schema.String, videoId: Schema.optionalKey(Schema.String) }
})
export type CustomTarget = typeof CustomTarget.Type

/** A YouTube video or playlist saved on this Display to watch in a tile, under the name its cards and tile show. */
export class CustomStream extends Schema.Class<CustomStream>("sportal/CustomStream")({
  id: CustomStreamId,
  name: Schema.String,
  target: CustomTarget
}) {
  /**
   * Reads a YouTube address: `youtube.com/watch?v=`, `youtu.be/<id>`, `youtube.com/live/<id>`, `youtube.com/shorts/<id>`,
   * `youtube.com/embed/<id>`, `youtube.com/playlist?list=`, or `watch?v=…&list=…` (the playlist, from that video), on
   * `www.`, `m.` or neither, with or without its scheme. With no name, or a blank one, it is "YouTube video" or "YouTube
   * playlist".
   */
  static parse(url: string, name?: string): Result.Result<CustomStream, NotYouTube> {
    const target = targetOf(url)
    if (target === undefined) return Result.fail(new NotYouTube({ url }))

    const id = CustomStreamId.make(idOf(target))
    const given = name?.trim() ?? ""
    const named = given === "" ? defaultName(target) : given
    return Result.succeed(new CustomStream({ id, name: named, target }))
  }

  /** The address the shell loads: YouTube's own watch page. */
  watchUrl(): string {
    return CustomTarget.match(this.target, {
      Video: ({ videoId }) => `https://www.youtube.com/watch?v=${videoId}`,
      Playlist: ({ listId, videoId }) =>
        `https://www.youtube.com/watch?list=${listId}${videoId === undefined ? "" : `&v=${videoId}`}`
    })
  }

  /** The address a plain browser plays in a frame: YouTube's embedded player. */
  embedUrl(): string {
    return CustomTarget.match(this.target, {
      Video: ({ videoId }) => `https://www.youtube.com/embed/${videoId}`,
      Playlist: ({ listId }) => `https://www.youtube.com/embed/videoseries?list=${listId}`
    })
  }

  /** What a custom tile carries for the shell to load: the watch page. */
  locator(): StreamLocator {
    return { _tag: "WebView", url: this.watchUrl() }
  }
}

/** An address that names no YouTube video or playlist: another site's, or a YouTube page with no id. */
export class NotYouTube extends Schema.TaggedError<NotYouTube>()("NotYouTube", { url: Schema.String }) {}

/** The video or playlist an address names; none for an address off YouTube, or naming neither. */
function targetOf(url: string): CustomTarget | undefined {
  const trimmed = url.trim()
  const address = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  if (!URL.canParse(address)) return undefined
  const { protocol, hostname, pathname, searchParams } = new URL(address)
  if (!["https:", "http:"].includes(protocol) || !youTubeHosts.includes(hostname)) return undefined

  const videoId = valid(videoIn(hostname, pathname, searchParams), videoIdForm)
  const listId = valid(searchParams.get("list") ?? undefined, listIdForm)
  if (listId !== undefined)
    return videoId === undefined ? { _tag: "Playlist", listId } : { _tag: "Playlist", listId, videoId }
  return videoId === undefined ? undefined : { _tag: "Video", videoId }
}

const youTubeHosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]

/** The video id where the address keeps it: youtu.be's path, `watch`'s `v`, or the segment after `live`, `shorts` or `embed`. */
function videoIn(hostname: string, pathname: string, searchParams: URLSearchParams): string | undefined {
  const [, first, second] = pathname.split("/")
  if (hostname === "youtu.be") return first
  if (first === "watch") return searchParams.get("v") ?? undefined
  // `embed/videoseries` is the embedded player's playlist page, not a video, though it is eleven letters long.
  return first !== undefined && ["live", "shorts", "embed"].includes(first) && second !== "videoseries"
    ? second
    : undefined
}

function valid(id: string | undefined, form: RegExp): string | undefined {
  return id !== undefined && form.test(id) ? id : undefined
}

const videoIdForm = /^[\w-]{11}$/
const listIdForm = /^[\w-]+$/

function idOf(target: CustomTarget): string {
  return CustomTarget.match(target, {
    Video: ({ videoId }) => `video.${videoId}`,
    Playlist: ({ listId, videoId }) =>
      videoId === undefined ? `list.${listId}` : `list.${listId}.${videoId}`
  })
}

function defaultName(target: CustomTarget): string {
  return CustomTarget.match(target, { Video: () => "YouTube video", Playlist: () => "YouTube playlist" })
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run apps/web/src/custom/CustomStream.test.ts`
Expected: PASS, 30 tests. (This module and its tests were run and type-checked against `effect@4.0.0` while this plan
was written, and are `biome check` clean as given.)

---

### Task 21 (phase 4, was task 2): `CustomStreams`: the saved list, kept in this browser

**Files:**
- Create: `apps/web/src/custom/CustomStreams.ts`
- Create: `apps/web/src/custom/CustomStreams.test.ts`
- Modify: `apps/web/src/TestWeb.ts`

**Interfaces:**
- Consumes: `CustomStream`, `CustomStreamId` (Task 1); `Atom.kvs`, `KeyValueStore.layerStorage` as
  `DisplayScreen.ts` uses them.
- Produces: `customStreams: Atom.Writable<ReadonlyArray<CustomStream>, CustomStreamsChange>` (localStorage key
  `sportal.custom`); `CustomStreamsChange` (`Data.TaggedEnum`: `Added({ stream })`, `Renamed({ id, name })`,
  `Removed({ id })`); `TestWeb.video`, `TestWeb.playlist`.

- [ ] **Step 1: Add the shared custom streams to `TestWeb.ts`**

In `apps/web/src/TestWeb.ts` add `import { CustomStream } from "./custom/CustomStream.ts"` to the imports, and add after
`irish`:

```ts
/** A YouTube video saved as a custom stream, named "Highlights". */
export const video = Result.getOrThrow(CustomStream.parse("https://youtu.be/dQw4w9WgXcQ", "Highlights"))

/** A YouTube playlist saved as a custom stream, from its start, named "Week 6". */
export const playlist = Result.getOrThrow(
  CustomStream.parse("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG", "Week 6")
)
```

(`Result` is already imported there.)

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/custom/CustomStreams.test.ts`:

```ts
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as TestWeb from "../TestWeb.ts"
import { CustomStream } from "./CustomStream.ts"
import * as CustomStreams from "./CustomStreams.ts"
import { CustomStreamsChange } from "./CustomStreams.ts"

describe("CustomStreams.customStreams", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should list nothing before a stream is added", () =>
    Effect.gen(function* () {
      const streams = yield* Atom.get(CustomStreams.customStreams).pipe(Effect.provide(AtomRegistry.layer))

      assert.deepStrictEqual(streams, [])
    })
  )

  it.effect("should list streams in the order they were added", () =>
    Effect.gen(function* () {
      const streams = yield* edits([
        CustomStreamsChange.Added({ stream: TestWeb.video }),
        CustomStreamsChange.Added({ stream: TestWeb.playlist })
      ])

      assert.deepStrictEqual(
        streams.map(({ id }) => id),
        [TestWeb.video.id, TestWeb.playlist.id]
      )
    })
  )

  it.effect(
    "should move a stream added again to the end, under its new name, rather than list it twice",
    () =>
      Effect.gen(function* () {
        const again = new CustomStream({ ...TestWeb.video, name: "Again" })

        const streams = yield* edits([
          CustomStreamsChange.Added({ stream: TestWeb.video }),
          CustomStreamsChange.Added({ stream: TestWeb.playlist }),
          CustomStreamsChange.Added({ stream: again })
        ])

        assert.deepStrictEqual(
          streams.map(({ name }) => name),
          ["Week 6", "Again"]
        )
      })
  )

  it.effect("should rename a saved stream", () =>
    Effect.gen(function* () {
      const streams = yield* edits([
        CustomStreamsChange.Added({ stream: TestWeb.video }),
        CustomStreamsChange.Renamed({ id: TestWeb.video.id, name: "Recap" })
      ])

      assert.deepStrictEqual(
        streams.map(({ name }) => name),
        ["Recap"]
      )
    })
  )

  it.effect("should remove a saved stream", () =>
    Effect.gen(function* () {
      const streams = yield* edits([
        CustomStreamsChange.Added({ stream: TestWeb.video }),
        CustomStreamsChange.Added({ stream: TestWeb.playlist }),
        CustomStreamsChange.Removed({ id: TestWeb.video.id })
      ])

      assert.deepStrictEqual(
        streams.map(({ id }) => id),
        [TestWeb.playlist.id]
      )
    })
  )

  it.effect("should keep the list in this browser", () =>
    Effect.gen(function* () {
      yield* edits([CustomStreamsChange.Added({ stream: TestWeb.video })])

      const kept = localStorage.getItem("sportal.custom") ?? ""

      assert.include(kept, '"videoId":"dQw4w9WgXcQ"')
    })
  )

  it.effect("should read a kept list that does not decode as empty", () =>
    Effect.gen(function* () {
      localStorage.setItem("sportal.custom", '[{"id":7}]')

      const streams = yield* Atom.get(CustomStreams.customStreams).pipe(Effect.provide(AtomRegistry.layer))

      assert.deepStrictEqual(streams, [])
    })
  )
})

/** The saved list after `changes`, written in order to a fresh registry. */
function edits(changes: ReadonlyArray<CustomStreamsChange>) {
  return Effect.gen(function* () {
    for (const change of changes) yield* Atom.set(CustomStreams.customStreams, change)
    return yield* Atom.get(CustomStreams.customStreams)
  }).pipe(Effect.provide(AtomRegistry.layer))
}
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm vitest run apps/web/src/custom/CustomStreams.test.ts`
Expected: FAIL — `Cannot find module './CustomStreams.ts'`.

- [ ] **Step 4: Write `CustomStreams.ts`**

Create `apps/web/src/custom/CustomStreams.ts`:

```ts
import { Data, Schema } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import { CustomStream, type CustomStreamId } from "./CustomStream.ts"

/**
 * The custom streams saved in this browser, in the order they were added. A change written to it is kept at once; a
 * kept list that does not read is an empty one.
 */
export const customStreams: Atom.Writable<ReadonlyArray<CustomStream>, CustomStreamsChange> = Atom.writable(
  (get) => get(kept),
  (ctx, change: CustomStreamsChange) => ctx.set(kept, edited(ctx.get(kept), change))
).pipe(Atom.keepAlive)

/**
 * A change to the saved custom streams: one added (last; one saved already moves there, under its new name), renamed,
 * or removed.
 */
export type CustomStreamsChange = Data.TaggedEnum<{
  Added: { readonly stream: CustomStream }
  Renamed: { readonly id: CustomStreamId; readonly name: string }
  Removed: { readonly id: CustomStreamId }
}>
export const CustomStreamsChange = Data.taggedEnum<CustomStreamsChange>()

const kept = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: "sportal.custom",
  schema: Schema.Array(CustomStream),
  defaultValue: (): ReadonlyArray<CustomStream> => []
}).pipe(Atom.keepAlive)

function edited(
  streams: ReadonlyArray<CustomStream>,
  change: CustomStreamsChange
): ReadonlyArray<CustomStream> {
  return CustomStreamsChange.$match(change, {
    Added: ({ stream }) => [...streams.filter((each) => each.id !== stream.id), stream],
    Renamed: ({ id, name }) =>
      streams.map((each) => (each.id === id ? new CustomStream({ ...each, name }) : each)),
    Removed: ({ id }) => streams.filter((each) => each.id !== id)
  })
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm vitest run apps/web/src/custom/CustomStreams.test.ts`
Expected: PASS, 7 tests. (Run against `effect@4.0.0` while this plan was written.)

---

### Task 22 (phase 4, was task 3): `CustomTile` on the Screen

**Files:**
- Modify: `packages/api/src/TileKey.ts`, and its test file beside it (phase 2's `TileKey.test.ts`)
- Modify: `apps/web/src/screen/Screen.ts`
- Modify: `apps/web/src/screen/Screen.test.ts`
- Modify: `apps/web/src/TestWeb.ts`

**Interfaces:**
- Consumes: `TileKey`, `TileKey.game`, `Tile.key` (phase 2); `CustomStreamId`, `CustomStream#locator` (Task 1).
- Produces:
  - `TileKey.custom(id: string): TileKey` — `custom:<id>`.
  - `Tile` case `CustomTile: { stream: CustomStreamId, name: Schema.String, locator: StreamLocator }`; `Tile.key` answers
    `TileKey.custom(stream)` for it.
  - `Tile.game(tile): GameId | undefined` (a stream or data tile's game) and `Tile.locator(tile): StreamLocator | undefined`
    (what the shell loads: a stream tile's channel's, a custom tile's own).
  - `ScreenCommand` case `AssignCustom: { tile: Schema.Int, stream: CustomStreamId, name: Schema.String, locator: StreamLocator }`.
  - `Screen#customTiles(stream: CustomStreamId): ReadonlyArray<{ index: number; tile: typeof Tile.cases.CustomTile.Type }>`.
  - `TestWeb.assignCustom(screen, tile, stream): Screen`.

- [ ] **Step 1: `TileKey.custom`, test first**

In phase 2's `packages/api/src/TileKey.test.ts`, add to the `describe` that tests `TileKey.game`:

```ts
  it("should key a custom stream's tile by its id, prefixed custom:", () => {
    const key = TileKey.custom("video.dQw4w9WgXcQ")

    assert.strictEqual(key, "custom:video.dQw4w9WgXcQ")
  })
```

Run: `pnpm vitest run packages/api/src/TileKey.test.ts` — Expected: FAIL (`TileKey.custom is not a function`).

In `packages/api/src/TileKey.ts`, add `custom` to the object phase 2 assigns onto the brand, beside `game` and written the
same way `game` is (phase 2 builds the branded value from the string; do the same with `` `custom:${id}` ``), with this
doc comment:

```ts
  /** A custom stream's tile: `custom:` and the stream's id. It takes the id as a string: the id's brand is the web's. */
```

The parameter is `id: string`, not `CustomStreamId`: `packages/api` cannot import `apps/web` (depcruise
`api-imports-only-domain`), and a `CustomStreamId` is a string, so callers pass it as it is. Run the test again —
Expected: PASS.

- [ ] **Step 2: Add `assignCustom` to `TestWeb.ts`**

After `assign` in `apps/web/src/TestWeb.ts` (it imports `ScreenCommand` as a type from `./screen/Screen.ts`; add it to
that import):

```ts
/** `screen` with `stream` in `tile` as a custom tile, as choosing it from the guide would put it there. */
export function assignCustom(screen: Screen, tile: number, stream: CustomStream) {
  const command: ScreenCommand = {
    _tag: "AssignCustom",
    tile,
    stream: stream.id,
    name: stream.name,
    locator: stream.locator()
  }
  return Result.getOrThrow(screen.apply(command, nowhere))
}
```

- [ ] **Step 3: Write the failing Screen tests**

In `apps/web/src/screen/Screen.test.ts`, import `TileKey` from `@sportal/api/TileKey` if phase 2 has not, and add before
`function some(`:

```ts
describe("Screen custom tiles", () => {
  it("should assign a custom stream as a custom tile carrying its watch page", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 1, TestWeb.video)

    assert.deepStrictEqual(screen.tiles[1], {
      _tag: "CustomTile",
      stream: TestWeb.video.id,
      name: "Highlights",
      locator: { _tag: "WebView", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
    })
  })

  it("should move a custom stream rather than show it twice", () => {
    const first = TestWeb.assignCustom(Screen.initial, 0, TestWeb.video)

    const second = TestWeb.assignCustom(first, 2, TestWeb.video)

    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.strictEqual(second.tiles[2]?._tag, "CustomTile")
  })

  it("should keep a game where it is when a custom stream is assigned beside it", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    assert.strictEqual(screen.tiles[0]?._tag, "StreamTile")
    assert.strictEqual(screen.tiles[1]?._tag, "CustomTile")
  })

  it("should give audio focus to a custom tile", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    const focused = run(screen, { _tag: "FocusAudio", tile: 1 })

    assert.deepStrictEqual(focused.audioFocus, Option.some(TileKey.custom(TestWeb.video.id)))
  })

  it("should solo a custom tile", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    const soloed = run(screen, { _tag: "Solo", tile: 1 })

    assert.deepStrictEqual(soloed.solo, Option.some(TileKey.custom(TestWeb.video.id)))
  })

  it("should promote a custom tile into the main tile", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    const promoted = run(screen, { _tag: "Promote", tile: 1 })

    assert.strictEqual(promoted.tiles[0]?._tag, "CustomTile")
  })

  it("should clear a custom tile", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 1, TestWeb.video)

    const cleared = run(screen, { _tag: "Clear", tile: 1 })

    assert.strictEqual(cleared.tiles[1]?._tag, "Empty")
  })

  it("should leave a custom tile as it was when what a source knows changes", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    const refreshed = screen.refresh(some(TestWeb.nowhere))

    assert.deepStrictEqual(refreshed.tiles[1], screen.tiles[1])
  })
})

describe("Screen#customTiles", () => {
  it("should list the tile showing a stream, benched as well as on screen", () => {
    const quad = TestWeb.assignCustom(Screen.initial, 3, TestWeb.video)
    const single = run(quad, { _tag: "SetLayout", layout: "Single" })

    const shown = single.customTiles(TestWeb.video.id)

    assert.deepStrictEqual(
      shown.map(({ index }) => index),
      [3]
    )
  })

  it("should be empty for a stream on no tile", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 0, TestWeb.video)

    const shown = screen.customTiles(TestWeb.playlist.id)

    assert.deepStrictEqual(shown, [])
  })
})
```

Add a row to the `tiles` table (the Tile wire tests):

```ts
  [
    "CustomTile",
    {
      _tag: "CustomTile",
      stream: "video.dQw4w9WgXcQ",
      name: "Highlights",
      locator: { _tag: "WebView", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
    }
  ]
```

and a row to the `commands` table, after `Assign`:

```ts
  {
    _tag: "AssignCustom",
    tile: 1,
    stream: "video.dQw4w9WgXcQ",
    name: "Highlights",
    locator: { _tag: "WebView", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
  },
```

Run: `pnpm vitest run apps/web/src/screen/Screen.test.ts`
Expected: FAIL — type errors and failures on `AssignCustom`, `CustomTile`, `customTiles`.

- [ ] **Step 4: Add the case, the statics and the command to `Screen.ts`**

Imports: add `StreamLocator` to the `@sportal/domain/Channel` import, and
`import { CustomStreamId } from "../custom/CustomStream.ts"`.

In the tagged union phase 2 assigns `key` onto (the `Schema.TaggedUnion({ Empty, StreamTile, DataTile })`), add after
`DataTile`:

```ts
  /** A saved YouTube video or playlist: its stream, its name, and what the shell loads, so a placement needs no lookup. */
  CustomTile: { stream: CustomStreamId, name: Schema.String, locator: StreamLocator }
```

In `key`'s body, add the case in the form phase 2's `StreamTile` case takes: a `CustomTile` answers
`TileKey.custom(tile.stream)`. `key`'s overloads stay as they are: a custom tile is occupied.

Beside `key`, in the same `Object.assign` object, add (`cases` is the name phase 2 gave the bare union; use that name):

```ts
  /** The game a tile shows: a stream or data tile's. An empty or custom tile shows none. */
  game(tile: typeof cases.Type): GameId | undefined {
    return cases.match(tile, {
      Empty: () => undefined,
      StreamTile: ({ game }) => game,
      DataTile: ({ game }) => game,
      CustomTile: () => undefined
    })
  },

  /** What the shell loads for a tile: a stream tile's channel's address, a custom tile's own; none without a video. */
  locator(tile: typeof cases.Type): StreamLocator | undefined {
    return cases.match(tile, {
      Empty: () => undefined,
      StreamTile: ({ channel }) => channel.locator,
      DataTile: () => undefined,
      CustomTile: ({ locator }) => locator
    })
  }
```

In `ScreenCommand`, after `Assign`:

```ts
  /** Puts a saved custom stream in a tile; one already on another tile moves. */
  AssignCustom: { tile: Schema.Int, stream: CustomStreamId, name: Schema.String, locator: StreamLocator },
```

In `Screen#apply`, replace the `Assign` case with these two cases (`Assign`'s behaviour is unchanged; its body moves into
`placed`):

```ts
      Assign: ({ tile, game }) =>
        tileAt(this, tile, () => Result.succeed(placed(this, tile, Screen.tileFor(game, availabilityOf(game))))),
      AssignCustom: ({ tile, stream, name, locator }) =>
        tileAt(this, tile, () =>
          Result.succeed(placed(this, tile, { _tag: "CustomTile", stream, name, locator }))
        ),
```

Add `placed` directly below `tileAt` (its first user's order: `apply` calls `tileAt`, then `placed`):

```ts
/**
 * This Screen's fields with `assigned` in tile `index`. What a tile shows appears in at most one tile, on screen or
 * benched: assigning it to another tile moves it.
 */
function placed(screen: Screen, index: number, assigned: Tile): Unsettled {
  const key = Tile.key(assigned)
  const tiles = screen.tiles.map((existing, at) =>
    at === index ? assigned : key !== undefined && holds(existing, key) ? empty : existing
  )
  return { ...screen, tiles }
}
```

(`holds(tile, key: TileKey)` is phase 2's. If phase 2 inlined the comparison instead, write
`Tile.key(existing) === key` in its place.)

Replace the body of `Screen#refresh`'s `this.tiles.map` callback, so only a tile with a game is re-resolved:

```ts
    const tiles = this.tiles.map((tile) => {
      const game = Tile.game(tile)
      if (game === undefined) return tile
      return Option.match(availabilityOf(game), {
        onNone: () => tile,
        onSome: (availability) =>
          Tile.guards.StreamTile(tile) ? movedWithinSource(tile, availability) : Screen.tileFor(game, availability)
      })
    })
```

and add to `refresh`'s doc comment, after its first sentence: "A custom tile has no game, and stays as it is."

Add a method after `nextEmptySlot`:

```ts
  /** Every tile showing the custom stream `stream`, on screen or benched, with its index in `tiles`. */
  customTiles(stream: CustomStreamId): ReadonlyArray<{ index: number; tile: typeof Tile.cases.CustomTile.Type }> {
    return this.tiles.flatMap((tile, index) =>
      Tile.guards.CustomTile(tile) && tile.stream === stream ? [{ index, tile }] : []
    )
  }
```

Then run `pnpm typecheck`. Every read of `.game` on a tile narrowed only by `!Tile.guards.Empty(...)` no longer
compiles; phase 2 moved the identity reads to `Tile.key`, and Tasks 4–8 change the rest (`ScreenView.tsx`,
`CommandPalette.tsx`, `TileBody.tsx`, `TileChrome.tsx`, `TileRects.ts`, `ScreenMap.tsx`, `Display.ts`). Any other the
check names reads a game's data: replace it with `Tile.game(tile)`.

- [ ] **Step 5: Run the Screen tests**

Run: `pnpm vitest run apps/web/src/screen/Screen.test.ts packages/api/src/TileKey.test.ts`
Expected: PASS.

---

### Task 23 (phase 4, was task 4): Custom tiles in the shell: placements, and whether the page plays

**Files:**
- Modify: `apps/web/src/screen/TileRects.ts`, `apps/web/src/screen/TileRects.test.ts`
- Modify: `apps/web/src/screen/TilePlacements.ts`
- Modify: `apps/web/src/shell/Shell.ts`

**Interfaces:**
- Consumes: `Tile.key`, `Tile.locator` (Task 3).
- Produces: `TileRects.placements` places a custom tile's view at its locator's address; `Shell` member
  `providerViews: boolean`; `TilePlacements.providerViews: Atom.Atom<boolean>`.

- [ ] **Step 1: Write the failing placement test**

In `apps/web/src/screen/TileRects.test.ts`, inside `describe("placements")`, add:

```ts
  it("should place a custom tile's view at its watch page, keyed by its stream", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    const [, custom] = placed(screen)

    assert.strictEqual(custom?.key, TileKey.custom(TestWeb.video.id))
    assert.strictEqual(custom?.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
  })
```

(import `TileKey` from `@sportal/api/TileKey` if phase 2 has not.) Run:
`pnpm vitest run apps/web/src/screen/TileRects.test.ts` — Expected: FAIL (one placement only).

- [ ] **Step 2: Place every tile with a video**

Replace `placements` in `apps/web/src/screen/TileRects.ts` (its parameters as phase 2 left them; the body reads the
key and the locator from the tile, so stream and custom tiles both get a view):

```ts
/**
 * What the shell must show for each tile with a video and a size: its view, in window pixels. `origin` is where the
 * Screen area sits in the window. Only `interacting`'s view gets the mouse.
 */
export function placements(
  screen: Screen,
  rects: ReadonlyArray<TileBounds>,
  origin: { x: number; y: number },
  interacting: TileKey | undefined
): Array<TilePlacement> {
  return screen.onScreen().flatMap((tile, index) => {
    const rect = rects[index]
    const key = Tile.key(tile)
    const locator = Tile.locator(tile)
    if (rect === undefined || rect.width === 0 || key === undefined || locator === undefined) return []
    const view = { url: locator.url, muted: !screen.hears(key), interactive: key === interacting }
    const video = videoBounds(rect)
    return [{ key, ...view, bounds: { ...video, x: video.x + origin.x, y: video.y + origin.y } }]
  })
}
```

Run the test file again — Expected: PASS (the existing placement tests too).

- [ ] **Step 3: Say whether provider views play the streams**

In `apps/web/src/shell/Shell.ts`, add to the service shape, after `openSignIn`:

```ts
    /**
     * Whether provider views lay the streams over the page: in the desktop shell. A plain browser has none, so the page
     * plays what it can itself.
     */
    readonly providerViews: boolean
```

and the member in each layer: `providerViews: true` in `layerBridge`, `providerViews: false` in `layerBrowser`, and
`providerViews: true` in `layerTest` (the test Shell stands in for the desktop shell: it records `SyncTiles`). Add to
`layerTest`'s doc comment: "It has provider views, as the desktop shell does."

In `apps/web/src/screen/TilePlacements.ts`, add `AsyncResult` to the `effect/reactivity` import and, after `placements`:

```ts
/**
 * Whether the shell's provider views play the tiles' videos. Until the Shell answers, it says they do, so the page never
 * starts a player of its own under a provider view.
 */
export const providerViews: Atom.Atom<boolean> = runtime
  .atom(
    Effect.gen(function* () {
      const shell = yield* Shell
      return shell.providerViews
    })
  )
  .pipe(Atom.map(AsyncResult.getOrElse(() => true)))
```

---

### Task 24 (phase 4, was task 5): The Display fold: choosing, editing, the YouTube form, Remove

**Files:**
- Modify: `packages/api/src/Hotkey.ts`, `packages/api/src/Hotkey.test.ts`
- Modify: `apps/web/src/display/Display.ts`, `apps/web/src/display/Display.test.ts`
- Modify: `apps/web/src/display/DisplayState.ts`, `apps/web/src/display/DisplayState.test.ts`
- Modify: `apps/web/src/guide/GuideItem.ts`

**Interfaces:**
- Consumes: `CustomStream`, `CustomStreamsChange`, `customStreams` (Tasks 1–2); `AssignCustom`, `Screen#customTiles`,
  `Tile.locator` (Task 3); phase 3's `GuideShelves`, `GuideItem`, `Overlay.Guide`.
- Produces:
  - `Hotkey` case `Remove: {}`: `Delete` or `Backspace`, only while `guideOpen`; a `Hotkey.keys` row in group `"Guide"`.
  - `GuideItem` cases `Custom({ stream: CustomStream })` and `AddCustom({})`.
  - `Overlay` case `CustomForm: { editing: CustomStream | undefined; back: Overlay }` — the YouTube form; `editing`
    renames a saved stream, none adds one; `back` is where closing it returns (the guide it was opened from, or none).
  - `DisplayInput` cases `ChosenCustom({ stream: CustomStream })`, `CustomEdited({ change: CustomStreamsChange })`,
    `CustomFormOpened({ editing: CustomStream | undefined })`.
  - `Display#chooseCustom(stream, screen): DisplayStep`, `Display#customEdited(change, screen): DisplayStep`,
    `Display#openCustomForm(editing): Display`, `Display#focusedItem(shelves): GuideItem | undefined`.
  - `DisplayState.editCustom: Atom.Writable<void, CustomStreamsChange>`: the list's one writer outside tests.

- [ ] **Step 1: The `Remove` hotkey, test first**

In `packages/api/src/Hotkey.test.ts` (phase 3 gave the `key` helper's `Modifiers` a `guideOpen`), add to
`describe("Hotkey.of")`:

```ts
  it.each(["Delete", "Backspace"])("should read %s as Remove while the guide is open", (code) => {
    const hotkey = key(code, { guideOpen: true })

    assert.deepStrictEqual(hotkey, { _tag: "Remove" })
  })

  it.each(["Delete", "Backspace"])("should leave %s to the page while the guide is closed", (code) => {
    const hotkey = key(code)

    assert.isUndefined(hotkey)
  })
```

and `{ _tag: "Remove" }` to the `wire` table. Run `pnpm vitest run packages/api/src/Hotkey.test.ts` — Expected: FAIL.

In `packages/api/src/Hotkey.ts`: add the case to the union, after phase 3's `Info`:

```ts
    /** Remove the focused custom stream from the saved list. */
    Remove: {},
```

In `of`, where phase 3 reads the guide-only codes while `key.guideOpen` is true (beside `Enter` → `Confirm`), add:

```ts
        case "Delete":
        case "Backspace":
          return { _tag: "Remove" }
```

so both read as `Remove` only while the guide is open, and as nothing otherwise. Add a row to `keys`, after phase 3's
last `"Guide"` row (its `press` carries `guideOpen` as phase 3's guide rows do):

```ts
      {
        group: "Guide",
        keys: ["Delete"],
        does: "Remove the focused YouTube stream",
        press: { code: "Delete", guideOpen: true },
        hotkey: { _tag: "Remove" }
      },
```

Run the test file again — Expected: PASS (phase 3's test that every `keys` row reads back included).

- [ ] **Step 2: The guide's custom cards**

In `apps/web/src/guide/GuideItem.ts`, import `type { CustomStream } from "../custom/CustomStream.ts"` and add the cases
after `Game`:

```ts
  /** A saved custom stream's card, under the Custom entry. */
  Custom: { readonly stream: CustomStream }
  /** The last card under Custom: it opens the YouTube form. */
  AddCustom: object
```

and extend the enum's doc comment: "…a saved custom stream, or the card that adds one."

- [ ] **Step 3: Write the failing Display tests**

In `apps/web/src/display/Display.test.ts`, add imports:

```ts
import { TileKey } from "@sportal/api/TileKey"
import { CustomStreamsChange } from "../custom/CustomStreams.ts"
import type { GuideShelves } from "../guide/GuideShelves.ts"
import { GuideItem } from "../guide/GuideItem.ts"
```

(`GuideShelves` from wherever phase 3 exports it, and `Overlay` added to the `./Display.ts` import), then add:

```ts
describe("Display#chooseCustom", () => {
  it("should assign a custom stream to the selected slot and select the next empty one", () => {
    const screen = TestWeb.fill([TestWeb.bama])
    const display = Display.initial.select(1, screen).display

    const { display: next, commands } = display.chooseCustom(TestWeb.video, screen)

    assert.deepStrictEqual(commands, [
      {
        _tag: "AssignCustom",
        tile: 1,
        stream: TestWeb.video.id,
        name: "Highlights",
        locator: TestWeb.video.locator()
      }
    ])
    assert.strictEqual(next.selected, 2)
  })

  it("should leave a custom stream on screen where it is", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 2, TestWeb.video)

    const { commands } = Display.initial.chooseCustom(TestWeb.video, screen)

    assert.deepStrictEqual(commands, [])
  })

  it("should swap a benched custom stream into the selected slot", () => {
    const quad = TestWeb.assignCustom(Screen.initial, 3, TestWeb.video)
    const pair = Result.getOrThrow(quad.apply({ _tag: "SetLayout", layout: "Pair" }, TestWeb.nowhere))

    const { commands } = Display.initial.chooseCustom(TestWeb.video, pair)

    assert.deepStrictEqual(commands[0], { _tag: "Swap", a: 3, b: 0 })
  })

  it("should close the guide once a custom stream is chosen", () => {
    const display = new Display({ ...Display.initial, overlay: customGuide })

    const { display: next } = display.chooseCustom(TestWeb.video, Screen.initial)

    assert.strictEqual(next.overlay._tag, "None")
  })
})

describe("Display#customEdited", () => {
  it("should clear every tile showing a removed stream", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    const { commands } = Display.initial.customEdited(
      CustomStreamsChange.Removed({ id: TestWeb.video.id }),
      screen
    )

    assert.deepStrictEqual(commands, [{ _tag: "Clear", tile: 1 }])
  })

  it("should give every tile showing a renamed stream its new name", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 1, TestWeb.video)

    const { commands } = Display.initial.customEdited(
      CustomStreamsChange.Renamed({ id: TestWeb.video.id, name: "Recap" }),
      screen
    )

    assert.deepStrictEqual(commands, [
      { _tag: "AssignCustom", tile: 1, stream: TestWeb.video.id, name: "Recap", locator: TestWeb.video.locator() }
    ])
  })

  it("should send nothing for a stream added to the list", () => {
    const { commands } = Display.initial.customEdited(
      CustomStreamsChange.Added({ stream: TestWeb.video }),
      Screen.initial
    )

    assert.deepStrictEqual(commands, [])
  })
})

describe("Display custom tiles", () => {
  it("should interact with a custom tile's player", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 0, TestWeb.video)

    const { display } = Display.initial.press({ _tag: "Interact" }, screen)

    assert.strictEqual(display.interactingOn(screen), TileKey.custom(TestWeb.video.id))
  })

  it("should do nothing in the fold on Remove: the saved list is DisplayState's", () => {
    const display = new Display({ ...Display.initial, overlay: customGuide })

    const step = display.press({ _tag: "Remove" }, Screen.initial)

    assert.strictEqual(step.display, display)
    assert.deepStrictEqual(step.commands, [])
  })
})

describe("Display#focusedItem", () => {
  it("should be the card the guide's focus is on", () => {
    const display = new Display({ ...Display.initial, overlay: customGuide })

    const item = display.focusedItem(customShelves)

    assert.deepStrictEqual(item, GuideItem.Custom({ stream: TestWeb.video }))
  })

  it("should be none while the focus is on the rail", () => {
    const overlay = Overlay.Guide({ level: "Full", entry: "Custom", focus: { rail: true, shelf: 0, item: 0 } })
    const display = new Display({ ...Display.initial, overlay })

    const item = display.focusedItem(customShelves)

    assert.isUndefined(item)
  })
})

describe("Display guide Custom entry", () => {
  it("should assign a custom stream on Confirm on its card, and close the guide", () => {
    const display = new Display({ ...Display.initial, overlay: customGuide })

    const step = display.apply(
      DisplayInput.Pressed({ hotkey: { _tag: "Confirm" } }),
      Screen.initial,
      customShelves
    )

    assert.strictEqual(step.commands[0]?._tag, "AssignCustom")
    assert.strictEqual(step.display.overlay._tag, "None")
  })

  it("should open the YouTube form on Confirm on the add card", () => {
    const overlay = Overlay.Guide({ level: "Full", entry: "Custom", focus: { rail: false, shelf: 0, item: 1 } })
    const display = new Display({ ...Display.initial, overlay })

    const step = display.apply(
      DisplayInput.Pressed({ hotkey: { _tag: "Confirm" } }),
      Screen.initial,
      customShelves
    )

    assert.strictEqual(step.display.overlay._tag, "CustomForm")
  })
})

describe("Display YouTube form", () => {
  it("should go back to the guide, at its focus, when the form closes", () => {
    const opened = new Display({ ...Display.initial, overlay: customGuide }).openCustomForm(undefined)

    const closed = opened.close()

    assert.deepStrictEqual(closed.overlay, customGuide)
  })

  it("should close to nothing when it was opened from outside the guide", () => {
    const opened = new Display({ ...Display.initial, overlay: Overlay.Palette() }).openCustomForm(undefined)

    const closed = opened.close()

    assert.strictEqual(closed.overlay._tag, "None")
  })

  it("should hold the stream it renames", () => {
    const opened = Display.initial.openCustomForm(TestWeb.video)

    assert.isTrue(Overlay.$is("CustomForm")(opened.overlay) && opened.overlay.editing === TestWeb.video)
  })
})

/** The full guide on Custom, focused on its first card. */
const customGuide = Overlay.Guide({ level: "Full", entry: "Custom", focus: { rail: false, shelf: 0, item: 0 } })

/** One saved stream, then the add card, under every entry. */
const customShelves: GuideShelves = () => [[GuideItem.Custom({ stream: TestWeb.video }), GuideItem.AddCustom()]]
```

Add `Result` to the `effect` import. Run `pnpm vitest run apps/web/src/display/Display.test.ts` — Expected: FAIL.

- [ ] **Step 4: Fold the custom inputs in `Display.ts`**

Imports: `import type { CustomStream } from "../custom/CustomStream.ts"` and
`import { CustomStreamsChange } from "../custom/CustomStreams.ts"` (a value: the fold matches on it). `TileKey`,
`GuideItem` and `GuideShelves` are imported by phases 2–3.

`Overlay`: add the case.

```ts
/**
 * The one overlay a Display has open, or none. `CustomForm` is the YouTube form: renaming `editing`, or adding a stream
 * without one; closing it goes `back`. Above the class: `Display.initial` reads it when the class is defined.
 */
```

and in the enum, `CustomForm: { readonly editing: CustomStream | undefined; readonly back: Overlay }`. (A recursive
`Data.TaggedEnum` type-checks: tried against `effect@4.0.0` while this plan was written.)

Whatever type `Opened({ overlay })` and `open(overlay)` take (phase 3 left out `"Guide"`, which carries fields): leave
out `"CustomForm"` the same way. It is opened by `CustomFormOpened`.

`DisplayInput`: add, after `Chosen`:

```ts
  ChosenCustom: { readonly stream: CustomStream }
  CustomEdited: { readonly change: CustomStreamsChange }
  CustomFormOpened: { readonly editing: CustomStream | undefined }
```

and to its doc comment: "…a game or a custom stream chosen for the selected tile, a change to the saved custom streams,
the YouTube form opened…".

In `apply`'s `$match`, add:

```ts
      ChosenCustom: ({ stream }) => this.chooseCustom(stream, screen),
      CustomEdited: ({ change }) => this.customEdited(change, screen),
      CustomFormOpened: ({ editing }) => DisplayStep.of(this.openCustomForm(editing)),
```

In `press`'s `Hotkey.match`, add after `FullScreen`:

```ts
      Remove: () => DisplayStep.of(this),
```

and extend `press`'s doc comment: "`Remove` does nothing here either: it edits the saved custom streams, which
`DisplayState` holds."

Where phase 3's `Confirm` (and `GuideItemChosen`) match the chosen `GuideItem`, add its two cases beside `Game`:

```ts
          Custom: ({ stream }) => this.chooseCustom(stream, screen),
          AddCustom: () => DisplayStep.of(this.openCustomForm(undefined)),
```

`focusedItem`: if phase 3 already reads the focused card through a private helper for `Confirm`, turn that helper into
this method and have `Confirm` call it, so there is one reading; otherwise add it after `interactingOn`:

```ts
  /** The guide card the focus is on: none while the guide is closed, or while the focus is on the rail. */
  focusedItem(shelves: GuideShelves): GuideItem | undefined {
    if (!Overlay.$is("Guide")(this.overlay) || this.overlay.focus.rail) return undefined
    const { entry, level, focus } = this.overlay
    return shelves(entry, level)[focus.shelf]?.[focus.item]
  }
```

Replace `interactingOn` and the `Interact` case, so any tile with a provider view (a stream tile or a custom tile) can
take the mouse:

```ts
  /**
   * The interacting tile, while the selected slot still holds it; otherwise none. It returns when its tile is back in
   * the selected slot.
   */
  interactingOn(screen: Screen): TileKey | undefined {
    const tile = screen.onScreen()[this.selectedOn(screen)]
    return tile !== undefined && Tile.locator(tile) !== undefined && Tile.key(tile) === this.interacting
      ? this.interacting
      : undefined
  }
```

```ts
      Interact: () => {
        const tile = screen.onScreen()[this.selectedOn(screen)]
        const key = tile === undefined || Tile.locator(tile) === undefined ? undefined : Tile.key(tile)
        if (key === undefined) return DisplayStep.of(this)
        const interacting = this.interactingOn(screen) === undefined ? key : undefined
        return DisplayStep.of(new Display({ ...this, interacting }))
      },
```

(Phase 3 reads `KeyI` as `Info` while the guide is open; the `Interact` case is unchanged otherwise.)

Replace `choose` with `choose`, `chooseCustom` and `place` (the body of phase 2's `choose`, with the key and the assign
command passed in):

```ts
  /** Puts game `game` in the selected slot, as `place` puts anything. */
  choose(game: GameId, screen: Screen): DisplayStep {
    return this.place(TileKey.game(game), (tile) => ({ _tag: "Assign", tile, game }), screen)
  }

  /** Puts a saved custom stream in the selected slot, as `place` puts anything, and closes what is open. */
  chooseCustom(stream: CustomStream, screen: Screen): DisplayStep {
    const { display, commands } = this.place(
      TileKey.custom(stream.id),
      (tile) => ({ _tag: "AssignCustom", tile, stream: stream.id, name: stream.name, locator: stream.locator() }),
      screen
    )
    return DisplayStep.of(new Display({ ...display, overlay: Overlay.None() }), commands)
  }

  /**
   * Puts what `key` names in the selected slot: benched, it is swapped in; on no tile, `assign` puts it there; on
   * screen, it stays where it is. Then selects the next empty slot, so the next choice fills it, or keeps the selection
   * when none is left.
   */
  place(key: TileKey, assign: (tile: number) => ScreenCommand, screen: Screen): DisplayStep {
    if (screen.slotOf(key) !== undefined) return DisplayStep.of(this)
    const slot = this.selectedOn(screen)
    const bench = screen.benched().find((each) => each.key === key)
    const { display, commands } = this.select(screen.nextEmptySlot(slot) ?? slot, screen)
    const placed: ScreenCommand = bench === undefined ? assign(slot) : { _tag: "Swap", a: bench.tile, b: slot }
    return DisplayStep.of(display, [placed, ...commands])
  }
```

If phase 3 closes the guide after a game is chosen inside `choose`, keep that in `choose` (`chooseCustom` closes on its
own, above). Add after `place`:

```ts
  /**
   * What a change to the saved custom streams does on this Screen: a removed stream's tiles are cleared, a renamed one's
   * take its new name, and an added one changes nothing.
   */
  customEdited(change: CustomStreamsChange, screen: Screen): DisplayStep {
    const commands = CustomStreamsChange.$match(change, {
      Added: (): ReadonlyArray<ScreenCommand> => [],
      Renamed: ({ id, name }) =>
        screen
          .customTiles(id)
          .map(({ index, tile }): ScreenCommand => ({
            _tag: "AssignCustom",
            tile: index,
            stream: id,
            name,
            locator: tile.locator
          })),
      Removed: ({ id }) => screen.customTiles(id).map(({ index }): ScreenCommand => ({ _tag: "Clear", tile: index }))
    })
    return DisplayStep.of(this, commands)
  }

  /**
   * Opens the YouTube form: to rename `editing`, or, without it, to add a stream. Closing it goes back to the guide it
   * was opened from, at the same focus, or to nothing.
   */
  openCustomForm(editing: CustomStream | undefined): Display {
    const back = Overlay.$is("Guide")(this.overlay) ? this.overlay : Overlay.None()
    return new Display({ ...this, overlay: Overlay.CustomForm({ editing, back }) })
  }
```

Replace `close`:

```ts
  /** Closes what is open: the YouTube form goes back to where it was opened from, anything else to nothing. */
  close(): Display {
    const overlay = Overlay.$is("CustomForm")(this.overlay) ? this.overlay.back : Overlay.None()
    return new Display({ ...this, overlay })
  }
```

(Phase 3's `Unsolo` steps Full → Ribbon → None and otherwise calls `close()`, so Escape from the form goes back too. If
phase 6's `GamePage({ back })` lands first, its `back` joins this same conditional.)

Run `pnpm vitest run apps/web/src/display/Display.test.ts` — Expected: PASS, the existing tests too.

- [ ] **Step 5: `editCustom` and the `Remove` route in `DisplayState.ts`, test first**

In `apps/web/src/display/DisplayState.test.ts` add imports
`import * as CustomStreams from "../custom/CustomStreams.ts"` and
`import { CustomStreamsChange } from "../custom/CustomStreams.ts"`, and add inside `describe("DisplayState")`:

```ts
  it.effect("should clear a removed custom stream's tile and drop it from the list", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const [screen, streams] = yield* Effect.gen(function* () {
        yield* Atom.set(DisplayState.editCustom, CustomStreamsChange.Added({ stream: TestWeb.video }))
        yield* Atom.set(DisplayState.display, DisplayInput.ChosenCustom({ stream: TestWeb.video }))
        yield* TestWeb.until(DisplayScreen.screen, (each) => each.customTiles(TestWeb.video.id).length === 1)
        yield* Atom.set(DisplayState.editCustom, CustomStreamsChange.Removed({ id: TestWeb.video.id }))
        const screen = yield* TestWeb.until(
          DisplayScreen.screen,
          (each) => each.customTiles(TestWeb.video.id).length === 0
        )
        const streams = yield* Atom.get(CustomStreams.customStreams)
        return [screen, streams] as const
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(screen.tiles[0]?._tag, "Empty")
      assert.deepStrictEqual(streams, [])
    })
  )

  it.effect("should remove the custom stream whose guide card has the focus on Remove", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const streams = yield* Effect.gen(function* () {
        yield* Atom.set(DisplayState.editCustom, CustomStreamsChange.Added({ stream: TestWeb.video }))
        yield* Atom.set(DisplayState.display, DisplayInput.GuideOpened({ entry: "Custom" }))
        yield* Atom.set(DisplayState.pressed, { _tag: "Remove" })
        return yield* Atom.get(CustomStreams.customStreams)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(streams, [])
    })
  )
```

(The second test takes phase 3's `GuideOpened({ entry })` to open the full guide focused on its first card,
`{ rail: false, shelf: 0, item: 0 }`. If phase 3 opens it with the focus elsewhere, write the `Move` presses that reach
the first card after `GuideOpened`, as phase 3's own tests do.)

Run `pnpm vitest run apps/web/src/display/DisplayState.test.ts` — Expected: FAIL (`editCustom` missing).

In `apps/web/src/display/DisplayState.ts`, add imports `import * as CustomStreams from "../custom/CustomStreams.ts"`,
`import { CustomStreamsChange } from "../custom/CustomStreams.ts"`, and `GuideItem` from `../guide/GuideItem.ts`
(phase 3 imports `GuideShelves` for the fold). Add after `pressed`:

```ts
/**
 * Edits the custom streams saved in this browser, and follows the change on the Screen: a removed stream's tiles are
 * cleared, and a renamed one's take its new name.
 */
export const editCustom: Atom.Writable<void, CustomStreamsChange> = Atom.writable(
  () => undefined,
  (ctx, change: CustomStreamsChange) =>
    Atom.batch(() => {
      ctx.set(CustomStreams.customStreams, change)
      ctx.set(display, DisplayInput.CustomEdited({ change }))
    })
).pipe(Atom.keepAlive)
```

In `route`, add before `Match.orElse`:

```ts
    Match.tag("Remove", () => removeFocused(ctx)),
```

and add below `route`:

```ts
/** Removes the custom stream whose guide card has the focus; no other card is removed. */
function removeFocused(ctx: Atom.WriteContext<void>) {
  const focused = ctx.get(display).focusedItem(ctx.get(GuideShelves.shelves))
  if (focused !== undefined && GuideItem.$is("Custom")(focused))
    ctx.set(editCustom, CustomStreamsChange.Removed({ id: focused.stream.id }))
}
```

(`GuideShelves.shelves` is phase 3's atom, imported the way `display`'s write already reads it.) Extend `pressed`'s doc
comment: "`Remove` removes the focused custom stream, through `editCustom`."

Removing the focused card needs no focus fix: the removed card sat before the add card, which slides into its index.

Run the test file again — Expected: PASS.

---

### Task 25 (phase 4, was task 6): The guide's Custom entry

**Files:**
- Modify: `apps/web/src/guide/GuideShelves.ts`, `apps/web/src/guide/GuideShelves.test.ts`
- Modify: `apps/web/src/guide/GuideRail.tsx`, `apps/web/src/guide/FullGuide.tsx`, `apps/web/src/guide/Ribbon.tsx`
- Modify: the module holding phase 3's ordered rail entries (the list `NextEntry` / `PreviousEntry` step through)
- Create: `apps/web/src/custom/CustomCard.tsx`

**Interfaces:**
- Consumes: `customStreams` (Task 2), `GuideItem.Custom` / `AddCustom` (Task 5), `DisplayState.editCustom` (Task 5).
- Produces: `guideShelves(…, custom: ReadonlyArray<CustomStream>)`; under `"Custom"`, at either level, one shelf: each
  saved stream's card in saved order, then the add card. Components `CustomCard`, `AddCustomCard`.

- [ ] **Step 1: Write the failing shelf tests**

In `apps/web/src/guide/GuideShelves.test.ts` add (the call is phase 3's, with the saved streams as its new last
argument; `noGames` is typed as `guideShelves`' first parameter, shown here as today's listed games; import `type ListedGame` from `@sportal/api/ListedGame`, and `GuideItem` and
`TestWeb` if phase 3's tests do not):

```ts
/** No games today. */
const noGames: ReadonlyArray<ListedGame> = []

describe("guideShelves Custom", () => {
  it("should list the saved streams in order, then the add card", () => {
    const shelves = guideShelves(noGames, [TestWeb.video, TestWeb.playlist])

    const custom = shelves("Custom", "Full")

    assert.deepStrictEqual(custom, [
      [
        GuideItem.Custom({ stream: TestWeb.video }),
        GuideItem.Custom({ stream: TestWeb.playlist }),
        GuideItem.AddCustom()
      ]
    ])
  })

  it("should list only the add card while no stream is saved", () => {
    const shelves = guideShelves(noGames, [])

    const custom = shelves("Custom", "Ribbon")

    assert.deepStrictEqual(custom, [[GuideItem.AddCustom()]])
  })

  it("should keep the saved streams out of every league's shelves", () => {
    const shelves = guideShelves(noGames, [TestWeb.video])

    const nfl = shelves("nfl", "Full")

    assert.isFalse(nfl.flat().some(GuideItem.$is("Custom")))
  })
})
```

Run `pnpm vitest run apps/web/src/guide/GuideShelves.test.ts` — Expected: FAIL.

- [ ] **Step 2: Shelve the saved streams**

In `apps/web/src/guide/GuideShelves.ts`: add the parameter `custom: ReadonlyArray<CustomStream>` last to
`guideShelves`, and, at the top of the function it returns (before any league filtering):

```ts
    if (entry === "Custom")
      return [[...custom.map((stream) => GuideItem.Custom({ stream })), GuideItem.AddCustom()]]
```

Add to its doc comment: "Under Custom, at either level, one shelf: the saved streams, then the card that adds one."
In the `shelves` atom, pass `get(CustomStreams.customStreams)` as the new argument
(`import * as CustomStreams from "../custom/CustomStreams.ts"`).

Run the test file again — Expected: PASS.

- [ ] **Step 3: The Custom rail entry**

Append `"Custom"` to the end of phase 3's ordered rail entries (after the last league), so `]` and `[` reach it. In
`GuideRail.tsx`, render it after the leagues with the label **Custom** and, beside it, the number of saved streams
(`useAtomValue(CustomStreams.customStreams).length`) where the All live entry shows its live count.

- [ ] **Step 4: The cards**

Create `apps/web/src/custom/CustomCard.tsx` (use the radius, surface and focus classes phase 3's `GameCard` uses for
the current theme where they differ from the ones below):

```tsx
import { ListVideo, MonitorPlay, Plus, X } from "lucide-react"
import { cn } from "@/design/ClassName"
import { type CustomStream, CustomTarget } from "./CustomStream.ts"

/**
 * A saved YouTube stream's card in the guide: its name, and whether it is a video or a playlist. Choosing it watches it
 * in the selected tile; its ×, shown while it is focused or hovered, removes it from the list.
 */
export function CustomCard(props: {
  stream: CustomStream
  focused: boolean
  compact: boolean
  onChoose: () => void
  onRemove: () => void
}) {
  const video = CustomTarget.guards.Video(props.stream.target)
  const Glyph = video ? MonitorPlay : ListVideo
  return (
    <div className={cn("group relative", frame(props.focused, props.compact))}>
      <button
        type="button"
        onClick={props.onChoose}
        className="flex h-full w-full flex-col items-start justify-between gap-1 p-3 text-left"
      >
        <Glyph className="size-5 text-muted-foreground" />
        <span className="line-clamp-2 font-medium text-sm">{props.stream.name}</span>
        {!props.compact && (
          <span className="label-caps text-[10px] text-muted-foreground">{video ? "Video" : "Playlist"}</span>
        )}
      </button>
      <button
        type="button"
        aria-label={`Remove ${props.stream.name}`}
        title="Remove · Delete"
        onClick={props.onRemove}
        className={cn(
          "absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-sm text-muted-foreground hover:text-destructive",
          props.focused ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        )}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

/** The last card under Custom: it opens the YouTube form. */
export function AddCustomCard(props: { focused: boolean; compact: boolean; onChoose: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onChoose}
      className={cn(
        "flex flex-col items-center justify-center gap-1 border-dashed text-muted-foreground",
        frame(props.focused, props.compact)
      )}
    >
      <Plus className="size-5" />
      <span className="text-sm">Add YouTube</span>
    </button>
  )
}

function frame(focused: boolean, compact: boolean) {
  return cn(
    "shrink-0 rounded-md border bg-card transition-transform duration-100 motion-reduce:transition-none",
    compact ? "h-14 w-44" : "h-32 w-56",
    focused && "z-10 scale-[1.04] ring-2 ring-foreground"
  )
}
```

- [ ] **Step 5: Render them in the guide**

In `FullGuide.tsx` and `Ribbon.tsx`, where phase 3 renders each `GuideItem` with `GuideItem.$match` (or a `Game`
check), add the two cases. With `input = useAtomSet(DisplayState.display)` and
`edit = useAtomSet(DisplayState.editCustom)`, and `shelf`, `item` and `focused` as phase 3's game card gets them:

```tsx
          Custom: ({ stream }) => (
            <CustomCard
              key={stream.id}
              stream={stream}
              focused={focused}
              compact={false}
              onChoose={() => input(DisplayInput.GuideItemChosen({ shelf, item }))}
              onRemove={() => edit(CustomStreamsChange.Removed({ id: stream.id }))}
            />
          ),
          AddCustom: () => (
            <AddCustomCard
              key="add"
              focused={focused}
              compact={false}
              onChoose={() => input(DisplayInput.GuideItemChosen({ shelf, item }))}
            />
          ),
```

This is `FullGuide.tsx`'s; in `Ribbon.tsx` both cards take `compact={true}`, so they sit in the ribbon's row.
In `FullGuide.tsx`, the Custom entry's one shelf is headed **YouTube** where a league's are headed Live now, Later
today and Final.

---

### Task 26 (phase 4, was task 7): The YouTube form, the palette, and the tile

**Files:**
- Create: `apps/web/src/custom/CustomStreamForm.tsx`
- Modify: `apps/web/src/display/DisplayView.tsx`
- Modify: `apps/web/src/display/CommandPalette.tsx`
- Modify: `apps/web/src/screen/TileBody.tsx`, `apps/web/src/screen/TileChrome.tsx`, `apps/web/src/screen/ScreenView.tsx`

**Interfaces:**
- Consumes: `Overlay.CustomForm`, `DisplayInput.ChosenCustom` / `CustomFormOpened`, `DisplayState.editCustom`
  (Task 5); `TilePlacements.providerViews` (Task 4); `CustomStream.parse`, `embedUrl` (Task 1).
- Produces: component `CustomStreamForm`.

- [ ] **Step 1: The form**

Create `apps/web/src/custom/CustomStreamForm.tsx`:

```tsx
import { useAtomSet } from "@effect/atom-react"
import { Result } from "effect"
import { type FormEvent, useId, useState } from "react"
import { Button } from "@/design/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/dialog"
import { DisplayInput } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { CustomStream } from "./CustomStream.ts"
import { CustomStreamsChange } from "./CustomStreams.ts"

/**
 * The YouTube form. Without `editing`, a video or playlist address and a name: saved, then watched in the selected
 * tile; an address that is not YouTube's says so under its field. With `editing`, only the name, to rename it. Mounted
 * while open, so each opening starts blank.
 */
export function CustomStreamForm(props: {
  editing: CustomStream | undefined
  onOpenChange: (open: boolean) => void
}) {
  const input = useAtomSet(DisplayState.display)
  const edit = useAtomSet(DisplayState.editCustom)
  const [url, setUrl] = useState("")
  const [name, setName] = useState(props.editing?.name ?? "")
  const [refused, setRefused] = useState(false)
  const refusal = useId()
  const adding = props.editing === undefined

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (props.editing !== undefined) {
      edit(CustomStreamsChange.Renamed({ id: props.editing.id, name: name.trim() }))
      return props.onOpenChange(false)
    }
    Result.match(CustomStream.parse(url, name), {
      onFailure: () => setRefused(true),
      onSuccess: (stream) => {
        edit(CustomStreamsChange.Added({ stream }))
        input(DisplayInput.ChosenCustom({ stream }))
      }
    })
  }

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="top-20 translate-y-0 gap-3 border-border bg-popover sm:max-w-md">
        <div>
          <DialogTitle className="label-caps text-xs">{adding ? "Add YouTube" : "Rename"}</DialogTitle>
          <DialogDescription className="text-xs">
            {props.editing === undefined
              ? "A video or playlist address. It plays in the selected tile."
              : props.editing.name}
          </DialogDescription>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          {adding && (
            <label className="flex flex-col gap-1 text-sm">
              Address
              <input
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value)
                  setRefused(false)
                }}
                placeholder="https://www.youtube.com/watch?v=…"
                aria-invalid={refused}
                aria-describedby={refused ? refusal : undefined}
                className={field}
              />
              {refused && (
                <span id={refusal} className="text-destructive text-xs">
                  That is not a YouTube video or playlist address.
                </span>
              )}
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={adding ? "YouTube video" : ""}
              className={field}
            />
          </label>
          <Button type="submit" disabled={adding ? url.trim() === "" : name.trim() === ""}>
            {adding ? "Watch" : "Rename"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const field =
  "h-9 rounded-sm border bg-background px-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
```

Notes for the implementer: Radix's dialog focuses its first field on open (no `autoFocus`, which biome's a11y rules
refuse). `DialogContent` already takes `useOverlayRef`, so Covering hides the videos under the form. Keys typed in the
fields are the fields' (`Shell`'s `isTyping`), so Enter submits, and Delete, Backspace and Escape are not hotkeys there;
Escape closes the dialog through `onOpenChange(false)`, which is `Closed`, which goes `back`. If `aria-describedby`
with `undefined` trips `exactOptionalPropertyTypes` under React's types, pass `refused ? refusal : ""` instead.

- [ ] **Step 2: Mount it in `DisplayView.tsx`**

Import `CustomStreamForm` and `Overlay` (from `./Display.ts`), and beside the other overlays:

```tsx
      {Overlay.$is("CustomForm")(display.overlay) && (
        <CustomStreamForm
          key={display.overlay.editing?.id ?? "add"}
          editing={display.overlay.editing}
          onOpenChange={closeOverlay}
        />
      )}
```

- [ ] **Step 3: The palette**

In `apps/web/src/display/CommandPalette.tsx`:

Imports: `Fragment` from `react`, `import * as CustomStreams from "../custom/CustomStreams.ts"`,
`import { CustomStreamsChange } from "../custom/CustomStreams.ts"`.

In the component, after `const { value } = useAtomValue(Games.today)`:

```ts
  const streams = useAtomValue(CustomStreams.customStreams)
  const edit = useAtomSet(DisplayState.editCustom)
```

Replace `occupied`, so a custom tile is named by its own name:

```ts
  const occupied = screen.onScreen().flatMap((tile, slot) => {
    if (Tile.guards.Empty(tile)) return []
    const game = Tile.game(tile)
    const name = Tile.guards.CustomTile(tile)
      ? tile.name
      : (snapshots.find((each) => each.id === game)?.scoreline() ?? `Tile ${slot + 1}`)
    return [{ slot, name }]
  })
```

Add a group after the `Watch in tile N` group:

```tsx
        <CommandGroup heading="YouTube">
          {streams.map((stream) => (
            <Fragment key={stream.id}>
              <CommandItem
                value={`watch youtube ${stream.name} ${stream.id}`}
                onSelect={() => input(DisplayInput.ChosenCustom({ stream }))}
              >
                Watch {stream.name} in tile {selected + 1}
              </CommandItem>
              <CommandItem
                value={`rename youtube ${stream.name} ${stream.id}`}
                onSelect={() => input(DisplayInput.CustomFormOpened({ editing: stream }))}
              >
                Rename {stream.name}…
              </CommandItem>
              <CommandItem
                value={`remove delete youtube ${stream.name} ${stream.id}`}
                onSelect={() => edit(CustomStreamsChange.Removed({ id: stream.id }))}
              >
                Remove {stream.name}
              </CommandItem>
            </Fragment>
          ))}
          <CommandItem
            value="add youtube video playlist address url"
            onSelect={() => input(DisplayInput.CustomFormOpened({ editing: undefined }))}
          >
            Add YouTube…
          </CommandItem>
        </CommandGroup>
```

`ChosenCustom` and `CustomFormOpened` replace the palette overlay themselves (the palette's `open` follows
`display.shows("Palette")`), so neither calls `onOpenChange`. Update the component's doc comment: "…watch a game or a
saved YouTube stream, add one, act on a tile…".

- [ ] **Step 4: The tile's well: an embedded player in a plain browser**

In `apps/web/src/screen/TileBody.tsx`: add imports `Result` (to the `effect` import),
`import { CustomStream } from "../custom/CustomStream.ts"`, `import * as TilePlacements from "./TilePlacements.ts"`.
Add the case to `Tile.match` in `TileBody`, after `StreamTile`:

```tsx
    CustomTile: (custom) => <CustomPlayer tile={custom} />
```

and the component after `TileBody`:

```tsx
/**
 * A custom tile's well. In the shell its provider view plays the watch page over it, so it only names the stream; in a
 * plain browser it is YouTube's embedded player.
 */
function CustomPlayer(props: { tile: typeof Tile.cases.CustomTile.Type }) {
  const providerViews = useAtomValue(TilePlacements.providerViews)
  const { stream, name, locator } = props.tile
  // The tile keeps the watch page the shell loads; the embedded player's address is read back from it.
  const embed = Result.match(CustomStream.parse(locator.url, name), {
    onSuccess: (custom) => custom.embedUrl(),
    onFailure: () => undefined
  })
  if (providerViews || embed === undefined) return <p className="text-muted-foreground text-sm">{name}</p>
  return (
    <iframe
      key={stream}
      title={name}
      src={embed}
      className="h-full w-full border-0"
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
    />
  )
}
```

Extend `TileBody`'s doc comment: "A custom tile, in a plain browser, plays YouTube's embedded player." The shell window
confines its frames to the Hub (`ShellWindow`, `subframes: true`), which is one more reason the shell never renders the
frame. In a plain browser audio focus does not reach the frame (a cross-origin player is not muted from the page); the
shell mutes its view as any other.

- [ ] **Step 5: The tile's header and face**

In `TileChrome.tsx`, in the span that shows the score or `Loading…`, put a custom tile's name first:

```tsx
          {Tile.guards.CustomTile(tile) ? (
            <span className="truncate font-sans">{tile.name}</span>
          ) : props.game === undefined ? (
```

(the existing `props.game === undefined ? (…) : (…)` follows unchanged, closing the new conditional.)

In `ScreenView.tsx`, a tile reads its game's live stream only when it shows a game. In the `shown.onScreen().map`
callback, after `const hidden = rect.width === 0`, add `const game = Tile.game(tile)`, and replace the branch that picks
`TileFace` or `TileGame`:

```tsx
            {game === undefined ? (
              <TileFace
                screen={screen}
                slot={index}
                tile={tile}
                snapshot={undefined}
                selected={selected === index}
              />
            ) : (
              <TileGame screen={screen} slot={index} tile={tile} game={game} selected={selected === index} />
            )}
```

Replace `TileGame`, which now takes the game it reads (import `type GameId` from `@sportal/domain/Game`):

```tsx
/** A tile's game, read from its own live stream: the header always, the field only for a data tile of a live game. */
function TileGame(props: { screen: Screen; slot: number; tile: Tile; game: GameId; selected: boolean }) {
  const { value } = useAtomValue(Games.game(props.game))
  const snapshot = Option.getOrUndefined(Option.map(value, ({ snapshot }) => snapshot))
  return <TileFace {...props} snapshot={snapshot} />
}
```

The section's `key` (phase 2's `Tile.key(tile)`) already keeps a custom tile's element, and its frame, through moves.

---

### Task 27 (phase 4, was task 8): The Remote shows custom tiles by name

**Files:**
- Modify: `apps/web/src/remote/ScreenMap.tsx`

**Interfaces:**
- Consumes: `Tile.game`, `Tile.guards.CustomTile` (Task 3). The Remote report is the Screen, so a custom tile reaches the
  Remote already; `TileAction.of` moves, solos, audio-focuses and clears it by its key (phase 2). The Remote cannot add
  one: it has no form and no saved list.

- [ ] **Step 1: Name the tile**

Replace `gameIn` in `ScreenMap`:

```ts
  const gameIn = (slot: number) => {
    const at = tiles[slot]
    const game = at === undefined ? undefined : Tile.game(at)
    return game === undefined ? undefined : props.games.find(({ snapshot }) => snapshot.id === game)?.snapshot
  }
  const nameIn = (slot: number) => {
    const at = tiles[slot]
    return at !== undefined && Tile.guards.CustomTile(at) ? at.name : gameIn(slot)?.scoreline()
  }
```

In each slot's button: the `aria-label` reads
`` `Tile ${index + 1}${Tile.guards.Empty(at) ? ", empty" : `, ${nameIn(index) ?? "loading"}`}` ``, and the tile's body
shows a custom tile's name before the game branch:

```tsx
                  {at !== undefined && Tile.guards.CustomTile(at) ? (
                    <span className="m-auto line-clamp-3 px-0.5 text-center text-[11px]">{at.name}</span>
                  ) : game === undefined ? (
```

(the existing `game === undefined ? (…) : (…)` follows, closing the new conditional). In the actions sheet,
`SheetDescription` shows `{nameIn(props.selected) ?? ""}` in place of the selected game's scoreline, and
`selectedGame` goes.

---

### Task 28 (phase 4, was task 9): The shell loads a custom tile's watch page

**Files:**
- Modify: `apps/desktop/src/main/TileViews.test.ts`

**Interfaces:**
- Consumes: `TileKey.custom` (Task 3). `TileViews` itself does not change: it loads any placement's `url` the provider
  session allows, keyed by `TileKey` since phase 2, and `www.youtube.com` is already one of `YouTubeTv.allowedHosts`
  (`ProviderSession.allows`' tests list `https://www.youtube.com/`).

- [ ] **Step 1: Add the test**

In `describe("TileViews.sync")`, add:

```ts
  it.effect("should load a custom tile's YouTube watch page in a view of its own", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()

      yield* tiles.sync([placement, custom])

      expect(created).toHaveLength(2)
      expect(created[1]?.webContents.loadURL).toHaveBeenCalledWith(custom.url)
    }).pipe(Effect.scoped)
  )
```

and beside `placement` at the end of the file:

```ts
/** A custom tile's placement: a YouTube video's watch page, beside `placement`. */
const custom = {
  ...placement,
  key: TileKey.custom("video.dQw4w9WgXcQ"),
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

(import `TileKey` from `@sportal/api/TileKey` if phase 2 has not). Run
`pnpm vitest run apps/desktop/src/main/TileViews.test.ts` — Expected: PASS (it passes as soon as it is written: it pins
that the shell needs no change for custom tiles).

---

### Task 29 (phase 4, was task 10): Glossary, check, commit

**Files:**
- Modify: `CONTEXT.md`

- [ ] **Step 1: `CONTEXT.md` rows**

In the **Viewing** table, change the **Tile** row's meaning to: "One slot's content: a **stream tile**, a **data
tile**, a **custom tile**, or empty." Add after the **Tile** row:

```markdown
| **Custom stream** | A YouTube video or playlist (from its start, or from one of its videos) saved on a Display to watch in a tile, under a name: `CustomStream` in `apps/web/src/custom/CustomStream.ts`, read from an address by `CustomStream.parse`; what it plays is its `CustomTarget`, and its id (`CustomStreamId`) is read from that, so one video or playlist is saved once. The shell plays its `watchUrl`, a plain browser its `embedUrl`. The saved list is `customStreams` in `CustomStreams.ts`, kept in the browser (`sportal.custom`). | link, bookmark, channel |
| **Custom tile** | A tile showing a custom stream: its id, name and locator (the watch page), so the shell needs no lookup; `CustomTile` in `Tile`, keyed `custom:<id>`. It has no game; a Remote shows it by name. Removing its stream from the list clears it. | YouTube tile |
| **Custom streams change** | One edit to the saved custom streams: added, renamed or removed; `CustomStreamsChange` in `CustomStreams.ts`. `DisplayState.editCustom` applies it to the list and the Screen together. | |
| **Not YouTube** | An address `CustomStream.parse` refused: another site's, or a YouTube page with no video or playlist id; `NotYouTube`. | invalid URL |
```

In the **Overlay** row, add the YouTube form to the list: "…the key help, the command palette, Join Remote, the guide,
or the YouTube form (`CustomForm`: adding or renaming a custom stream, closing back to where it was opened)…". In the
**Display input** row, add "a game or a custom stream chosen for the selected tile (`Chosen`, `ChosenCustom`), a change
to the saved custom streams (`CustomEdited`), the YouTube form opened (`CustomFormOpened`)". In the **Tile placement**
row, "a game's stream tile" reads "a tile's video (a stream tile's or a custom tile's)".

- [ ] **Step 2: Run the whole check**

Run: `pnpm check`
Expected: format, lint, typecheck, depcruise, both knip runs and every test pass. If biome reformats anything, run
`pnpm format` and check again. If `knip --production` names `Tile.game`, `Tile.locator` or any new export as unused,
the task that should read it was skipped: find the reader named in its "Produces", do not delete the export.

- [ ] **Step 3: Commit**

```bash
git add -A apps/web/src/custom apps/web/src packages/api/src apps/desktop/src/main/TileViews.test.ts CONTEXT.md
git commit -m "$(cat <<'EOF'
feat: YouTube videos and playlists as custom tiles

A Display saves YouTube videos and playlists (CustomStream, read from any
of YouTube's address forms) in this browser and watches them in a tile:
the shell loads the watch page as a provider view, a plain browser the
embedded player. They are added from the palette's Add YouTube… or the
guide's Custom entry, removed with × or Delete, and a removed stream's
tiles are cleared. The Remote shows them by name and acts on them as on
any tile.

No test was rewritten: Screen.test.ts gains Tile and ScreenCommand wire
rows; every other change adds tests.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Contract notes (phase 4)

- **`CustomStream.parse(url, name?)`, not `parse(url, name?, id)`.** The id is read from the target
  (`video.<id>`, `list.<id>`, `list.<id>.<video id>`) instead of being a random UUID passed in. `crypto.randomUUID`
  does not exist outside a secure context and a Display at a LAN address is not one (`RemoteLink.displayId` already
  works round this with its own random hex); a derived id keeps `parse` pure without an id argument, saves one video
  once (adding it again moves it to the end under the new name), and adds no second random-id helper. A signature
  with a required `id` after an optional `name` is also not valid TypeScript. This differs from the spec's "a random
  UUID at creation"; nothing else depends on the id being random.
- **`TileKey.custom(id: string)`**, not `(id: CustomStreamId)`: `packages/api` cannot import `apps/web`, where
  `CustomStreamId` lives. Callers pass a `CustomStreamId`, which is a string.
- **ScreenCommand for placing a custom tile: `AssignCustom({ tile, stream, name, locator })`**, mirroring
  `Assign({ tile, game })` (phase 2 left `ScreenCommand`'s fields as slots). It moves a stream already on another tile,
  as `Assign` moves a game; both go through one private `placed` helper.
- **New on `Tile`** (beside phase 2's `key`): `Tile.game(tile): GameId | undefined` and
  `Tile.locator(tile): StreamLocator | undefined`. Phase 6/7 add `StatsTile` / `ClipTile` cases to both (a stats tile
  has a game and no locator; a clip tile neither — it plays in a page `<video>`).
- **New `Screen#customTiles(stream)`**, used by the fold to clear or rename a stream's tiles.
- **New Display names not in the contract:** `Overlay.CustomForm({ editing: CustomStream | undefined, back: Overlay })`
  (the YouTube form; "add" and "rename" are one form), `DisplayInput.CustomEdited({ change })` and
  `DisplayInput.CustomFormOpened({ editing })`, methods `chooseCustom`, `customEdited`, `openCustomForm`, `place` (the
  shared body of `choose` and `chooseCustom`), `focusedItem(shelves)`, and a new `close()` that sends `CustomForm` to
  its `back`. Phase 6's `GamePage({ game, back })` should extend the same `close()` conditional.
- **`DisplayState.editCustom: Atom.Writable<void, CustomStreamsChange>`** is the one writer of `customStreams` outside
  tests: it writes the list and `DisplayInput.CustomEdited` in one batch, so "removing a stream clears its tiles" holds
  for every entry point (× on a card, Delete, the palette's Remove). Renaming re-assigns the stream's tiles under the new
  name, so a Remote shows it.
- **`Remove` is routed in `DisplayState.route`**, not folded: it edits the saved list, which the Display does not hold.
  `Display.press` answers `Remove` with nothing, as it does `FullScreen`.
- **`Shell.providerViews: boolean`** and **`TilePlacements.providerViews`** are new: `TileBody` must not start an
  `<iframe>` under a provider view (double playback, and the shell window refuses foreign frames anyway).
- **Interacting** now applies to any tile with a provider view (stream or custom): a YouTube watch page needs the mouse
  for its own controls. `Display.interacting` stays a `TileKey`.
- **Assumed from phase 3** (adapt the call, not the behaviour, if they differ): `guideShelves(games, custom)` returns a
  `GuideShelves` and takes the saved streams as its last argument; `GuideOpened({ entry })` opens the full guide focused
  on `{ rail: false, shelf: 0, item: 0 }`; `Hotkey.test.ts`'s `key` helper accepts `guideOpen`; `Hotkey.keys` rows'
  `press` carries `guideOpen` for guide rows; the rail's entry order is one list the fold and `GuideRail` share.
- **Eye-check risk (phase 8 list):** the shell shows YouTube's whole watch page in the tile (header and side column at
  narrow widths), as the spec chose (`watchUrl`, loaded unmodified); a playlist plays on through YouTube's own
  autoplay. In a browser the embedded player does not autoplay (the spec's embed address has no `autoplay=1`) and is
  not muted by audio focus.
# Part D — Phases 5, 6, 7: Hub summary, stats view, highlights

Assumes phases 1–4 are merged on `ui-overhaul`: the looser web rules in `AGENTS.md`, `TileKey`
(`packages/api/src/TileKey.ts`), the guide (`Overlay.Guide`, `guide/GuideItem.ts`, `guide/GuideShelves.ts`,
`guide/FullGuide.tsx`), the themes (`ui/Theme.ts`, `game/TeamColors.ts`, `game/GameCard.tsx`), and custom tiles.

Phase-2 facts this part builds on: `Tile.key` has overloads (an occupied tile gives a `TileKey`, any tile
`TileKey | undefined`) and a new tile case adds its branch inside `key`'s body; `ScreenCommand`'s fields are slots and
`Assign({ tile, game })` stays a `GameId`, so this part adds its own commands; `Screen#benched` returns
`{ tile, key: TileKey }`; `TileRects.coveredGames` is now `coveredTiles`; a `GameId` meeting a `TileKey` is wrapped in
`TileKey.game(...)`.

**Global constraints** (as in `docs/plans/2026-10-15-games-api.md`): read `AGENTS.md`; Effect 4 APIs below were checked
against `node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/*.d.ts`: `RcMap.make({ lookup })` and
`RcMap.get(map, key)` (needs `Scope`), `Stream.switchMap`, `Stream.unwrap` (drops `Scope`),
`Effect.repeat(self, schedule)`, `Schedule.spaced`, `Cache.makeWith(lookup, { capacity, timeToLive })`,
`Config.Duration(name)`, `Schema.isBetween({ minimum, maximum })`, `Effect.catchTag`. Plain objects are equal and
hashed by structure in Effect 4 (`Equal.equals`, `Hash.hash`), so `{ league, game }` is a sound `Cache`/`RcMap` key
and `Atom.family` key. Tests: `it("should …")`, one behaviour each, Arrange/Act/Assert. `pnpm check` green before each
commit. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Each new exported type
name gets its `CONTEXT.md` row in the same commit.

Run one test file with `pnpm --filter <package> exec vitest run <path from the package>`, e.g.
`pnpm --filter @sportal/domain exec vitest run src/GameStats.test.ts`,
`pnpm --filter @sportal/hub exec vitest run src/Stats.test.ts`,
`pnpm --filter @sportal/web exec vitest run src/stats/StatsFit.test.ts`.

---

## Phase 5 — Hub summary

### Task 30 (phase 5, was task 5.1): `Highlight` and `GameStats` in the domain

**Files:**
- Create: `packages/domain/src/Highlight.ts`, `packages/domain/src/Highlight.test.ts`
- Create: `packages/domain/src/GameStats.ts`, `packages/domain/src/GameStats.test.ts`
- Modify: `packages/domain/src/TestGame.ts`

**Interfaces:**
- Produces: `HighlightId` (brand), `class Highlight` `{ id, game, headline, duration, video, thumbnail? }` with
  `durationText(): string`; `TeamStat`, `Leader`, `WinChance` wire values; `class GameStats` with
  `static empty(game)` and `static homeShare(stat: TeamStat): Option<number>`; `TestGame.highlight(overrides)`.

- [ ] **Step 1: Write the failing tests.**

`packages/domain/src/Highlight.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { highlight } from "./TestGame.ts"

describe("Highlight#durationText", () => {
  it("should show minutes and two-digit seconds", () => {
    const clip = highlight({ duration: 69 })

    const text = clip.durationText()

    assert.strictEqual(text, "1:09")
  })

  it("should show a clip under a minute with no minutes as 0", () => {
    const clip = highlight({ duration: 8 })

    const text = clip.durationText()

    assert.strictEqual(text, "0:08")
  })
})
```

`packages/domain/src/GameStats.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { GameId } from "./Game.ts"
import { GameStats } from "./GameStats.ts"

describe("GameStats.empty", () => {
  it("should have no linescore, stats, leaders, scoring plays or highlights", () => {
    const stats = GameStats.empty(game)

    assert.deepStrictEqual(
      [stats.linescore, stats.teamStats, stats.leaders, stats.scoringPlays, stats.highlights],
      [{ home: [], away: [] }, [], [], [], []]
    )
  })

  it("should have no win probability", () => {
    const stats = GameStats.empty(game)

    assert.isUndefined(stats.winProbability)
  })

  it("should name its game", () => {
    const stats = GameStats.empty(game)

    assert.strictEqual(stats.game, game)
  })
})

describe("GameStats.homeShare", () => {
  it("should give the home side's share of two whole numbers", () => {
    const share = GameStats.homeShare({ label: "1st Downs", home: "19", away: "26" })

    assert.deepStrictEqual(share, Option.some(19 / 45))
  })

  it("should read decimals", () => {
    const share = GameStats.homeShare({ label: "Yards per Play", home: "4.5", away: "4.5" })

    assert.deepStrictEqual(share, Option.some(0.5))
  })

  it("should split evenly when both sides are 0", () => {
    const share = GameStats.homeShare({ label: "Turnovers", home: "0", away: "0" })

    assert.deepStrictEqual(share, Option.some(0.5))
  })

  it.each([
    ["a made-attempted pair", "7-17", "6-13"],
    ["a clock", "35:38", "24:22"],
    ["a fraction", "27/51", "22/37"]
  ])("should give no share for %s", (_name, home, away) => {
    const share = GameStats.homeShare({ label: "Stat", home, away })

    assert.isTrue(Option.isNone(share))
  })
})

const game = GameId.make("401872971")
```

- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @sportal/domain exec vitest run src/Highlight.test.ts src/GameStats.test.ts`
  Expected: FAIL (modules not found).

- [ ] **Step 3: Write the modules.**

`packages/domain/src/Highlight.ts`:

```ts
import { Schema } from "effect"
import { GameId } from "./Game.ts"

export const HighlightId = Schema.String.pipe(Schema.brand("HighlightId"))
export type HighlightId = typeof HighlightId.Type

/** A video clip of a game, as its provider publishes it: its headline, its length in seconds, and where it plays. */
export class Highlight extends Schema.Class<Highlight>("sportal/Highlight")({
  id: HighlightId,
  game: GameId,
  headline: Schema.String,
  /** Seconds. */
  duration: Schema.Int,
  /** The clip's mp4: the HD one when the provider has it. */
  video: Schema.String,
  thumbnail: Schema.optional(Schema.String)
}) {
  /** Its length as a person reads it: "1:09". */
  durationText(): string {
    const seconds = this.duration % 60
    return `${Math.floor(this.duration / 60)}:${String(seconds).padStart(2, "0")}`
  }
}
```

`packages/domain/src/GameStats.ts`:

```ts
import { Option, Schema } from "effect"
import { GameId } from "./Game.ts"
import { Highlight } from "./Highlight.ts"
import { PlayId } from "./Play.ts"

/** One team stat as the provider words it, each side's value as it shows it ("24", "7-17", "35:38"). */
export const TeamStat = Schema.Struct({ label: Schema.String, home: Schema.String, away: Schema.String })
export type TeamStat = typeof TeamStat.Type

/** A side's best in one category: the athlete, and their line as the provider shows it. */
export const Leader = Schema.Struct({
  category: Schema.String,
  side: Schema.Literals(["home", "away"]),
  athlete: Schema.Struct({ name: Schema.String, headshot: Schema.optional(Schema.String) }),
  line: Schema.String
})
export type Leader = typeof Leader.Type

/** The home side's chance of winning after a play, 0 to 1. */
export const WinChance = Schema.Struct({
  play: PlayId,
  home: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
})
export type WinChance = typeof WinChance.Type

/**
 * A game's stats, in any sport: points per period, team stats in the provider's order and words, each side's
 * leaders, the home side's win probability by play when the provider has it, the scoring plays in order, and the
 * game's highlights.
 */
export class GameStats extends Schema.Class<GameStats>("sportal/GameStats")({
  game: GameId,
  linescore: Schema.Struct({ home: Schema.Array(Schema.Int), away: Schema.Array(Schema.Int) }),
  teamStats: Schema.Array(TeamStat),
  leaders: Schema.Array(Leader),
  winProbability: Schema.optional(Schema.Array(WinChance)),
  scoringPlays: Schema.Array(PlayId),
  highlights: Schema.Array(Highlight)
}) {
  /** A game with nothing to show yet: before its start. */
  static empty(game: GameId): GameStats {
    return new GameStats({
      game,
      linescore: { home: [], away: [] },
      teamStats: [],
      leaders: [],
      scoringPlays: [],
      highlights: []
    })
  }

  /**
   * The home side's share of a stat whose values are both plain numbers, for a two-sided bar; an even split when both
   * are 0. None for a stat shown as text ("7-17", "35:38").
   */
  static homeShare(stat: TeamStat): Option.Option<number> {
    if (!plainNumber.test(stat.home) || !plainNumber.test(stat.away)) return Option.none()
    const home = Number(stat.home)
    const total = home + Number(stat.away)
    return Option.some(total === 0 ? 0.5 : home / total)
  }
}

const plainNumber = /^\d+(\.\d+)?$/
```

Append to `packages/domain/src/TestGame.ts` (and add `import { Highlight, HighlightId } from "./Highlight.ts"`):

```ts
/** A highlight for a test: a 30-second clip of game "1" unless the overrides say otherwise. */
export function highlight(overrides: Partial<Highlight> = {}): Highlight {
  return new Highlight({
    id: HighlightId.make("h1"),
    game: GameId.make("1"),
    headline: "A touchdown",
    duration: 30,
    video: "https://video.test/h1.mp4",
    ...overrides
  })
}
```

- [ ] **Step 4: Run the tests to see them pass.** Same command. Expected: PASS.

### Task 31 (phase 5, was task 5.2): `StatsUnavailable`, the summary payload, and its decode

**Files:**
- Create: `packages/api/src/StatsUnavailable.ts`
- Create: `apps/hub/src/provider/espn/EspnSummaryPayload.ts`, `apps/hub/src/provider/espn/EspnSummary.ts`,
  `apps/hub/src/provider/espn/EspnSummary.test.ts`
- Replace: `apps/hub/src/provider/espn/fixtures/nfl-summary-401872971.json`
- Create: `apps/hub/src/provider/espn/fixtures/fbs-summary-401856712.json`, `mlb-summary-401908025.json`,
  `nba-summary-401908945.json`

**Interfaces:**
- Consumes: `GameStats`, `Highlight` (5.1); `TestHub.recordedSummary(name)` (exists).
- Produces: `EspnSummary.decode(league: LeagueId, game: GameId, body: string): Effect<GameStats, Schema.SchemaError>`.

- [ ] **Step 1: Record the fixtures.** This plan's assertions were written against recordings made 2026-10-16 and kept at
  `/tmp/claude-1000/-home-chazzy-development-projects-sportal/e5c1184d-ef42-4804-bded-504cdd53a541/scratchpad/espn/`.
  Copy them when that folder is there:

```bash
S=/tmp/claude-1000/-home-chazzy-development-projects-sportal/e5c1184d-ef42-4804-bded-504cdd53a541/scratchpad/espn
F=/home/chazzy/development/projects/sportal/apps/hub/src/provider/espn/fixtures
for name in nfl-summary-401872971 fbs-summary-401856712 mlb-summary-401908025 nba-summary-401908945; do
  cp "$S/$name.json" "$F/$name.json"
done
```

  Without them, record fresh (and re-derive each asserted value in Step 2 with the script after these commands):

```bash
F=/home/chazzy/development/projects/sportal/apps/hub/src/provider/espn/fixtures
B=https://site.api.espn.com/apis/site/v2/sports
curl -sf -o "$F/nfl-summary-401872971.json" "$B/football/nfl/summary?event=401872971"
curl -sf -o "$F/fbs-summary-401856712.json" "$B/football/college-football/summary?event=401856712"
curl -sf -o "$F/mlb-summary-401908025.json" "$B/baseball/mlb/summary?event=401908025"
curl -sf -o "$F/nba-summary-401908945.json" "$B/basketball/nba/summary?event=401908945"
```

  How the ids were picked: NFL keeps 401872971 (NE at BUF, 2026-10-04), the game the trimmed file was, so
  `EspnPlay.test.ts` and `EspnProvider.test.ts` keep passing on its `drives` (still 182 plays, a kickoff first, the
  second play's start team `2`). FBS is Georgia at Alabama, final, from
  `curl -s "$B/football/college-football/scoreboard?groups=80&limit=300&dates=20261010"` (first events with
  `status.type.name == "STATUS_FINAL"`). MLB 401908025 is ALCS game 3 (Rays at Guardians, final). NBA is Raptors at
  Knicks, a finished preseason game, from `curl -s "$B/basketball/nba/scoreboard?dates=20261015"`. To pick another of
  any league: list a past day's scoreboard as above and take an event whose `status.type.name` is `STATUS_FINAL`;
  prefer one whose summary's `videos` is not empty (`jq '.videos | length'`), except for NFL, whose 401872971 has none
  and is the "no highlights" case.

  The values this plan asserts, printed from the recordings (run with `python3 -I`; if a value differs, the fixture is
  newer: use the printed value):

```python
import json, sys
grouped = {"batting": ["hits","homeRuns","RBIs","walks","strikeouts","stolenBases","runnersLeftOnBase","avg"],
           "pitching": ["pitches","ERA"], "fielding": ["errors"]}
def rows(team):
    out = []
    for s in team.get("statistics", []):
        if "stats" in s:
            out += [(x["displayName"], x["displayValue"]) for x in s["stats"] if x["name"] in grouped.get(s["name"], [])]
        elif "label" in s:
            out.append((s["label"], s["displayValue"]))
    return out
for path, sport in [(a, b) for a, b in zip(sys.argv[1::2], sys.argv[2::2])]:
    d = json.load(open(path))
    comp = d["header"]["competitions"][0]["competitors"]
    side = {c["id"]: c["homeAway"] for c in comp}
    teams = {t["homeAway"]: rows(t) for t in d["boxscore"]["teams"]}
    print(path, {c["homeAway"]: [int(l["displayValue"]) for l in c.get("linescores", [])] for c in comp})
    print("  stats", len(teams["home"]), teams["home"][:1], teams["away"][:1])
    leaders = [(c["displayName"], side.get(t["team"]["id"]), c["leaders"][0]["athlete"]["displayName"], c["leaders"][0]["displayValue"])
               for t in d.get("leaders", []) for c in t["leaders"] if c["leaders"]]
    print("  leaders", len(leaders), leaders[:1])
    wp = d.get("winprobability")
    print("  wp", None if wp is None else (len(wp), wp[0]))
    sp = [s["id"] for s in d["scoringPlays"]] if "scoringPlays" in d else (
        [p["id"] for p in d.get("plays", []) if p.get("scoringPlay")] if sport == "baseball" else [])
    print("  scoring", len(sp), sp[:2])
    v = d.get("videos", [])
    print("  videos", len(v), v and (v[0]["id"], v[0]["headline"], v[0]["duration"]))
```

  Run as `python3 -I script.py $F/nfl-summary-401872971.json football $F/fbs-summary-401856712.json football
  $F/mlb-summary-401908025.json baseball $F/nba-summary-401908945.json basketball` with the script kept outside the
  fixtures folder.

- [ ] **Step 2: Write the failing test** `apps/hub/src/provider/espn/EspnSummary.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Highlight, HighlightId } from "@sportal/domain/Highlight"
import { PlayId } from "@sportal/domain/Play"
import { Effect, Schema } from "effect"
import * as TestHub from "../../TestHub.ts"
import * as EspnSummary from "./EspnSummary.ts"

describe("EspnSummary.decode", () => {
  describe("an NFL summary", () => {
    it.effect("should read each side's points per quarter", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.deepStrictEqual(stats.linescore, { home: [0, 17, 0, 9], away: [7, 7, 7, 8] })
      })
    )

    it.effect("should read the team stats in ESPN's order and words", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.deepStrictEqual(stats.teamStats[0], { label: "1st Downs", home: "19", away: "26" })
      })
    )

    it.effect("should read each leader on the side of its team", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.deepStrictEqual(stats.leaders[0], {
          category: "Passing Yards",
          side: "home",
          athlete: {
            name: "Josh Allen",
            headshot: "https://a.espncdn.com/i/headshots/nfl/players/full/3918298.png"
          },
          line: "23/33, 253 YDS, 1 TD, 1 INT"
        })
      })
    )

    it.effect("should read the home side's win probability by play", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.strictEqual(stats.winProbability?.length, 183)
        assert.deepStrictEqual(stats.winProbability?.[0], { play: PlayId.make("4018729711"), home: 0.7057 })
      })
    )

    it.effect("should read the scoring plays in order", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.strictEqual(stats.scoringPlays.length, 9)
        assert.deepStrictEqual(stats.scoringPlays.slice(0, 2), [
          PlayId.make("401872971484"),
          PlayId.make("401872971967")
        ])
      })
    )

    it.effect("should read no highlights from a summary with no videos", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.deepStrictEqual(stats.highlights, [])
      })
    )

    it.effect("should read no win probability from a summary that sends none", () =>
      Effect.gen(function* () {
        const body = withoutKey(TestHub.recordedSummary("nfl-summary-401872971"), "winprobability")

        const stats = yield* EspnSummary.decode("nfl", GameId.make("401872971"), body)

        assert.isUndefined(stats.winProbability)
      })
    )
  })

  describe("an FBS summary", () => {
    it.effect("should read each side's points per quarter", () =>
      Effect.gen(function* () {
        const stats = yield* fbs

        assert.deepStrictEqual(stats.linescore, { home: [0, 14, 3, 0], away: [3, 7, 7, 3] })
      })
    )

    it.effect("should read its videos as highlights, each with its HD mp4", () =>
      Effect.gen(function* () {
        const stats = yield* fbs

        assert.strictEqual(stats.highlights.length, 13)
        assert.deepStrictEqual(
          stats.highlights[0],
          new Highlight({
            id: HighlightId.make("50152231"),
            game: GameId.make("401856712"),
            headline: "Georgia takes control after forcing a Keelon Russell fumble",
            duration: 33,
            video:
              "https://espnmedia-cdn.akamaized.net/espn/media/16x9/wsc/2026/1011/ebdf8121-464c-46cf-a01a-963fbe7523ba/ebdf8121-464c-46cf-a01a-963fbe7523ba.mp4",
            thumbnail:
              "https://espnmedia-cdn.akamaized.net/espn/media/common/wsc/2026/1011/ebdf8121-464c-46cf-a01a-963fbe7523ba/ebdf8121-464c-46cf-a01a-963fbe7523ba.jpg"
          })
        )
      })
    )
  })

  describe("an MLB summary", () => {
    it.effect("should read each side's runs per inning, the home side's last half unplayed", () =>
      Effect.gen(function* () {
        const stats = yield* mlb

        assert.deepStrictEqual(stats.linescore, {
          home: [0, 1, 0, 0, 2, 0, 0, 0],
          away: [0, 0, 0, 2, 0, 0, 0, 0, 0]
        })
      })
    )

    it.effect("should keep only the chosen stats of its batting, pitching and fielding groups", () =>
      Effect.gen(function* () {
        const stats = yield* mlb

        assert.strictEqual(stats.teamStats.length, 11)
        assert.deepStrictEqual(stats.teamStats[0], { label: "Strikeouts", home: "8", away: "13" })
      })
    )

    it.effect("should read its scoring plays from its plays", () =>
      Effect.gen(function* () {
        const stats = yield* mlb

        assert.deepStrictEqual(stats.scoringPlays, [
          PlayId.make("4019080250302990057"),
          PlayId.make("4019080250605990057"),
          PlayId.make("4019080250902990057")
        ])
      })
    )

    it.effect("should read no leaders, since ESPN sends none for baseball", () =>
      Effect.gen(function* () {
        const stats = yield* mlb

        assert.deepStrictEqual(stats.leaders, [])
      })
    )
  })

  describe("an NBA summary", () => {
    it.effect("should read the team stats in ESPN's words", () =>
      Effect.gen(function* () {
        const stats = yield* nba

        assert.deepStrictEqual(stats.teamStats[0], { label: "FG", home: "43-90", away: "40-79" })
      })
    )

    it.effect("should read each leader on the side of its team", () =>
      Effect.gen(function* () {
        const stats = yield* nba

        assert.deepStrictEqual(
          [stats.leaders[0]?.category, stats.leaders[0]?.side, stats.leaders[0]?.athlete.name],
          ["Points", "home", "Jalen Brunson"]
        )
      })
    )

    it.effect("should read no scoring plays, since every basket scores", () =>
      Effect.gen(function* () {
        const stats = yield* nba

        assert.deepStrictEqual(stats.scoringPlays, [])
      })
    )

    it.effect("should read its first highlight", () =>
      Effect.gen(function* () {
        const stats = yield* nba

        assert.strictEqual(stats.highlights[0]?.id, HighlightId.make("50193529"))
        assert.strictEqual(stats.highlights[0]?.duration, 74)
      })
    )
  })
})

const nfl = EspnSummary.decode(
  "nfl",
  GameId.make("401872971"),
  TestHub.recordedSummary("nfl-summary-401872971")
)
const fbs = EspnSummary.decode(
  "fbs",
  GameId.make("401856712"),
  TestHub.recordedSummary("fbs-summary-401856712")
)
const mlb = EspnSummary.decode(
  "mlb",
  GameId.make("401908025"),
  TestHub.recordedSummary("mlb-summary-401908025")
)
const nba = EspnSummary.decode(
  "nba",
  GameId.make("401908945"),
  TestHub.recordedSummary("nba-summary-401908945")
)

/** `body`, a JSON object, without its key `key`. */
function withoutKey(body: string, key: string): string {
  const summary = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(body)
  return JSON.stringify(Object.fromEntries(Object.entries(summary).filter(([each]) => each !== key)))
}
```

- [ ] **Step 3: Run it to see it fail.** `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnSummary.test.ts`
  Expected: FAIL (module not found).

- [ ] **Step 4: Write the modules.**

`packages/api/src/StatsUnavailable.ts`:

```ts
import { Schema } from "effect"

/** The provider could not give a game's stats: its summary went unanswered or did not decode. */
export class StatsUnavailable extends Schema.TaggedError<StatsUnavailable>()("StatsUnavailable", {}) {}
```

`apps/hub/src/provider/espn/EspnSummaryPayload.ts`:

```ts
import { Schema } from "effect"

/** A baseball team stat inside one of its groups (`batting`, `pitching`, `fielding`). */
const GroupedStat = Schema.Struct({ name: Schema.String, displayName: Schema.String, displayValue: Schema.String })

/**
 * One entry of a team's box score `statistics`: a labeled stat (football, basketball), or a named group of stats
 * (baseball).
 */
export const SummaryStat = Schema.Struct({
  name: Schema.String,
  label: Schema.optional(Schema.String),
  displayValue: Schema.optional(Schema.String),
  stats: Schema.optional(Schema.Array(GroupedStat))
})
export type SummaryStat = typeof SummaryStat.Type

/** One of the summary's videos: its id, headline, seconds, thumbnail, and its mp4s. */
export const SummaryVideo = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Finite]),
  headline: Schema.String,
  duration: Schema.Int,
  thumbnail: Schema.optional(Schema.String),
  links: Schema.optional(
    Schema.Struct({
      source: Schema.optional(
        Schema.Struct({
          href: Schema.String,
          HD: Schema.optional(Schema.Struct({ href: Schema.String }))
        })
      )
    })
  )
})
export type SummaryVideo = typeof SummaryVideo.Type

/** A team's leaders: by category, each with its leading athletes. */
export const SummaryLeaders = Schema.Struct({
  team: Schema.Struct({ id: Schema.String }),
  leaders: Schema.Array(
    Schema.Struct({
      displayName: Schema.String,
      leaders: Schema.Array(
        Schema.Struct({
          displayValue: Schema.String,
          athlete: Schema.Struct({
            displayName: Schema.String,
            headshot: Schema.optional(Schema.Struct({ href: Schema.String }))
          })
        })
      )
    })
  )
})
export type SummaryLeaders = typeof SummaryLeaders.Type

/**
 * The game summary, as `EspnSummary` reads it: the header's competitors (ids, sides, points per period), the box
 * score's team stats, the leaders, the win probability by play, the scoring plays (football), the plays (baseball's
 * scoring plays are read from them), and the videos.
 */
export const EspnSummaryPayload = Schema.Struct({
  header: Schema.Struct({
    competitions: Schema.NonEmptyArray(
      Schema.Struct({
        competitors: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            homeAway: Schema.Literals(["home", "away"]),
            linescores: Schema.optional(Schema.Array(Schema.Struct({ displayValue: Schema.String })))
          })
        )
      })
    )
  }),
  boxscore: Schema.optional(
    Schema.Struct({
      teams: Schema.Array(
        Schema.Struct({
          homeAway: Schema.Literals(["home", "away"]),
          statistics: Schema.optional(Schema.Array(SummaryStat))
        })
      )
    })
  ),
  leaders: Schema.optional(Schema.Array(SummaryLeaders)),
  winprobability: Schema.optional(
    Schema.Array(Schema.Struct({ playId: Schema.String, homeWinPercentage: Schema.Finite }))
  ),
  scoringPlays: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
  plays: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, scoringPlay: Schema.optional(Schema.Boolean) }))
  ),
  videos: Schema.optional(Schema.Array(SummaryVideo))
})
export type EspnSummaryPayload = typeof EspnSummaryPayload.Type
```

`apps/hub/src/provider/espn/EspnSummary.ts`:

```ts
import type { GameId } from "@sportal/domain/Game"
import { GameStats, type Leader, type TeamStat } from "@sportal/domain/GameStats"
import { Highlight, HighlightId } from "@sportal/domain/Highlight"
import { League, type LeagueId } from "@sportal/domain/League"
import { PlayId } from "@sportal/domain/Play"
import { Effect, Schema } from "effect"
import {
  EspnSummaryPayload,
  type SummaryLeaders,
  type SummaryStat,
  type SummaryVideo
} from "./EspnSummaryPayload.ts"

/**
 * Game `game` of `league`'s summary `body` read as its stats. Points per period come from the header; team stats pair
 * the two sides' box score rows by name, in ESPN's order and words (baseball keeps a few of each group); leaders are
 * each category's first athlete, on the side of their team; scoring plays are ESPN's own list, or for baseball, which
 * has none, the plays marked scoring. Basketball has no scoring plays: every basket scores. A video with no mp4 is
 * left out of the highlights.
 */
export const decode = Effect.fnUntraced(function* (league: LeagueId, game: GameId, body: string) {
  const summary = yield* decodeSummary(body)
  const [competition] = summary.header.competitions

  const sideOf = new Map(competition.competitors.map(({ id, homeAway }) => [id, homeAway] as const))
  const linescoreOf = (side: "home" | "away") =>
    (competition.competitors.find(({ homeAway }) => homeAway === side)?.linescores ?? []).map(({ displayValue }) =>
      pointsOf(displayValue)
    )
  const rowsOf = (side: "home" | "away") =>
    rowsFrom(summary.boxscore?.teams.find(({ homeAway }) => homeAway === side)?.statistics ?? [])

  const linescore = { home: linescoreOf("home"), away: linescoreOf("away") }
  const teamStats = paired(rowsOf("home"), rowsOf("away"))
  const leaders = leadersOf(summary.leaders ?? [], sideOf)
  const winProbability = summary.winprobability?.map(({ playId, homeWinPercentage }) => ({
    play: PlayId.make(playId),
    home: homeWinPercentage
  }))
  const scoringPlays = scoringOf(league, summary)
  const highlights = (summary.videos ?? []).flatMap((video) => highlightOf(game, video))
  return new GameStats({ game, linescore, teamStats, leaders, winProbability, scoringPlays, highlights })
})

/** A team stat row before pairing: ESPN's name for it, its label, and this side's value. */
interface Row {
  readonly name: string
  readonly label: string
  readonly value: string
}

// A period's points are digits; anything else reads as 0.
function pointsOf(displayValue: string): number {
  return Number.parseInt(displayValue, 10) || 0
}

/** A side's rows: each labeled stat, and each kept stat of a group, named `<group>.<stat>`. */
function rowsFrom(statistics: ReadonlyArray<SummaryStat>): ReadonlyArray<Row> {
  return statistics.flatMap(({ name, label, displayValue, stats }) => {
    if (stats !== undefined) {
      const kept = groupedKept[name] ?? []
      return stats
        .filter((stat) => kept.includes(stat.name))
        .map((stat) => ({ name: `${name}.${stat.name}`, label: stat.displayName, value: stat.displayValue }))
    }
    return label === undefined || displayValue === undefined ? [] : [{ name, label, value: displayValue }]
  })
}

/**
 * The stats of baseball's groups that a stats view shows; the rest (ratings, rates per nine, games played) say
 * nothing about one game.
 */
const groupedKept: Readonly<Record<string, ReadonlyArray<string>>> = {
  batting: ["hits", "homeRuns", "RBIs", "walks", "strikeouts", "stolenBases", "runnersLeftOnBase", "avg"],
  pitching: ["pitches", "ERA"],
  fielding: ["errors"]
}

/**
 * The home rows in order, each with the away row of its name: the one at the same place when its name matches (ESPN
 * repeats a name, as NFL's "interceptions"), else the first of that name. A row only one side has is left out.
 */
function paired(home: ReadonlyArray<Row>, away: ReadonlyArray<Row>): ReadonlyArray<TeamStat> {
  return home.flatMap((row, index) => {
    const same = away[index]
    const other = same?.name === row.name ? same : away.find(({ name }) => name === row.name)
    return other === undefined ? [] : [{ label: row.label, home: row.value, away: other.value }]
  })
}

/** Each category's first athlete, on the side its team plays; a team the header does not name is left out. */
function leadersOf(
  teams: ReadonlyArray<SummaryLeaders>,
  sideOf: ReadonlyMap<string, "home" | "away">
): ReadonlyArray<Leader> {
  return teams.flatMap(({ team, leaders }) => {
    const side = sideOf.get(team.id)
    if (side === undefined) return []
    return leaders.flatMap(({ displayName, leaders: athletes }) => {
      const [first] = athletes
      if (first === undefined) return []
      const athlete = { name: first.athlete.displayName, headshot: first.athlete.headshot?.href }
      return [{ category: displayName, side, athlete, line: first.displayValue }]
    })
  })
}

function scoringOf(league: LeagueId, summary: EspnSummaryPayload): ReadonlyArray<PlayId> {
  if (summary.scoringPlays !== undefined) return summary.scoringPlays.map(({ id }) => PlayId.make(id))
  if (League.of(league).sport !== "baseball") return []
  return (summary.plays ?? []).filter(({ scoringPlay }) => scoringPlay === true).map(({ id }) => PlayId.make(id))
}

function highlightOf(game: GameId, video: SummaryVideo): ReadonlyArray<Highlight> {
  const source = video.links?.source
  if (source === undefined) return []
  return [
    new Highlight({
      id: HighlightId.make(String(video.id)),
      game,
      headline: video.headline,
      duration: video.duration,
      video: source.HD?.href ?? source.href,
      thumbnail: video.thumbnail
    })
  ]
}

const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(EspnSummaryPayload))
```

- [ ] **Step 5: Run the decode tests and the tests that read the old file.**
  `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnSummary.test.ts src/provider/espn/EspnPlay.test.ts src/provider/espn/EspnProvider.test.ts`
  Expected: PASS (EspnPlay's 182-play, kickoff-first and team-`2` assertions hold on the full file).

### Task 32 (phase 5, was task 5.3): The port's `stats`, ESPN's answer, and `HubConfig.statsRefresh`

**Files:**
- Modify: `apps/hub/src/provider/Provider.ts`, `apps/hub/src/provider/espn/EspnProvider.ts`,
  `apps/hub/src/provider/espn/EspnProvider.test.ts`
- Modify: `apps/hub/src/HubConfig.ts`, `apps/hub/src/HubConfig.test.ts`

**Interfaces:**
- Produces: `Provider["Service"]["stats"]: (league: LeagueId, game: GameId) => Effect<GameStats, ProviderUnavailable>`;
  `Provider.layerTest(frames, answers)` with `answers: Partial<Pick<Provider["Service"], "listing" | "plays" | "stats">>`;
  `HubConfig.statsRefresh: Duration.Duration`.

- [ ] **Step 1: Write the failing tests.** In `EspnProvider.test.ts`, after `describe("plays", …)`, add (and import
  `GameStats` is not needed; the assertions read fields):

```ts
  describe("stats", () => {
    it.effect("should read a game's stats from its summary", () =>
      Effect.gen(function* () {
        const summary = TestHub.recordedSummary("nfl-summary-401872971")
        const client = HttpClient.make((request) =>
          Effect.succeed(answered(request, request.url.includes("/summary?event=401872971") ? summary : "{}"))
        )

        const stats = yield* statsOver(client, "nfl", GameId.make("401872971"))

        assert.deepStrictEqual(stats.linescore, { home: [0, 17, 0, 9], away: [7, 7, 7, 8] })
      })
    )

    it.effect("should fail as unavailable for a summary that does not decode", () =>
      Effect.gen(function* () {
        const client = HttpClient.make((request) => Effect.succeed(answered(request, "{}")))

        const failed = yield* statsOver(client, "nfl", GameId.make("401872971")).pipe(Effect.flip)

        assert.instanceOf(failed, ProviderUnavailable)
      })
    )

    it.effect("should fail as unavailable for a league ESPN does not serve", () =>
      Effect.gen(function* () {
        const failed = yield* statsOver(recordedHttp(fbsLive), "mlb", GameId.make("1")).pipe(Effect.flip)

        assert.instanceOf(failed, ProviderUnavailable)
      })
    )
  })
```

  and beside `playsOver`:

```ts
/** The stats of game `game` of `league` that ESPN's provider over `client` reads. */
function statsOver(client: HttpClient.HttpClient, league: LeagueId, game: GameId) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    return yield* provider.stats(league, game)
  }).pipe(Effect.provide(espnOver(client)))
}
```

  In `HubConfig.test.ts`: in "should have a default for every setting" add
  `assert.deepStrictEqual(config.statsRefresh, Duration.seconds(30))` (import `Duration`); in "should read each setting"
  add `assert.deepStrictEqual(config.statsRefresh, Duration.seconds(45))` and `SPORTAL_STATS_REFRESH: "45 seconds"` to
  `everySetting`; add `["SPORTAL_STATS_REFRESH", "soon"]` to the refusal cases.

- [ ] **Step 2: Run to see them fail.**
  `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnProvider.test.ts src/HubConfig.test.ts`
  Expected: FAIL (`stats` and `statsRefresh` missing; typecheck errors are the failure).

- [ ] **Step 3: Implement.**

  `Provider.ts`: import `type { GameStats } from "@sportal/domain/GameStats"`; after `plays` in the service shape add:

```ts
    /** Game `game` of `league`'s stats, read from its summary. */
    readonly stats: (league: LeagueId, game: GameId) => Effect.Effect<GameStats, ProviderUnavailable>
```

  In `layerTest`, widen `answers` to `Partial<Pick<Provider["Service"], "listing" | "plays" | "stats">>`, add to its
  doc "listings, plays and stats", and add beside the `plays` default:

```ts
        stats: () =>
          Effect.fail(new ProviderUnavailable({ reason: "Unanswered", cause: "No stats in this test" })),
```

  `EspnProvider.ts`: import `* as EspnSummary from "./EspnSummary.ts"`. Replace the body of `plays` so both read one
  summary the same way, and add `stats`:

```ts
      const summaryOf = Effect.fnUntraced(function* (league: LeagueId, game: GameId) {
        const espn = yield* Effect.fromOption(
          EspnLeague.of(league),
          () =>
            new ProviderUnavailable({
              reason: "Unanswered",
              cause: `ESPN does not serve ${league} to the Hub`
            })
        )
        return yield* fetched(espn.summaryUrl(game))
      })

      const plays = Effect.fn("EspnProvider.plays")(function* (league: LeagueId, game: GameId) {
        const body = yield* summaryOf(league, game)

        return yield* EspnPlay.summaryPlays(league, body).pipe(
          Effect.mapError((cause) => new ProviderUnavailable({ reason: "Unanswered", cause }))
        )
      })

      const stats = Effect.fn("EspnProvider.stats")(function* (league: LeagueId, game: GameId) {
        const body = yield* summaryOf(league, game)

        return yield* EspnSummary.decode(league, game, body).pipe(
          Effect.mapError((cause) => new ProviderUnavailable({ reason: "Unanswered", cause }))
        )
      })
```

  and `return Provider.of({ deliveries, listing, plays, stats })`. Add to the layer's doc: "…and a game's plays and
  its stats from its summary."

  `HubConfig.ts`: import `Duration`; add to the shape, after `timeZone`:

```ts
    /** How often a live game's stats are fetched again while a live answer follows them. */
    readonly statsRefresh: Duration.Duration
```

  and to `Config.all`:

```ts
      statsRefresh: Config.Duration("SPORTAL_STATS_REFRESH").pipe(Config.withDefault(Duration.seconds(30)))
```

- [ ] **Step 4: Run to see them pass.** Same command. Expected: PASS.

### Task 33 (phase 5, was task 5.4): The Hub's `Stats` service

**Files:**
- Create: `apps/hub/src/Stats.ts`, `apps/hub/src/Stats.test.ts`
- Modify: `apps/hub/src/TestHub.ts`

**Interfaces:**
- Consumes: `Schedule` (`game`, `gameLive`, `list`), `Provider.stats`, `HubConfig.statsRefresh`.
- Produces:

```ts
class Stats {
  stats: (id: GameId) => Effect<GameStats, GameNotFound | StatsUnavailable>
  statsLive: (id: GameId) => Effect<Stream<GameStats, StatsUnavailable>, GameNotFound | StatsUnavailable>
  highlights: (league: LeagueId, date: CalendarDate) => Effect<ReadonlyArray<Highlight>, StatsUnavailable>
}
TestHub.withStats(answers, test)
```

- [ ] **Step 1: Add the harness to `TestHub.ts`** (import `Stats` from `./Stats.ts`; widen `scheduled`'s `answers` to
  `Partial<Pick<Provider["Service"], "listing" | "plays" | "stats">>`). Below `scheduled`:

```ts
/**
 * Runs `test` against the Stats as the Hub composes them, on the test clock at `onAlaAtMsstDay`: over the Schedule
 * and a Director fed the frames the test offers, a provider whose listings, plays and stats are `answers`, and
 * YouTube TV with no guide read.
 */
export function withStats<A, E, R>(
  answers: Partial<Pick<Provider["Service"], "listing" | "plays" | "stats">>,
  test: (frames: Frames) => Effect.Effect<A, E, R>
) {
  return Effect.gen(function* () {
    const frames = yield* Queue.bounded<ReadonlyArray<Delivery>, Cause.Done>(1)
    const stats = Stats.layer.pipe(
      Layer.provideMerge(Schedule.layer),
      Layer.provide(Director.layer),
      Layer.provide(Provider.layerTest(frames, answers)),
      Layer.provide(Source.layerYouTubeTv),
      Layer.provide(HubConfig.layerTest({}))
    )
    yield* TestClock.setTime(onAlaAtMsstDay)

    return yield* test(frames).pipe(Effect.scoped, Effect.provide(stats))
  })
}
```

- [ ] **Step 2: Write the failing test** `apps/hub/src/Stats.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { CalendarDate } from "@sportal/api/GamesQuery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { GameStats } from "@sportal/domain/GameStats"
import { HighlightId } from "@sportal/domain/Highlight"
import type { LeagueId } from "@sportal/domain/League"
import { PlayId } from "@sportal/domain/Play"
import { highlight, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Delivery, ProviderUnavailable } from "./provider/Provider.ts"
import { Stats } from "./Stats.ts"
import * as TestHub from "./TestHub.ts"

describe("Stats#stats", () => {
  it.effect("should answer an upcoming game with empty stats", () =>
    TestHub.withStats({}, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [upcoming])
        const stats = yield* Stats

        const answer = yield* stats.stats(upcoming.id)

        assert.deepStrictEqual(answer, GameStats.empty(upcoming.id))
      })
    )
  )

  it.effect("should not ask the provider for an upcoming game's stats", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [upcoming])
        const stats = yield* Stats

        yield* stats.stats(upcoming.id)

        assert.strictEqual(asked.times(), 0)
      })
    )
  })

  it.effect("should ask the provider for a final game's stats only once", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA])
        const stats = yield* Stats
        yield* stats.stats(finalA.id)

        yield* TestClock.adjust("1 hour")
        yield* stats.stats(finalA.id)

        assert.strictEqual(asked.times(), 1)
      })
    )
  })

  it.effect("should ask the provider again for a final game whose stats were unavailable", () => {
    const asked = counted(() => Effect.fail(unanswered))
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA])
        const stats = yield* Stats
        yield* Effect.flip(stats.stats(finalA.id))

        yield* Effect.flip(stats.stats(finalA.id))

        assert.strictEqual(asked.times(), 2)
      })
    )
  })

  it.effect("should fail as unavailable when the provider cannot give the stats", () =>
    TestHub.withStats({}, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA])
        const stats = yield* Stats

        const error = yield* Effect.flip(stats.stats(finalA.id))

        assert.strictEqual(error._tag, "StatsUnavailable")
      })
    )
  )

  it.effect("should fail as not found for a game no day lists", () =>
    TestHub.withStats({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const stats = yield* Stats

        const error = yield* Effect.flip(stats.stats(GameId.make("nope")))

        assert.strictEqual(error._tag, "GameNotFound")
      })
    )
  )

  it.effect("should not ask again for a live game's stats asked once", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const stats = yield* Stats
        yield* stats.stats(TestHub.alaAtMsst.id)

        yield* TestClock.adjust("2 minutes")

        assert.strictEqual(asked.times(), 1)
      })
    )
  })
})

describe("Stats#statsLive", () => {
  it.effect("should send a live game's stats again after each refresh", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const values = yield* followed(TestHub.alaAtMsst.id)
        yield* Queue.take(values)

        yield* TestClock.adjust("30 seconds")
        const second = yield* Queue.take(values)

        assert.deepStrictEqual(second.scoringPlays, [PlayId.make("p2")])
      })
    )
  })

  it.effect("should stop refreshing a live game once nothing follows it", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        yield* Effect.scoped(Effect.flatMap(followed(TestHub.alaAtMsst.id), Queue.take))

        yield* TestClock.adjust("2 minutes")

        assert.strictEqual(asked.times(), 1)
      })
    )
  })

  it.effect("should fetch a live game once a refresh however many follow it", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const one = yield* followed(TestHub.alaAtMsst.id)
        const other = yield* followed(TestHub.alaAtMsst.id)
        yield* Queue.take(one)
        yield* Queue.take(other)

        yield* TestClock.adjust("30 seconds")
        yield* Queue.take(one)
        yield* Queue.take(other)

        assert.strictEqual(asked.times(), 2)
      })
    )
  })

  it.effect("should send an upcoming game's empty stats without asking the provider", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [upcoming])
        const values = yield* followed(upcoming.id)

        const first = yield* Queue.take(values)

        assert.deepStrictEqual([first, asked.times()], [GameStats.empty(upcoming.id), 0])
      })
    )
  })
})

describe("Stats#highlights", () => {
  it.effect("should give the highlights of the day's final games in the league", () =>
    TestHub.withStats({ stats: (_, game) => Effect.succeed(withHighlight(game)) }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA, finalB, TestHub.alaAtMsst])
        const stats = yield* Stats

        const highlights = yield* stats.highlights("fbs", today)

        assert.deepStrictEqual(highlights.map(({ id }) => id).toSorted(), [
          HighlightId.make(`clip-${finalA.id}`),
          HighlightId.make(`clip-${finalB.id}`)
        ])
      })
    )
  )

  it.effect("should fetch each final game's stats once", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA, finalB])
        const stats = yield* Stats
        yield* stats.highlights("fbs", today)

        yield* stats.highlights("fbs", today)

        assert.strictEqual(asked.times(), 2)
      })
    )
  })

  it.effect("should leave out a final game whose stats are unavailable", () =>
    TestHub.withStats(
      {
        stats: (_, game) => (game === finalA.id ? Effect.fail(unanswered) : Effect.succeed(withHighlight(game)))
      },
      (frames) =>
        Effect.gen(function* () {
          yield* listed(frames, [finalA, finalB])
          const stats = yield* Stats

          const highlights = yield* stats.highlights("fbs", today)

          assert.deepStrictEqual(
            highlights.map(({ id }) => id),
            [HighlightId.make(`clip-${finalB.id}`)]
          )
        })
    )
  )
})

const today = CalendarDate.make("2026-10-03")

const upcoming = snapshot({ id: GameId.make("10") })

const finalA = snapshot({
  id: GameId.make("11"),
  status: "final",
  startsAt: DateTime.makeUnsafe("2026-10-03T16:00:00Z")
})

const finalB = snapshot({
  id: GameId.make("12"),
  status: "final",
  startsAt: DateTime.makeUnsafe("2026-10-03T17:00:00Z")
})

const unanswered = new ProviderUnavailable({ reason: "Unanswered", cause: "test" })

/** Delivers the fbs listing of `games`, so the Director has them, and moves on 250 ms for it to settle. */
const listed = Effect.fnUntraced(function* (frames: TestHub.Frames, games: ReadonlyArray<GameSnapshot>) {
  yield* TestHub.offered(frames, Delivery.Listing({ league: "fbs", games }))
  yield* TestClock.adjust("250 millis")
})

/** A queue of what the live stats of `id` send, for the rest of the test's scope. */
const followed = Effect.fnUntraced(function* (id: GameId) {
  const stats = yield* Stats
  const live = yield* stats.statsLive(id)

  return yield* TestHub.received(Stream.orDie(live))
})

/**
 * The provider's stats, each the `n`th answer's (`answer`, by default empty stats whose one scoring play is `p<n>`), and
 * how many times it was asked.
 */
function counted(
  answer: (game: GameId, times: number) => Effect.Effect<GameStats, ProviderUnavailable> = (game, times) =>
    Effect.succeed(new GameStats({ ...GameStats.empty(game), scoringPlays: [PlayId.make(`p${times}`)] }))
) {
  let times = 0
  return {
    stats: (_league: LeagueId, game: GameId) =>
      Effect.suspend(() => {
        times += 1
        return answer(game, times)
      }),
    times: () => times
  }
}

/** Empty stats of `game` with one highlight, `clip-<game>`. */
function withHighlight(game: GameId): GameStats {
  const clip = highlight({ id: HighlightId.make(`clip-${game}`), game })
  return new GameStats({ ...GameStats.empty(game), highlights: [clip] })
}
```

- [ ] **Step 3: Run it to see it fail.** `pnpm --filter @sportal/hub exec vitest run src/Stats.test.ts`
  Expected: FAIL (module not found).

- [ ] **Step 4: Write `apps/hub/src/Stats.ts`:**

```ts
import type { GameNotFound } from "@sportal/api/GameNotFound"
import type { CalendarDate } from "@sportal/api/GamesQuery"
import { StatsUnavailable } from "@sportal/api/StatsUnavailable"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { GameStats } from "@sportal/domain/GameStats"
import type { Highlight } from "@sportal/domain/Highlight"
import type { LeagueId } from "@sportal/domain/League"
import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  RcMap,
  Schedule as Recurrence,
  Schema,
  Stream,
  SubscriptionRef
} from "effect"
import { HubConfig } from "./HubConfig.ts"
import { Provider } from "./provider/Provider.ts"
import { Schedule } from "./Schedule.ts"

/**
 * A game's stats, from its provider's summary. An upcoming game's are empty, and nothing is fetched. An over game's
 * are fetched once and kept for the Hub's run. A live game's are fetched when asked once, and while any live answer
 * follows them, again every `HubConfig.statsRefresh`, one fetch however many follow; a refresh that fails is logged and
 * the last stats stand. A day's highlights in a league are its final games', each final game's stats fetched once,
 * four at a time; a game whose stats are unavailable is logged and left out.
 */
export class Stats extends Context.Service<
  Stats,
  {
    readonly stats: (id: GameId) => Effect.Effect<GameStats, GameNotFound | StatsUnavailable>
    readonly statsLive: (
      id: GameId
    ) => Effect.Effect<Stream.Stream<GameStats, StatsUnavailable>, GameNotFound | StatsUnavailable>
    readonly highlights: (
      league: LeagueId,
      date: CalendarDate
    ) => Effect.Effect<ReadonlyArray<Highlight>, StatsUnavailable>
  }
>()("sportal/hub/Stats") {
  static readonly layer: Layer.Layer<Stats, never, Schedule | Provider | HubConfig> = Layer.effect(
    Stats,
    Effect.gen(function* () {
      const schedule = yield* Schedule
      const provider = yield* Provider
      const config = yield* HubConfig

      const fetched = ({ league, game }: Summarized) =>
        provider.stats(league, game).pipe(Effect.mapError(() => new StatsUnavailable()))

      const finals = yield* Cache.makeWith(fetched, {
        capacity: 1024,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
      })

      // Each followed live game's latest stats, refreshed while anything holds it.
      const following = yield* RcMap.make({
        lookup: Effect.fnUntraced(function* (game: Summarized) {
          const latest = yield* SubscriptionRef.make(Option.none<GameStats>())
          const refresh = fetched(game).pipe(
            Effect.flatMap((stats) => SubscriptionRef.set(latest, Option.some(stats))),
            Effect.catch((error) =>
              Effect.logWarning("Stats: a live game's stats could not be fetched; its last stats stand", error).pipe(
                Effect.annotateLogs({ game: game.game })
              )
            )
          )

          yield* refresh.pipe(Effect.repeat(Recurrence.spaced(config.statsRefresh)), Effect.forkScoped)
          return latest
        })
      })

      const statsOf = (snapshot: GameSnapshot): Effect.Effect<GameStats, StatsUnavailable> => {
        const game = summarized(snapshot)
        const byProgress = {
          upcoming: () => Effect.succeed(GameStats.empty(snapshot.id)),
          live: () => fetched(game),
          over: () => Cache.get(finals, game)
        }
        return byProgress[snapshot.progress()]()
      }

      const followedFrom = (snapshot: GameSnapshot): Stream.Stream<GameStats, StatsUnavailable> => {
        const game = summarized(snapshot)
        const byProgress = {
          upcoming: () => Stream.succeed(GameStats.empty(snapshot.id)),
          live: () =>
            Stream.unwrap(
              Effect.map(RcMap.get(following, game), (latest) =>
                SubscriptionRef.changes(latest).pipe(
                  Stream.filter(Option.isSome),
                  Stream.map(({ value }) => value)
                )
              )
            ),
          over: () => Stream.fromEffect(Cache.get(finals, game))
        }
        return byProgress[snapshot.progress()]()
      }

      return Stats.of({
        stats: Effect.fn("Stats.stats")(function* (id: GameId) {
          const { snapshot } = yield* schedule.game(id).pipe(Effect.catchTag("ScheduleUnavailable", unavailable))

          return yield* statsOf(snapshot)
        }),
        statsLive: Effect.fn("Stats.statsLive")(function* (id: GameId) {
          const games = yield* schedule.gameLive(id).pipe(Effect.catchTag("ScheduleUnavailable", unavailable))

          return games.pipe(
            Stream.map(({ snapshot }) => snapshot),
            Stream.changesWith((a, b) => a.progress() === b.progress()),
            Stream.switchMap(followedFrom),
            Stream.changesWith(sameStats)
          )
        }),
        highlights: Effect.fn("Stats.highlights")(function* (league: LeagueId, date: CalendarDate) {
          const day = yield* schedule
            .list({ date, league: [league], progress: ["over"] })
            .pipe(Effect.mapError(() => new StatsUnavailable()))
          const finished = day.games.map(({ snapshot }) => snapshot).filter(({ status }) => status === "final")

          const each = yield* Effect.forEach(
            finished,
            (snapshot) =>
              Cache.get(finals, summarized(snapshot)).pipe(
                Effect.map(({ highlights }) => highlights),
                Effect.catch((error) =>
                  Effect.logWarning("Stats: a final game's highlights are left out; its stats are unavailable", error).pipe(
                    Effect.annotateLogs({ game: snapshot.id }),
                    Effect.as([])
                  )
                )
              ),
            { concurrency: 4 }
          )
          return each.flat()
        })
      })
    })
  )
}

/** A game whose summary is asked for: its league, which says where, and its id. */
interface Summarized {
  readonly league: LeagueId
  readonly game: GameId
}

function summarized(snapshot: GameSnapshot): Summarized {
  return { league: snapshot.league, game: snapshot.id }
}

function unavailable() {
  return Effect.fail(new StatsUnavailable())
}

const sameStats = Schema.toEquivalence(GameStats)
```

- [ ] **Step 5: Run the tests to see them pass.** Same command. Expected: PASS. If `Effect.catchTag`'s handler type
  rejects `unavailable` (no argument), write it `() => unavailable()`.

### Task 34 (phase 5, was task 5.5): The RPCs, the server, and `main.ts` — then commit phase 5

**Files:**
- Modify: `packages/api/src/HubApi.ts`, `apps/hub/src/HubServer.ts`, `apps/hub/src/HubServer.test.ts`,
  `apps/hub/src/main.ts`, `apps/web/src/TestWeb.ts` (the fake Hub must answer every RPC), `CONTEXT.md`

**Interfaces:**
- Produces: `HubApi` RPCs `statsLive({ id }) → stream GameStats` (error `GameNotFound | StatsUnavailable`),
  `stats({ id }) → GameStats` (same error), `highlights({ league, date }) → Array<Highlight>` (error
  `StatsUnavailable`).

- [ ] **Step 1: Write the failing server test.** In `HubServer.test.ts`, give `served` and `serverUnderTest` a second
  parameter `answers: Partial<Pick<Provider["Service"], "listing" | "plays" | "stats">> = {}` passed to
  `Provider.layerTest(frames, answers)`, and compose the Stats over the Schedule:

```ts
function serverUnderTest(
  frames: TestHub.Frames,
  answers: Partial<Pick<Provider["Service"], "listing" | "plays" | "stats">>
) {
  const hub = Stats.layer.pipe(
    Layer.provideMerge(Schedule.layer),
    Layer.provide(Director.layer),
    Layer.provide(Provider.layerTest(frames, answers)),
    Layer.provideMerge(Source.layerYouTubeTv),
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_VERSION: "1.2.3" }))
  )
  return HubServer.layer.pipe(
    Layer.provideMerge(hub),
    Layer.provideMerge(Displays.layer),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
}
```

  Add after `describe("plays", …)`:

```ts
  describe("stats", () => {
    it.effect("should answer a live game's stats", () =>
      served(
        (frames) =>
          Effect.gen(function* () {
            const socket = yield* socketClient
            yield* TestHub.alaAtMsstListed(frames)

            const stats = yield* socket.stats({ id: TestHub.alaAtMsst.id })

            assert.deepStrictEqual(stats.scoringPlays, [PlayId.make("p1")])
          }),
        {
          stats: (_, game) =>
            Effect.succeed(new GameStats({ ...GameStats.empty(game), scoringPlays: [PlayId.make("p1")] }))
        }
      )
    )

    it.effect("should fail as not found for a game no day lists", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestHub.alaAtMsstListed(frames)
          const socket = yield* socketClient

          const error = yield* socket.stats({ id: GameId.make("nope") }).pipe(Effect.flip)

          assert.strictEqual(error._tag, "GameNotFound")
        })
      )
    )
  })
```

  (imports: `GameStats` from `@sportal/domain/GameStats`, `PlayId` from `@sportal/domain/Play` if absent, `Stats` from
  `./Stats.ts`.)

- [ ] **Step 2: Run to see it fail.** `pnpm --filter @sportal/hub exec vitest run src/HubServer.test.ts`
  Expected: FAIL (no `stats` RPC).

- [ ] **Step 3: Implement.**

  `HubApi.ts`: import `GameStats` from `@sportal/domain/GameStats`, `Highlight` from `@sportal/domain/Highlight`,
  `LeagueId` from `@sportal/domain/League`, `CalendarDate` beside `GameList, GamesQuery` from `./GamesQuery.ts`, and
  `StatsUnavailable` from `./StatsUnavailable.ts`. After the `playsLive` RPC:

```ts
  Rpc.make("statsLive", {
    payload: { id: GameId },
    success: GameStats,
    error: Schema.Union([GameNotFound, StatsUnavailable]),
    stream: true
  }),
```

  after the `plays` RPC:

```ts
  Rpc.make("stats", {
    payload: { id: GameId },
    success: GameStats,
    error: Schema.Union([GameNotFound, StatsUnavailable])
  }),
  Rpc.make("highlights", {
    payload: { league: LeagueId, date: CalendarDate },
    success: Schema.Array(Highlight),
    error: StatsUnavailable
  }),
```

  `HubServer.ts`: `import { Stats } from "./Stats.ts"`; in `handlers` add `const stats = yield* Stats` after
  `const schedule = yield* Schedule`, and:

```ts
      statsLive: ({ id }) => Stream.unwrap(stats.statsLive(id)),
```

  after `playsLive`, and after `plays`:

```ts
      stats: ({ id }) => stats.stats(id),
      highlights: ({ league, date }) => stats.highlights(league, date),
```

  Add `| Stats` to `layer`'s requirements.

  `main.ts`: `import { Stats } from "./Stats.ts"` and `Layer.provide(Stats.layer),` between
  `Layer.provide(Displays.layer),` and `Layer.provide(Schedule.layer),`.

  `apps/web/src/TestWeb.ts`, in `liveHub`'s `HubApi.toLayer({...})`: import `GameStats` (type) from
  `@sportal/domain/GameStats`; add `const stats = yield* PubSub.unbounded<GameStats>()` beside `plays`; handlers

```ts
    statsLive: ({ id }) => served(open, `stats ${id}`, stats).pipe(Stream.filter(({ game }) => game === id)),
    stats: () => Effect.die("TestWeb.liveHub does not answer stats"),
    highlights: () => Effect.die("TestWeb.liveHub does not answer highlights"),
```

  add `stats` to its returned object, and "a game's stats' (`stats 401`)" to its doc's list of query names.

- [ ] **Step 4: CONTEXT.md.** Under "Game state", after **Plays change**, add:

```md
| **Game stats** | A game's stats in any sport: points per period (`linescore`), team stats in the provider's order and words, each side's leaders, the home side's win probability by play when the provider has it, the scoring plays' ids in order, and its highlights; `GameStats` in `packages/domain/src/GameStats.ts`, empty before the start (`GameStats.empty`). | box score, summary |
| **Team stat** | One stat of both sides, as the provider labels and shows it ("3rd down efficiency", "7-17"); `TeamStat` beside `GameStats`. A stat both of whose values are plain numbers gets a two-sided bar (`GameStats.homeShare`). | |
| **Leader** | A side's best athlete in one category, with their line as the provider shows it; `Leader` beside `GameStats`. | top performer |
| **Win chance** | The home side's chance of winning after one play, 0 to 1; `WinChance` beside `GameStats`. | win probability point |
| **Highlight** | A provider's video clip of a game: headline, length in seconds, its mp4 (HD when there is one), its thumbnail; `Highlight` and `HighlightId` in `packages/domain/src/Highlight.ts`. | clip, video, replay |
```

  Under "Devices", after **Schedule unavailable**:

```md
| **Stats** | The Hub's `Stats` service (`apps/hub/src/Stats.ts`): a game's stats, once or live, and a day's highlights in a league. An upcoming game's are empty with no fetch; an over game's are fetched once per Hub run; a live game's are fetched when asked, and every `HubConfig.statsRefresh` (`SPORTAL_STATS_REFRESH`, 30 s) while a live answer follows them, one fetch however many follow. | stats cache |
| **Stats unavailable** | The provider could not give a game's stats; `StatsUnavailable`, the error of the `stats`, `statsLive` and `highlights` RPCs. | |
```

  In **Provider**'s row, "`plays` a game's plays so far" becomes "`plays` a game's plays so far and `stats` its game
  stats". In **Hub API**'s row, the live queries list gains "a game's stats".

- [ ] **Step 5: `pnpm check`**, then commit:

```bash
git add packages/domain/src/Highlight.ts packages/domain/src/Highlight.test.ts packages/domain/src/GameStats.ts \
  packages/domain/src/GameStats.test.ts packages/domain/src/TestGame.ts packages/api/src/StatsUnavailable.ts \
  packages/api/src/HubApi.ts apps/hub/src apps/web/src/TestWeb.ts CONTEXT.md
git commit -m "$(cat <<'EOF'
feat: a game's stats and highlights from the Hub

GameStats and Highlight in the domain; ESPN's summary decoded into them;
the Provider port's stats; a Stats service that fetches a final game once
and a live one every SPORTAL_STATS_REFRESH while followed; the stats,
statsLive and highlights RPCs. The NFL summary fixture is now the full
recording of the same game; FBS, MLB and NBA summaries are added.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Stats view

### Task 35 (phase 6, was task 6.1): Web atoms for stats, and every play of a game

**Files:**
- Create: `apps/web/src/hub/Stats.ts`, `apps/web/src/hub/Stats.test.ts`
- Modify: `apps/web/src/hub/HubClient.ts`, `apps/web/src/hub/Games.ts`

**Interfaces:**
- Produces: `HubClient["Service"]` gains
  `stats(id) => Effect<GameStats, GameNotFound | StatsUnavailable | RpcClientError>`,
  `highlights(league, date) => Effect<ReadonlyArray<Highlight>, StatsUnavailable | RpcClientError>`,
  `plays(id) => Effect<ReadonlyArray<Play>, GameNotFound | ScheduleUnavailable | RpcClientError>` (every play, newest
  first); `Stats.stats(id): Atom<AsyncResult<GameStats, …>>`, `Stats.statsLive(id): Atom<Live<Option<GameStats>>>`,
  `Stats.highlights({ league, date }): Atom<AsyncResult<ReadonlyArray<Highlight>, …>>` (kept alive);
  `Games.everyPlay(id): Atom<AsyncResult<ReadonlyArray<Play>, …>>`.

- [ ] **Step 1: Write the failing test** `apps/web/src/hub/Stats.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { GameStats } from "@sportal/domain/GameStats"
import { PlayId } from "@sportal/domain/Play"
import { Effect, Option } from "effect"
import { Atom } from "effect/reactivity"
import * as TestWeb from "../TestWeb.ts"
import * as Stats from "./Stats.ts"

describe("Stats.statsLive", () => {
  it.effect("should ask the Hub for that game's live stats", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const open = yield* Effect.gen(function* () {
        yield* Atom.mount(Stats.statsLive(id))

        return yield* TestWeb.asked(hub, `stats ${id}`)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.include(open, `stats ${id}`)
    })
  )

  it.effect("should hold the latest stats the Hub sends", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()
      const sent = new GameStats({ ...GameStats.empty(id), scoringPlays: [PlayId.make("p1")] })

      const { value } = yield* Effect.gen(function* () {
        yield* Atom.mount(Stats.statsLive(id))

        yield* TestWeb.answer(hub, `stats ${id}`, hub.stats, sent)
        return yield* TestWeb.until(Stats.statsLive(id), ({ value }) => Option.isSome(value))
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(value, Option.some(sent))
    })
  )
})

const id = GameId.make("401")
```

- [ ] **Step 2: Run to see it fail.** `pnpm --filter @sportal/web exec vitest run src/hub/Stats.test.ts` — FAIL.

- [ ] **Step 3: Implement.**

  `HubClient.ts`, in the service shape, after `send` (imports: `GameNotFound`, `ScheduleUnavailable`,
  `StatsUnavailable`, `CalendarDate` types from `@sportal/api/*`; `GameId` type from `@sportal/domain/Game`;
  `GameStats`, `Highlight`, `LeagueId`, `Play` types from the domain):

```ts
    /** Game `id`'s stats, once. */
    readonly stats: (
      id: GameId
    ) => Effect.Effect<GameStats, GameNotFound | StatsUnavailable | RpcClientError.RpcClientError>
    /** The highlights of `date`'s final games of `league`. */
    readonly highlights: (
      league: LeagueId,
      date: CalendarDate
    ) => Effect.Effect<ReadonlyArray<Highlight>, StatsUnavailable | RpcClientError.RpcClientError>
    /** Every play of game `id`, newest first, asked a page at a time. */
    readonly plays: (
      id: GameId
    ) => Effect.Effect<ReadonlyArray<Play>, GameNotFound | ScheduleUnavailable | RpcClientError.RpcClientError>
```

  In `layer`, before `return`:

```ts
      const stats = Effect.fn("HubClient.stats")(function* (id: GameId) {
        return yield* client.stats({ id })
      })
      const highlights = Effect.fn("HubClient.highlights")(function* (league: LeagueId, date: CalendarDate) {
        return yield* client.highlights({ league, date })
      })
      const plays = Effect.fn("HubClient.plays")(function* (id: GameId) {
        const all: Array<Play> = []
        let before: number | undefined
        while (true) {
          const page = yield* client.plays({ id, before, limit: 200 })
          all.push(...page.plays)
          const last = page.plays.at(-1)
          if (!page.more || last === undefined) return all
          before = last.sequence
        }
      })
      return HubClient.of({ sendGuide, addresses, report, send, stats, highlights, plays })
```

  In `layerTest`'s defaults (doc: "…`addresses` lists none, `stats` are empty, `highlights` and `plays` none"):

```ts
        stats: (id) => Effect.succeed(GameStats.empty(id)),
        highlights: () => Effect.succeed([]),
        plays: () => Effect.succeed([]),
```

  (`GameStats` as a value import here.)

  `apps/web/src/hub/Stats.ts`:

```ts
import type { CalendarDate } from "@sportal/api/GamesQuery"
import type { GameId } from "@sportal/domain/Game"
import type { GameStats } from "@sportal/domain/GameStats"
import type { LeagueId } from "@sportal/domain/League"
import { Effect, Option } from "effect"
import { Atom } from "effect/reactivity"
import { runtime } from "../WebRuntime.ts"
import { HubClient } from "./HubClient.ts"
import * as LiveStream from "./LiveStream.ts"

/** Game `id`'s stats, asked once while read: a game that is not live. */
export const stats = Atom.family((id: GameId) =>
  runtime.atom(
    Effect.gen(function* () {
      const hub = yield* HubClient
      return yield* hub.stats(id)
    })
  )
)

/** Game `id`'s stats, live: none before the first answer. Asked of the Hub only while read: a live game. */
export const statsLive = Atom.family((id: GameId) =>
  LiveStream.of(
    (client) => client.statsLive({ id }),
    Option.none<GameStats>(),
    (_, answer) => Option.some(answer)
  )
)

/** The highlights of `date`'s final games of `league`, asked once per page. */
export const highlights = Atom.family((day: { readonly league: LeagueId; readonly date: CalendarDate }) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const hub = yield* HubClient
        return yield* hub.highlights(day.league, day.date)
      })
    )
    .pipe(Atom.keepAlive)
)
```

  `Games.ts`, after `plays` (imports `Effect`, `runtime` from `../WebRuntime.ts`, `HubClient` from `./HubClient.ts`):

```ts
/** Every play of game `id`, newest first, asked once while read: for a list that needs plays older than the live page. */
export const everyPlay = Atom.family((id: GameId) =>
  runtime.atom(
    Effect.gen(function* () {
      const hub = yield* HubClient
      return yield* hub.plays(id)
    })
  )
)
```

- [ ] **Step 4: Run to see it pass.** Same command. PASS.

### Task 36 (phase 6, was task 6.2): `StatsFit`

**Files:** Create `apps/web/src/stats/StatsFit.ts`, `apps/web/src/stats/StatsFit.test.ts`

**Interfaces:** Produces `StatsFit.sectionsThatFit<S>(available: number, heights: ReadonlyArray<{ section: S; height: number }>): ReadonlyArray<S>`.

- [ ] **Step 1: Failing test** `apps/web/src/stats/StatsFit.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import * as StatsFit from "./StatsFit.ts"

describe("StatsFit.sectionsThatFit", () => {
  it("should show every section when all of them fit", () => {
    const shown = StatsFit.sectionsThatFit(100, [
      { section: "header", height: 30 },
      { section: "linescore", height: 30 },
      { section: "leaders", height: 30 }
    ])

    assert.deepStrictEqual(shown, ["header", "linescore", "leaders"])
  })

  it("should show a section that fits exactly", () => {
    const shown = StatsFit.sectionsThatFit(60, [
      { section: "header", height: 30 },
      { section: "linescore", height: 30 }
    ])

    assert.deepStrictEqual(shown, ["header", "linescore"])
  })

  it("should stop at the first section that does not fit, though a later one would", () => {
    const shown = StatsFit.sectionsThatFit(100, [
      { section: "header", height: 30 },
      { section: "teamStats", height: 80 },
      { section: "leaders", height: 10 }
    ])

    assert.deepStrictEqual(shown, ["header"])
  })

  it("should always show the first section", () => {
    const shown = StatsFit.sectionsThatFit(20, [{ section: "header", height: 30 }])

    assert.deepStrictEqual(shown, ["header"])
  })

  it("should show nothing when there are no sections", () => {
    const shown = StatsFit.sectionsThatFit(100, [])

    assert.deepStrictEqual(shown, [])
  })
})
```

- [ ] **Step 2: Run** `pnpm --filter @sportal/web exec vitest run src/stats/StatsFit.test.ts` — FAIL.

- [ ] **Step 3: Write `apps/web/src/stats/StatsFit.ts`:**

```ts
import { Array as Arr } from "effect"

/**
 * The sections a tile shows, in priority order: the first always, then each next one while every one so far fits in
 * `available` pixels together. The first that does not fit ends the list, so a smaller later one never shows
 * in its place.
 */
export function sectionsThatFit<S>(
  available: number,
  heights: ReadonlyArray<{ readonly section: S; readonly height: number }>
): ReadonlyArray<S> {
  const totals = Arr.scan(heights, 0, (sum, { height }) => sum + height)
  const fitting = Arr.takeWhile(heights, (_, index) => index === 0 || (totals[index + 1] ?? Infinity) <= available)
  return fitting.map(({ section }) => section)
}
```

- [ ] **Step 4: Run** — PASS.

### Task 37 (phase 6, was task 6.3): Stats tiles on the Screen

**Files:**
- Modify: `packages/api/src/TileKey.ts` (phase 2), `apps/web/src/screen/Screen.ts`, `apps/web/src/screen/Screen.test.ts`,
  `apps/web/src/screen/Rejections.ts`, `apps/web/src/screen/TileAction.ts`, `apps/web/src/screen/TileAction.test.ts`

**Interfaces:**
- Produces: `TileKey.stats(game: GameId): TileKey` (`stats:<id>`); `Tile` case `StatsTile: { game: GameId }`;
  `ScreenCommand` case `AssignStats: { tile: Int, game: GameId }`; `ScreenRejection` reason `"silent-tile"`.

- [ ] **Step 1: Failing tests.** Append to `Screen.test.ts`'s `describe("Screen#apply")`:

```ts
  it("should put a game's stats in a stats tile", () => {
    const screen = run(Screen.initial, { _tag: "AssignStats", tile: 1, game: TestWeb.bama })

    assert.deepStrictEqual(screen.tiles[1], { _tag: "StatsTile", game: TestWeb.bama })
  })

  it("should keep a game's stream where it is when its stats go beside it", () => {
    const screen = TestWeb.fill([TestWeb.bama])

    const beside = run(screen, { _tag: "AssignStats", tile: 1, game: TestWeb.bama })

    assert.strictEqual(beside.tiles[0]?._tag, "StreamTile")
    assert.strictEqual(beside.tiles[1]?._tag, "StatsTile")
  })

  it("should move a game's stats rather than show them twice", () => {
    const first = run(Screen.initial, { _tag: "AssignStats", tile: 0, game: TestWeb.bama })

    const second = run(first, { _tag: "AssignStats", tile: 2, game: TestWeb.bama })

    assert.deepStrictEqual(
      second.tiles.map(({ _tag }) => _tag),
      ["Empty", "Empty", "StatsTile", "Empty"]
    )
  })

  it("should refuse to focus audio on a stats tile", () => {
    const screen = run(TestWeb.fill([TestWeb.bama]), { _tag: "AssignStats", tile: 1, game: TestWeb.bama })

    const result = screen.apply({ _tag: "FocusAudio", tile: 1 }, TestWeb.onFox)

    assert.deepStrictEqual(Result.getFailure(result).pipe(Option.map(({ reason }) => reason)), Option.some("silent-tile"))
  })

  it("should give audio focus to no stats tile", () => {
    const screen = run(Screen.initial, { _tag: "AssignStats", tile: 0, game: TestWeb.bama })

    assert.isTrue(Option.isNone(screen.audioFocus))
  })
```

  and to `describe("Screen#refresh")`:

```ts
  it("should keep a stats tile as it is", () => {
    const screen = run(Screen.initial, { _tag: "AssignStats", tile: 0, game: TestWeb.bama })

    const refreshed = screen.refresh(() => Option.some(TestWeb.onFox()))

    assert.strictEqual(refreshed, screen)
  })
```

  (`run` is the file's existing helper that applies a command with `TestWeb.onFox` and unwraps it; if its signature
  differs, call `Result.getOrThrow(screen.apply(command, TestWeb.onFox))`.)

  Append to `TileAction.test.ts`:

```ts
  it("should offer no hear for a stats tile", () => {
    const screen = Result.getOrThrow(
      TestWeb.fill([TestWeb.bama]).apply({ _tag: "AssignStats", tile: 1, game: TestWeb.bama }, TestWeb.onFox)
    )

    const actions = TileAction.of(screen, 1, true)

    assert.deepStrictEqual(
      actions.map((action) => action.id),
      ["promote", "solo", "clear"]
    )
  })
```

  (import `Result` from `effect`.)

- [ ] **Step 2: Run** `pnpm --filter @sportal/web exec vitest run src/screen/Screen.test.ts src/screen/TileAction.test.ts` — FAIL.

- [ ] **Step 3: Implement.**

  `packages/api/src/TileKey.ts`: beside `game` (and phase 4's `custom`), spelled as `game` is, add `stats` to the
  `Object.assign` and its function below the others:

```ts
/** The key of game `game`'s stats tile. */
function stats(game: GameId): TileKey {
  return TileKey.make(`stats:${game}`)
}
```

  `Screen.ts`:
  - `Tile` gains, after `DataTile` (and phase 4's `CustomTile`):

```ts
  /** A game's stats, beside or instead of its stream: no provider view and no sound. */
  StatsTile: { game: GameId },
```

  - In `Tile.key`'s body add the branch `StatsTile: ({ game }) => TileKey.stats(game)`.
  - `ScreenCommand` gains `AssignStats: { tile: Schema.Int, game: GameId },` after `Assign`.
  - `ScreenRejection`'s reasons gain `"silent-tile"`.
  - In `apply`'s match, after `Assign`:

```ts
      AssignStats: ({ tile, game }) =>
        tileAt(this, tile, () => Result.succeed(placed(this, tile, { _tag: "StatsTile", game }))),
```

    and `FocusAudio` becomes:

```ts
      FocusAudio: ({ tile }) =>
        onScreenAt(this, tile, (found) =>
          audible(found) ? Result.succeed({ ...this, audioFocus: Option.some(Tile.key(found)) }) : reject("silent-tile")
        ),
```

  - `Promote` and `Solo` keep the audio focus where it is for a silent tile: in `Promote` write
    `audioFocus: audible(found) ? Option.some(Tile.key(found)) : this.audioFocus`, and in `Solo` likewise.
  - Below `holds`, add (and use `placed` from `Assign` too: `Result.succeed(placed(this, tile, assigned))`, which is
    what `Assign`'s body computes today; if phase 4 already has an equivalent helper for `CustomTile`, keep one of
    the two):

```ts
/** `screen`'s fields with `tile` at `index`: whatever held the same key elsewhere, on screen or benched, is emptied. */
function placed(screen: Screen, index: number, tile: Occupied): Unsettled {
  const key = Tile.key(tile)
  const tiles = screen.tiles.map((existing, at) => (at === index ? tile : holds(existing, key) ? empty : existing))
  return { ...screen, tiles }
}

/** Whether a tile has sound to focus: a stats tile has none. */
function audible(tile: Occupied): boolean {
  return !Tile.guards.StatsTile(tile)
}
```

  - In `settle`, audio falls back only to audible tiles: compute
    `const audibleKeys = tiles.slice(0, slots).flatMap((tile) => (Tile.guards.Empty(tile) || !audible(tile) ? [] : [Tile.key(tile)]))`
    and use it in place of `onScreen` for `audioFocus` (the focused key is kept only while it is in `audibleKeys`;
    otherwise the head of `audibleKeys`). Solo still uses every on-screen key.
  - In `refresh`, a `StatsTile` stays as it is, as phase 4's `CustomTile` does: its tile is returned unchanged before
    the availability lookup.

  `Rejections.ts`: add `"silent-tile": "A stats tile has no sound."`.

  `TileAction.ts`: in `of`, build `hear` only for an audible tile:
  `const heard = Tile.guards.StatsTile(tile) ? [] : [hear]`, and return
  `slot === 0 ? [...heard, solo, clear] : [...heard, promote, solo, clear]`. Doc: "…hear it (not a stats tile, which
  has no sound), promote it…".

- [ ] **Step 4: Run** — PASS.

### Task 38 (phase 6, was task 6.4): `StatsBeside`, the game page in the fold

**Files:** Modify `apps/web/src/display/Display.ts`, `apps/web/src/display/Display.test.ts`

**Interfaces:**
- Produces: `Overlay.GamePage({ game: GameId, back: Overlay })`; `DisplayInput.StatsBeside({ game })`,
  `DisplayInput.GamePageOpened({ game })`; `Info` on a guide game card opens the page; Escape (`Unsolo`) and `Closed`
  on a page return to `back`.

- [ ] **Step 1: Failing tests** in `Display.test.ts` (imports: `GuideItem` from `../guide/GuideItem.ts`, `type GuideShelves`
  and `Overlay` from `./Display.ts`, `Result` from `effect`, `Screen` from `../screen/Screen.ts`):

```ts
describe("Display#apply StatsBeside", () => {
  it("should put a game's stats in the next empty slot after its stream", () => {
    const screen = TestWeb.fill([TestWeb.bama])

    const step = Display.initial.apply(DisplayInput.StatsBeside({ game: TestWeb.bama }), screen, noShelves)

    assert.deepStrictEqual(step.commands, [{ _tag: "AssignStats", tile: 1, game: TestWeb.bama }])
  })

  it("should put a game's stats in the slot after its stream when no slot is empty", () => {
    const screen = TestWeb.fill([TestWeb.irish, TestWeb.bama, usc, ohio])

    const step = Display.initial.apply(DisplayInput.StatsBeside({ game: TestWeb.bama }), screen, noShelves)

    assert.deepStrictEqual(step.commands, [{ _tag: "AssignStats", tile: 2, game: TestWeb.bama }])
  })

  it("should leave a game's stats where they are when already on screen", () => {
    const screen = Result.getOrThrow(
      TestWeb.fill([TestWeb.bama]).apply({ _tag: "AssignStats", tile: 3, game: TestWeb.bama }, TestWeb.onFox)
    )

    const step = Display.initial.apply(DisplayInput.StatsBeside({ game: TestWeb.bama }), screen, noShelves)

    assert.deepStrictEqual(step.commands, [])
  })

  it("should move to Pair to put a game's stats beside it in a one-slot layout", () => {
    const screen = Result.getOrThrow(
      TestWeb.fill([TestWeb.bama]).apply({ _tag: "SetLayout", layout: "Single" }, TestWeb.onFox)
    )

    const step = Display.initial.apply(DisplayInput.StatsBeside({ game: TestWeb.bama }), screen, noShelves)

    assert.deepStrictEqual(step.commands, [
      { _tag: "SetLayout", layout: "Pair" },
      { _tag: "AssignStats", tile: 1, game: TestWeb.bama }
    ])
  })
})

describe("Display GamePage", () => {
  it("should open a game card's page with Info in the full guide", () => {
    const display = new Display({ ...Display.initial, overlay: fullGuide })

    const step = display.apply(DisplayInput.Pressed({ hotkey: { _tag: "Info" } }), Screen.initial, bamaShelf)

    assert.deepStrictEqual(step.display.overlay, Overlay.GamePage({ game: TestWeb.bama, back: fullGuide }))
  })

  it("should return to the guide at its focus with Escape from a game page", () => {
    const display = new Display({
      ...Display.initial,
      overlay: Overlay.GamePage({ game: TestWeb.bama, back: fullGuide })
    })

    const step = display.apply(DisplayInput.Pressed({ hotkey: { _tag: "Unsolo" } }), Screen.initial, bamaShelf)

    assert.deepStrictEqual(step.display.overlay, fullGuide)
  })

  it("should return to the guide when a game page is closed", () => {
    const display = new Display({
      ...Display.initial,
      overlay: Overlay.GamePage({ game: TestWeb.bama, back: fullGuide })
    })

    const step = display.apply(DisplayInput.Closed(), Screen.initial, bamaShelf)

    assert.deepStrictEqual(step.display.overlay, fullGuide)
  })

  it("should open a game page from the palette with nothing to return to", () => {
    const display = new Display({ ...Display.initial, overlay: Overlay.Palette() })

    const step = display.apply(DisplayInput.GamePageOpened({ game: TestWeb.bama }), Screen.initial, noShelves)

    assert.deepStrictEqual(step.display.overlay, Overlay.GamePage({ game: TestWeb.bama, back: Overlay.None() }))
  })

  it("should send nothing to the Screen when a game page opens", () => {
    const step = Display.initial.apply(DisplayInput.GamePageOpened({ game: TestWeb.bama }), Screen.initial, noShelves)

    assert.deepStrictEqual(step.commands, [])
  })
})

const usc = GameId.make("401856800")
const ohio = GameId.make("401858473")

const noShelves: GuideShelves = () => []

const bamaShelf: GuideShelves = () => [[GuideItem.Game({ game: TestWeb.bama })]]

const fullGuide = Overlay.Guide({ level: "Full", entry: "fbs", focus: { rail: false, shelf: 0, item: 0 } })
```

  (If phase 3 put a shelves builder in `TestWeb`, use it for `noShelves`/`bamaShelf`; `GameId` is imported already or
  add it.)

- [ ] **Step 2: Run** `pnpm --filter @sportal/web exec vitest run src/display/Display.test.ts` — FAIL.

- [ ] **Step 3: Implement in `Display.ts`.**
  - `Overlay` gains the case (the `Data.TaggedEnum` record may name `Overlay` inside itself; this was checked to
    typecheck with `tsc` on this repo's settings):

```ts
  /** One game's stats page, and the overlay Escape goes back to: the guide where it was, or none. */
  GamePage: { readonly game: GameId; readonly back: Overlay }
```

  - `DisplayInput` gains:

```ts
  StatsBeside: { readonly game: GameId }
  GamePageOpened: { readonly game: GameId }
```

  - `apply`'s match gains:

```ts
      StatsBeside: ({ game }) => this.statsBeside(game, screen),
      GamePageOpened: ({ game }) => {
        const back = Overlay.$is("Guide")(this.overlay) ? this.overlay : Overlay.None()
        return DisplayStep.of(new Display({ ...this, overlay: Overlay.GamePage({ game, back }) }))
      },
```

  - In `press`, the `Unsolo` case gets a first branch, before phase 3's guide branches:

```ts
      Unsolo: () => {
        if (Overlay.$is("GamePage")(this.overlay)) return DisplayStep.of(this.close())
        // …phase 3's Full → Ribbon, Ribbon → None, then the existing close-or-unsolo, unchanged
      },
```

  - The `Info` case (phase 3 added the hotkey and left it doing nothing) becomes:

```ts
      Info: () => {
        if (!Overlay.$is("Guide")(this.overlay) || this.overlay.focus.rail) return DisplayStep.of(this)
        const { entry, level, focus } = this.overlay
        const item = shelves(entry, level)[focus.shelf]?.[focus.item]
        if (item === undefined || !GuideItem.$is("Game")(item)) return DisplayStep.of(this)
        return DisplayStep.of(
          new Display({ ...this, overlay: Overlay.GamePage({ game: item.game, back: this.overlay }) })
        )
      },
```

  - `close` returns a page's `back`:

```ts
  /** Closes the open overlay: a game page goes back to what it was opened from, anything else to none. */
  close(): Display {
    const overlay = Overlay.$is("GamePage")(this.overlay) ? this.overlay.back : Overlay.None()
    return new Display({ ...this, overlay })
  }
```

  - After `choose`, add:

```ts
  /**
   * Puts game `game`'s stats beside it: in the next empty slot after its stream (or after the selected slot when it
   * is not on screen), else the slot after it; a one-slot layout becomes a Pair first. Stats already on screen stay.
   */
  statsBeside(game: GameId, screen: Screen): DisplayStep {
    if (screen.slotOf(TileKey.stats(game)) !== undefined) return DisplayStep.of(this)
    if (Screen.slotCount(screen.layout) === 1) {
      return DisplayStep.of(this, [
        { _tag: "SetLayout", layout: "Pair" },
        { _tag: "AssignStats", tile: 1, game }
      ])
    }
    const from = screen.slotOf(TileKey.game(game)) ?? this.selectedOn(screen)
    const slot = screen.nextEmptySlot(from) ?? (from + 1) % screen.onScreen().length
    return DisplayStep.of(this, [{ _tag: "AssignStats", tile: slot, game }])
  }
```

  (`Screen` becomes a value import from `../screen/Screen.ts`; import `TileKey` from `@sportal/api/TileKey` and
  `GuideItem` from `../guide/GuideItem.ts` if phase 3 did not already.)

  The atom that tells the shell whether the guide is open (phase 3) keys on `Overlay.$is("Guide")`, so a page is not
  the guide: its arrows go to the page.

- [ ] **Step 4: Run** — PASS.

### Task 39 (phase 6, was task 6.5): `GameStatsView`, `GamePage`, the stats tile body, the palette, and Stats beside — then commit phase 6

**Files:**
- Create: `apps/web/src/stats/GameStats.tsx`, `apps/web/src/display/GamePage.tsx`
- Modify: `apps/web/src/screen/TileBody.tsx`, `apps/web/src/screen/ScreenView.tsx`, `apps/web/src/screen/TileChrome.tsx`,
  `apps/web/src/display/DisplayView.tsx`, `apps/web/src/display/CommandPalette.tsx`, `apps/web/src/remote/ScreenMap.tsx`,
  `CONTEXT.md`

**Interfaces:**
- Consumes: `Stats.stats`, `Stats.statsLive`, `Games.game`, `Games.plays`, `Games.everyPlay`, `StatsFit.sectionsThatFit`,
  `useTheme(): ThemeName`, `teamColor(team, surface)`, `useOverlayRef`.
- Produces: `GameStatsView({ game: GameId; fit: "page" | "tile" })`, `GamePage({ game: GameId })`.

- [ ] **Step 1: Write `apps/web/src/stats/GameStats.tsx`.** For the Team variant, pass `teamColor` the same `surface`
  value `game/GameCard.tsx`'s Team variant passes it (bound below as `teamSurface`; replace its literal with that
  value's source if phase 3 exported one).

```tsx
import { useAtomValue } from "@effect/atom-react"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { GameStats, type Leader, type TeamStat, type WinChance } from "@sportal/domain/GameStats"
import { League } from "@sportal/domain/League"
import type { PlayId } from "@sportal/domain/Play"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/design/ClassName"
import { GameStatus } from "../game/GameStatus.tsx"
import { teamColor } from "../game/TeamColors.ts"
import { TeamLogo } from "../game/TeamLogo.tsx"
import * as Games from "../hub/Games.ts"
import * as Stats from "../hub/Stats.ts"
import { type ThemeName, useTheme } from "../ui/Theme.ts"
import * as StatsFit from "./StatsFit.ts"

/**
 * A game's stats: its header from the snapshot, then linescore, team stats, leaders, win probability and scoring
 * summary, each when the stats have it. On a page every section shows and the page scrolls; in a tile, as many as fit,
 * in that order, and never a scrollbar. A live game's stats follow the Hub; any other game's are asked once.
 */
export function GameStatsView(props: { game: GameId; fit: "page" | "tile" }) {
  const { value } = useAtomValue(Games.game(props.game))
  return Option.match(value, {
    onNone: () => <p className="text-muted-foreground text-sm">Loading…</p>,
    onSome: ({ snapshot }) =>
      snapshot.progress() === "live" ? (
        <LiveStats game={snapshot} fit={props.fit} />
      ) : (
        <AskedStats game={snapshot} fit={props.fit} />
      )
  })
}

function LiveStats(props: { game: GameSnapshot; fit: "page" | "tile" }) {
  const { value } = useAtomValue(Stats.statsLive(props.game.id))
  return <StatsSections game={props.game} fit={props.fit} stats={Option.getOrUndefined(value)} unavailable={false} />
}

function AskedStats(props: { game: GameSnapshot; fit: "page" | "tile" }) {
  const result = useAtomValue(Stats.stats(props.game.id))
  return (
    <StatsSections
      game={props.game}
      fit={props.fit}
      stats={AsyncResult.isSuccess(result) ? result.value : undefined}
      unavailable={AsyncResult.isFailure(result)}
    />
  )
}

interface SectionsProps {
  game: GameSnapshot
  fit: "page" | "tile"
  stats: GameStats | undefined
  unavailable: boolean
}

function StatsSections(props: SectionsProps) {
  const theme = useTheme()
  const sections = sectionsOf(props.game, props.stats, props.unavailable, theme)
  if (props.fit === "tile") return <Fitted sections={sections} />
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      {sections.map(({ section, node }) => (
        <section key={section}>{node}</section>
      ))}
    </div>
  )
}

/** Each section the stats have, in priority order; before the stats, the header and why there are none yet. */
function sectionsOf(
  game: GameSnapshot,
  stats: GameStats | undefined,
  unavailable: boolean,
  theme: ThemeName
): ReadonlyArray<{ section: string; node: ReactNode }> {
  const header = { section: "header", node: <Header game={game} theme={theme} /> }
  if (stats === undefined) {
    const text = unavailable ? "Stats unavailable" : "Loading stats…"
    return [header, { section: "status", node: <p className="text-muted-foreground text-sm">{text}</p> }]
  }
  const { linescore, teamStats, leaders, winProbability, scoringPlays } = stats
  return [
    header,
    ...(linescore.home.length + linescore.away.length > 0
      ? [{ section: "linescore", node: <Linescore game={game} stats={stats} /> }]
      : []),
    ...(teamStats.length > 0
      ? [{ section: "teamStats", node: <TeamStats game={game} rows={teamStats} theme={theme} /> }]
      : []),
    ...(leaders.length > 0 ? [{ section: "leaders", node: <Leaders game={game} leaders={leaders} /> }] : []),
    ...(winProbability !== undefined && winProbability.length > 1
      ? [{ section: "winProbability", node: <WinProbability game={game} chances={winProbability} /> }]
      : []),
    ...(scoringPlays.length > 0 ? [{ section: "scoring", node: <Scoring game={game} ids={scoringPlays} /> }] : [])
  ]
}

/**
 * The sections that fit the tile's height, measured from an invisible copy of all of them at the same width, again
 * whenever the tile or what they hold changes size.
 */
function Fitted(props: { sections: ReadonlyArray<{ section: string; node: ReactNode }> }) {
  const box = useRef<HTMLDivElement>(null)
  const measured = useRef<HTMLDivElement>(null)
  const names = props.sections.map(({ section }) => section)
  const [shown, setShown] = useState<ReadonlyArray<string>>(names.slice(0, 1))
  const key = names.join(" ")

  useLayoutEffect(() => {
    const outer = box.current
    const inner = measured.current
    if (outer === null || inner === null) return undefined
    const fit = () => {
      const sections = key.split(" ")
      const heights = [...inner.children].map((child, index) => ({
        section: sections[index] ?? "",
        height: child.getBoundingClientRect().height
      }))
      const next = StatsFit.sectionsThatFit(outer.clientHeight, heights)
      setShown((last) => (last.join(" ") === next.join(" ") ? last : next))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(outer)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [key])

  return (
    <div ref={box} className="relative size-full overflow-hidden px-3 pt-3">
      <div ref={measured} aria-hidden inert className="invisible absolute inset-x-3 top-3">
        {props.sections.map(({ section, node }) => (
          <div key={section} className="pb-3">
            {node}
          </div>
        ))}
      </div>
      {props.sections
        .filter(({ section }) => shown.includes(section))
        .map(({ section, node }) => (
          <div key={section} className="pb-3">
            {node}
          </div>
        ))}
    </div>
  )
}

/** The surface a Team-theme color is painted on; the same value GameCard's Team variant gives `teamColor`. */
const teamSurface = "#0a0a0a"

function Header(props: { game: GameSnapshot; theme: ThemeName }) {
  const { game, theme } = props
  const away = teamColor(game.away.team, teamSurface)
  const home = teamColor(game.home.team, teamSurface)
  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_auto_1fr] items-center gap-4 rounded-lg p-4",
        theme === "glass" ? "border bg-card/60 backdrop-blur" : "text-white"
      )}
      style={
        theme === "team"
          ? { background: `linear-gradient(90deg, ${away} 50%, ${home} 50%)` }
          : { borderImage: `linear-gradient(90deg, ${away}, ${home}) 1` }
      }
    >
      <Side game={game} side="away" />
      <div className="flex flex-col items-center gap-1">
        <span className="font-mono font-semibold text-3xl">
          {game.scored() ? `${game.away.score}–${game.home.score}` : "vs"}
        </span>
        <GameStatus game={game} className="text-xs" />
      </div>
      <Side game={game} side="home" />
    </div>
  )
}

function Side(props: { game: GameSnapshot; side: "home" | "away" }) {
  const { team, ranking } = props.game[props.side]
  return (
    <div className={cn("flex items-center gap-3", props.side === "home" && "flex-row-reverse text-right")}>
      <TeamLogo team={team} size={48} />
      <div className="min-w-0">
        <p className="truncate font-semibold">
          {ranking === undefined ? "" : <span className="mr-1 text-xs opacity-70">#{ranking}</span>}
          {team.name}
        </p>
      </div>
    </div>
  )
}

function Linescore(props: { game: GameSnapshot; stats: GameStats }) {
  const { home, away } = props.stats.linescore
  const periods = Math.max(home.length, away.length)
  const columns = Array.from({ length: periods }, (_, index) => index)
  const label = League.of(props.game.league).sport === "baseball" ? "" : "Q"
  return (
    <table className="w-full font-mono text-sm">
      <thead className="text-muted-foreground text-xs">
        <tr>
          <th className="text-left font-normal" />
          {columns.map((index) => (
            <th key={index} className="font-normal">
              {index < 4 || label === "" ? `${label}${index + 1}` : `OT${index - 3}`}
            </th>
          ))}
          <th className="font-normal">T</th>
        </tr>
      </thead>
      <tbody>
        {(["away", "home"] as const).map((side) => (
          <tr key={side}>
            <td className="text-left">{props.game[side].team.abbreviation}</td>
            {columns.map((index) => (
              <td key={index} className="text-center">
                {props.stats.linescore[side][index] ?? ""}
              </td>
            ))}
            <td className="text-center font-semibold">{props.game[side].score}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Each stat as away, label, home; a stat of plain numbers gets a two-sided bar, any other is text alone. */
function TeamStats(props: { game: GameSnapshot; rows: ReadonlyArray<TeamStat>; theme: ThemeName }) {
  const away = props.theme === "team" ? teamColor(props.game.away.team, teamSurface) : "var(--muted-foreground)"
  const home = props.theme === "team" ? teamColor(props.game.home.team, teamSurface) : "var(--foreground)"
  return (
    <div className="flex flex-col gap-2 text-sm">
      {props.rows.map((row, index) => {
        const share = GameStats.homeShare(row)
        return (
          <div key={`${row.label}-${index}`} className="flex flex-col gap-1">
            <div className="grid grid-cols-[4rem_1fr_4rem] items-baseline">
              <span className="font-mono">{row.away}</span>
              <span className="text-center text-muted-foreground text-xs">{row.label}</span>
              <span className="text-right font-mono">{row.home}</span>
            </div>
            {Option.match(share, {
              onNone: () => null,
              onSome: (homeShare) => (
                <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
                  <span style={{ width: `${(1 - homeShare) * 100}%`, background: away }} />
                  <span style={{ width: `${homeShare * 100}%`, background: home }} />
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function Leaders(props: { game: GameSnapshot; leaders: ReadonlyArray<Leader> }) {
  const categories = [...new Set(props.leaders.map(({ category }) => category))]
  return (
    <div className="grid grid-cols-[auto_1fr_1fr] gap-x-4 gap-y-2 text-sm">
      {categories.map((category) => (
        <div key={category} className="contents">
          <span className="text-muted-foreground text-xs">{category}</span>
          {(["away", "home"] as const).map((side) => {
            const leader = props.leaders.find((each) => each.category === category && each.side === side)
            return leader === undefined ? (
              <span key={side} />
            ) : (
              <div key={side} className="flex min-w-0 items-center gap-2">
                {leader.athlete.headshot !== undefined && (
                  <img src={leader.athlete.headshot} alt="" loading="lazy" className="size-8 rounded-full bg-secondary object-cover" />
                )}
                <div className="min-w-0">
                  <p className="truncate font-semibold">{leader.athlete.name}</p>
                  <p className="truncate text-muted-foreground text-xs">{leader.line}</p>
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** The home side's chance after each play, as a line over the game, with 50% marked. */
function WinProbability(props: { game: GameSnapshot; chances: ReadonlyArray<WinChance> }) {
  const width = 400
  const height = 80
  const last = props.chances.length - 1
  const points = props.chances
    .map(({ home }, index) => `${((index / last) * width).toFixed(1)},${((1 - home) * height).toFixed(1)}`)
    .join(" ")
  const latest = props.chances[last]?.home ?? 0.5
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-muted-foreground text-xs">
        {props.game.home.team.abbreviation} win probability · {Math.round(latest * 100)}%
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-20 w-full" preserveAspectRatio="none" role="img" aria-label="Win probability">
        <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  )
}

/** The scoring plays' text, in order, read from the game's plays: every play once, and the live page as it grows. */
function Scoring(props: { game: GameSnapshot; ids: ReadonlyArray<PlayId> }) {
  const latest = useAtomValue(Games.plays(props.game.id)).value
  const every = useAtomValue(Games.everyPlay(props.game.id))
  const known = [...(AsyncResult.isSuccess(every) ? every.value : []), ...latest]
  const byId = new Map(known.map((play) => [play.id, play]))
  const plays = props.ids.flatMap((id) => {
    const play = byId.get(id)
    return play === undefined ? [] : [play]
  })
  const period = League.of(props.game.league).sport === "baseball" ? "Inn " : "Q"
  if (plays.length === 0) return <p className="text-muted-foreground text-xs">Scoring summary loading…</p>
  return (
    <ol className="flex flex-col gap-1.5 text-sm">
      {plays.map((play) => (
        <li key={play.id} className="grid grid-cols-[5rem_1fr_auto] gap-3">
          <span className="font-mono text-muted-foreground text-xs">
            {period}
            {play.period} {play.clock}
          </span>
          <span>{play.text}</span>
          <span className="font-mono text-xs">
            {play.awayScore}–{play.homeScore}
          </span>
        </li>
      ))}
    </ol>
  )
}
```

- [ ] **Step 2: Write `apps/web/src/display/GamePage.tsx`:**

```tsx
import { useAtomSet } from "@effect/atom-react"
import type { GameId } from "@sportal/domain/Game"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/design/button"
import { GameStatsView } from "../stats/GameStats.tsx"
import { DisplayInput } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"
import { useOverlayRef } from "./OverlayRef.ts"

/** A game's stats page over the whole Display, every video under it hidden; Escape or Back returns to where it opened. */
export function GamePage(props: { game: GameId }) {
  const ref = useOverlayRef()
  const input = useAtomSet(DisplayState.display)
  return (
    <div ref={ref} className="fixed inset-0 z-40 overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 flex items-center border-b bg-background/90 px-4 py-2 backdrop-blur">
        <Button variant="ghost" size="sm" aria-keyshortcuts="Escape" onClick={() => input(DisplayInput.Closed())}>
          <ArrowLeft />
          Back
        </Button>
      </header>
      <GameStatsView game={props.game} fit="page" />
    </div>
  )
}
```

- [ ] **Step 3: Wire it in.**
  - `DisplayView.tsx`: import `GamePage` and `Overlay`; beside the other overlays:
    `{Overlay.$is("GamePage")(display.overlay) && <GamePage game={display.overlay.game} />}`.
  - `TileBody.tsx`: import `GameStatsView`; add the branch
    `StatsTile: ({ game }) => <GameStatsView game={game} fit="tile" />,` and make the well hold it at full size: the
    tile's well wrapper in `ScreenView`'s `TileFace` is `flex items-center justify-center`; give the stats view's
    container `size-full` (done in `Fitted`), which fills it.
  - `TileChrome.tsx`: import `ChartNoAxesColumn` from `lucide-react`; before the `TileAction` buttons' `.map`, add for a
    game's stream or data tile:

```tsx
        {(Tile.guards.StreamTile(tile) || Tile.guards.DataTile(tile)) && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Stats beside"
            title="Stats beside"
            className="text-muted-foreground"
            onClick={() => input(DisplayInput.StatsBeside({ game: tile.game }))}
          >
            <ChartNoAxesColumn />
          </Button>
        )}
```

    A stats tile's header shows its game's score as a game tile's does (it has `game`, so `ScreenView`'s `TileGame`
    reads its snapshot); before the score, a `label-caps` "Stats" tag:
    `{Tile.guards.StatsTile(tile) && <span className="label-caps text-[10px] text-muted-foreground">Stats</span>}`.
  - `CommandPalette.tsx`: after the "Watch in tile N" group:

```tsx
        <CommandGroup heading="Stats">
          {snapshots.map((game) => (
            <CommandItem
              key={`page-${game.id}`}
              value={`stats page ${game.scoreline()} ${game.away.team.name} ${game.home.team.name} ${game.id}`}
              onSelect={() => input(DisplayInput.GamePageOpened({ game: game.id }))}
            >
              Stats: {game.scoreline()}
            </CommandItem>
          ))}
          {snapshots.map((game) => (
            <CommandItem
              key={`tile-${game.id}`}
              value={`stats tile ${game.scoreline()} ${game.away.team.name} ${game.home.team.name} ${game.id}`}
              onSelect={() => run({ _tag: "AssignStats", tile: selected, game: game.id })}
            >
              Stats for {game.scoreline()} in tile {selected + 1}
            </CommandItem>
          ))}
        </CommandGroup>
```

    (`GamePageOpened` replaces the palette, as "Control from a phone" does, so it does not call `onOpenChange`.)
    In the "Tiles" group, the name of a stats tile's slot is `Stats ${scoreline}`: where the group finds a tile's
    name, a `StatsTile` reads `Stats ${snapshot.scoreline()}`.
  - `remote/ScreenMap.tsx`: where it names a tile from its game's snapshot, a `StatsTile` reads "Stats" before the
    scoreline; nothing else changes (the Remote can move, solo and clear it; audio focus is refused as on the Display).

- [ ] **Step 4: CONTEXT.md.** In **Tile**'s row: "One slot's content: a **stream tile**, a **data tile**, a
  **custom tile**, a **stats tile** (a game's stats, no provider view and no sound), or empty." In **Overlay**'s row
  add "a game's page (`GamePage`, its stats over the whole Display, and the overlay Escape returns to)". In
  **Display input**'s row add "a game's stats put beside it (`StatsBeside`), a game's page opened (`GamePageOpened`)".
  In **Screen rejection**'s row nothing changes. Add under "Viewing":

```md
| **Stats tile** | A tile showing one game's stats (`StatsTile`, keyed `stats:<game>`): as many sections as fit, never a scrollbar; placed from the palette or by **Stats beside** on a game's tile (the next empty slot, else the slot after the game's; a one-slot layout becomes a Pair). It never has audio focus. | |
| **Game page** | One game's stats over the whole Display, every section, scrolling (`GamePage` overlay); opened by `I` on a guide card or from the palette, and closed by Escape back to where it opened. | stats screen |
```

- [ ] **Step 5: `pnpm check`**, then commit:

```bash
git add apps/web/src packages/api/src/TileKey.ts CONTEXT.md
git commit -m "$(cat <<'EOF'
feat: a game's stats as a page and as a tile

GameStatsView with page and tile fits (StatsFit picks the sections that
fit), Glass and Team variants; the GamePage overlay from I on a guide card
or the palette, Escape back to where it opened; StatsTile placed from the
palette or by Stats beside, with no sound.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7 — Highlights

### Task 40 (phase 7, was task 7.1): Clip tiles on the Screen and `ChosenClip`

**Files:** Modify `packages/api/src/TileKey.ts`, `apps/web/src/screen/Screen.ts`, `Screen.test.ts`,
`apps/web/src/screen/TileRects.test.ts`, `apps/web/src/display/Display.ts`, `Display.test.ts`,
`apps/web/src/guide/GuideItem.ts`

**Interfaces:**
- Produces: `TileKey.clip(id: HighlightId)` (`clip:<id>`); `Tile` case `ClipTile: { highlight: Highlight }`;
  `ScreenCommand` case `AssignClip: { tile: Int, highlight: Highlight }`; `DisplayInput.ChosenClip({ highlight })`;
  `GuideItem.Clip({ highlight })`.

- [ ] **Step 1: Failing tests.** `Screen.test.ts` (import `highlight` from `@sportal/domain/TestGame`):

```ts
  it("should put a highlight in a clip tile", () => {
    const clip = highlight()

    const screen = run(Screen.initial, { _tag: "AssignClip", tile: 2, highlight: clip })

    assert.deepStrictEqual(screen.tiles[2], { _tag: "ClipTile", highlight: clip })
  })

  it("should give audio focus to a clip tile", () => {
    const screen = run(TestWeb.fill([TestWeb.bama]), { _tag: "AssignClip", tile: 1, highlight: highlight() })

    const focused = run(screen, { _tag: "FocusAudio", tile: 1 })

    assert.deepStrictEqual(focused.audioFocus, Option.some(TileKey.clip(highlight().id)))
  })
```

  `TileRects.test.ts`:

```ts
  it("should mute every stream while a clip tile has audio focus", () => {
    const screen = Result.getOrThrow(
      Result.flatMap(
        TestWeb.fill([TestWeb.bama]).apply({ _tag: "AssignClip", tile: 1, highlight: highlight() }, TestWeb.onFox),
        (withClip) => withClip.apply({ _tag: "FocusAudio", tile: 1 }, TestWeb.onFox)
      )
    )

    const placed = TileRects.placements(screen, TileRects.tileRects(screen, area), { x: 0, y: 0 }, undefined)

    assert.deepStrictEqual(
      placed.map(({ muted }) => muted),
      [true]
    )
  })
```

  (`area` is that file's existing test area; else `{ width: 1600, height: 900 }`.)

  `Display.test.ts`:

```ts
describe("Display#apply ChosenClip", () => {
  it("should put a chosen clip in the selected slot and select the next empty slot", () => {
    const clip = highlight()

    const step = Display.initial.apply(DisplayInput.ChosenClip({ highlight: clip }), Screen.initial, noShelves)

    assert.deepStrictEqual(step.commands, [{ _tag: "AssignClip", tile: 0, highlight: clip }])
    assert.strictEqual(step.display.selected, 1)
  })

  it("should leave a chosen clip already on screen where it is", () => {
    const clip = highlight()
    const screen = Result.getOrThrow(Screen.initial.apply({ _tag: "AssignClip", tile: 2, highlight: clip }, TestWeb.onFox))

    const step = Display.initial.apply(DisplayInput.ChosenClip({ highlight: clip }), screen, noShelves)

    assert.deepStrictEqual(step.commands, [])
  })

  it("should close the open overlay once a clip is chosen", () => {
    const display = new Display({ ...Display.initial, overlay: Overlay.GamePage({ game: TestWeb.bama, back: fullGuide }) })

    const step = display.apply(DisplayInput.ChosenClip({ highlight: highlight() }), Screen.initial, noShelves)

    assert.deepStrictEqual(step.display.overlay, Overlay.None())
  })

  it("should choose the focused clip with Confirm in the full guide", () => {
    const clip = highlight()
    const display = new Display({ ...Display.initial, overlay: fullGuide })

    const step = display.apply(DisplayInput.Pressed({ hotkey: { _tag: "Confirm" } }), Screen.initial, () => [
      [GuideItem.Clip({ highlight: clip })]
    ])

    assert.deepStrictEqual(step.commands, [{ _tag: "AssignClip", tile: 0, highlight: clip }])
  })
})
```

- [ ] **Step 2: Run**
  `pnpm --filter @sportal/web exec vitest run src/screen/Screen.test.ts src/screen/TileRects.test.ts src/display/Display.test.ts` — FAIL.

- [ ] **Step 3: Implement.**
  - `TileKey.ts`: add `clip` beside `stats`:

```ts
/** The key of highlight `id`'s clip tile. */
function clip(id: HighlightId): TileKey {
  return TileKey.make(`clip:${id}`)
}
```

  - `Screen.ts`: `Tile` gains `/** A highlight playing in a page video, with sound when it has audio focus. */ ClipTile: { highlight: Highlight },`
    (import `Highlight` from `@sportal/domain/Highlight`); `Tile.key` gains
    `ClipTile: ({ highlight }) => TileKey.clip(highlight.id)`; `ScreenCommand` gains
    `AssignClip: { tile: Schema.Int, highlight: Highlight },`; `apply` gains

```ts
      AssignClip: ({ tile, highlight }) =>
        tileAt(this, tile, () => Result.succeed(placed(this, tile, { _tag: "ClipTile", highlight }))),
```

    and `refresh` keeps a `ClipTile` as it is, as it does a `StatsTile`. A clip tile is audible (`audible` is unchanged).
  - `guide/GuideItem.ts`: the enum gains `Clip: { readonly highlight: Highlight }` (doc: "a final game's highlight, in
    the full guide's Highlights shelf").
  - `Display.ts`: `DisplayInput` gains `ChosenClip: { readonly highlight: Highlight }`; `apply` gains
    `ChosenClip: ({ highlight }) => this.chooseClip(highlight, screen),`. Phase 3's `Confirm` (and `GuideItemChosen`)
    match on the focused `GuideItem` gains `Clip: ({ highlight }) => this.chooseClip(highlight, screen)`.
    `choose` and phase 4's custom choice share one private `place`; make it, or keep it if phase 4 made it:

```ts
  /** Puts game `game` in the selected slot, by `place`'s rule. */
  choose(game: GameId, screen: Screen): DisplayStep {
    return this.place(TileKey.game(game), (tile) => ({ _tag: "Assign", tile, game }), screen)
  }

  /** Puts highlight `highlight` in the selected slot, by `place`'s rule, and closes any overlay: a choice ends it. */
  chooseClip(highlight: Highlight, screen: Screen): DisplayStep {
    const { display, commands } = this.place(
      TileKey.clip(highlight.id),
      (tile) => ({ _tag: "AssignClip", tile, highlight }),
      screen
    )
    return DisplayStep.of(display.close().close(), commands)
  }

  /**
   * Puts what `key` names in the selected slot: benched, it is swapped in; free, `assigned` puts it there; on screen,
   * it stays where it is. Then selects the next empty slot, or keeps the selection when none is left.
   */
  private place(key: TileKey, assigned: (tile: number) => ScreenCommand, screen: Screen): DisplayStep {
    if (screen.slotOf(key) !== undefined) return DisplayStep.of(this)
    const slot = this.selectedOn(screen)
    const bench = screen.benched().find((each) => each.key === key)
    const { display, commands } = this.select(screen.nextEmptySlot(slot) ?? slot, screen)
    const placed: ScreenCommand = bench === undefined ? assigned(slot) : { _tag: "Swap", a: bench.tile, b: slot }
    return DisplayStep.of(display, [placed, ...commands])
  }
```

    `display.close().close()` closes a page opened from the guide and then the guide it returns to. If phase 3's
    `Confirm` already closes the guide after its choice, it closes an overlay that is already none, which is a no-op.

- [ ] **Step 4: Run** — PASS.

### Task 41 (phase 7, was task 7.2): The Highlights shelf

**Files:** Modify `apps/web/src/guide/GuideShelves.ts`, `apps/web/src/guide/GuideShelves.test.ts`,
`apps/web/src/guide/FullGuide.tsx`

**Interfaces:**
- Produces: `GuideShelves.highlightShelf(today, yesterday): ReadonlyArray<GuideItem>`;
  `GuideShelves.highlightsShown: Atom.Writable<ReadonlySet<LeagueId>>`; `guideShelves` gains a last parameter
  `highlights: ReadonlyMap<LeagueId, ReadonlyArray<GuideItem>>`.

- [ ] **Step 1: Failing tests** in `GuideShelves.test.ts` (import `highlight` from `@sportal/domain/TestGame`,
  `HighlightId` from `@sportal/domain/Highlight`, `GuideItem` from `./GuideItem.ts`):

```ts
describe("GuideShelves.highlightShelf", () => {
  it("should list today's highlights before yesterday's", () => {
    const today = highlight({ id: HighlightId.make("today") })
    const yesterday = highlight({ id: HighlightId.make("yesterday") })

    const shelf = GuideShelves.highlightShelf([today], [yesterday])

    assert.deepStrictEqual(shelf, [GuideItem.Clip({ highlight: today }), GuideItem.Clip({ highlight: yesterday })])
  })

  it("should list a highlight both days have once, as today's", () => {
    const both = highlight({ id: HighlightId.make("both") })

    const shelf = GuideShelves.highlightShelf([both], [both])

    assert.deepStrictEqual(shelf, [GuideItem.Clip({ highlight: both })])
  })
})

describe("GuideShelves.guideShelves highlights", () => {
  it("should put a league's highlights last in its full guide", () => {
    const clips = [GuideItem.Clip({ highlight: highlight() })]

    const shelves = GuideShelves.guideShelves(TestWeb.todayList.games, [], new Map([["fbs", clips]]))("fbs", "Full")

    assert.deepStrictEqual(shelves.at(-1), clips)
  })

  it("should leave highlights out of the ribbon", () => {
    const clips = [GuideItem.Clip({ highlight: highlight() })]

    const shelves = GuideShelves.guideShelves(TestWeb.todayList.games, [], new Map([["fbs", clips]]))("fbs", "Ribbon")

    assert.notDeepInclude(shelves, clips)
  })
})
```

  (The first two arguments are whatever phase 3/4's `guideShelves` takes — today's games and the custom streams;
  pass them as its existing tests do.)

- [ ] **Step 2: Run** `pnpm --filter @sportal/web exec vitest run src/guide/GuideShelves.test.ts` — FAIL.

- [ ] **Step 3: Implement in `GuideShelves.ts`.**

```ts
/** A league's Highlights shelf: today's final games' clips, then yesterday's, each clip once. */
export function highlightShelf(
  today: ReadonlyArray<Highlight>,
  yesterday: ReadonlyArray<Highlight>
): ReadonlyArray<GuideItem> {
  const seen = new Set<HighlightId>()
  return [...today, ...yesterday].flatMap((highlight) => {
    if (seen.has(highlight.id)) return []
    seen.add(highlight.id)
    return [GuideItem.Clip({ highlight })]
  })
}

/** The leagues whose Highlights shelf has shown, so their highlights are asked for; the full guide adds to it. */
export const highlightsShown: Atom.Writable<ReadonlySet<LeagueId>> = Atom.make<ReadonlySet<LeagueId>>(
  new Set()
).pipe(Atom.keepAlive)
```

  `guideShelves(…, highlights: ReadonlyMap<LeagueId, ReadonlyArray<GuideItem>>)`: for a `LeagueId` entry at level
  `"Full"`, after its Final shelf, append `highlights.get(entry)` when it is there and not empty. The ribbon, All live
  and Custom never get it.

  In the `shelves` atom, before it calls `guideShelves`:

```ts
  const today = Option.map(get(Games.today).value, ({ date }) => date)
  const highlights = new Map(
    Option.match(today, {
      onNone: () => [],
      onSome: (date) =>
        [...get(highlightsShown)].map((league) => {
          const clipsOf = (day: CalendarDate) =>
            AsyncResult.getOrElse(get(Stats.highlights({ league, date: day })), () => [])
          return [league, highlightShelf(clipsOf(date), clipsOf(dayBefore(date)))] as const
        })
    })
  )
```

  and below, a private helper:

```ts
/** The calendar day before `date`. */
function dayBefore(date: CalendarDate): CalendarDate {
  const noon = DateTime.makeUnsafe(`${date}T12:00:00Z`)
  return CalendarDate.make(DateTime.formatIsoDate(DateTime.subtract(noon, { days: 1 })))
}
```

  (imports: `CalendarDate` from `@sportal/api/GamesQuery`, `Highlight`/`HighlightId` from the domain, `LeagueId`,
  `AsyncResult` from `effect/reactivity`, `DateTime`, `Option` from `effect`, `* as Stats from "../hub/Stats.ts"`.)

  `FullGuide.tsx`: when the open entry is a league, add it to `highlightsShown` once it shows:

```tsx
  const showHighlights = useAtomSet(GuideShelves.highlightsShown)
  useEffect(() => {
    if (entry === "AllLive" || entry === "Custom") return
    showHighlights((shown) => (shown.has(entry) ? shown : new Set([...shown, entry])))
  }, [entry, showHighlights])
```

  A shelf whose first item is a `Clip` is titled "Highlights" (where FullGuide titles its shelves), and each `Clip`
  item renders as `<HighlightCard highlight={highlight} focused={…} onChoose={…} />` with the same focus and click
  (`GuideItemChosen({ shelf, item })`) a game card gets.

- [ ] **Step 4: Run** — PASS.

### Task 42 (phase 7, was task 7.3): `HighlightCard`, the clip tile's video, the page's highlights — then commit phase 7

**Files:**
- Create: `apps/web/src/stats/HighlightCard.tsx`
- Modify: `apps/web/src/stats/GameStats.tsx`, `apps/web/src/screen/TileBody.tsx`, `apps/web/src/screen/ScreenView.tsx`,
  `apps/web/src/screen/TileChrome.tsx`, `apps/web/src/remote/ScreenMap.tsx`, `CONTEXT.md`

- [ ] **Step 1: Write `apps/web/src/stats/HighlightCard.tsx`:**

```tsx
import type { Highlight } from "@sportal/domain/Highlight"
import { cn } from "@/design/ClassName"
import { useTheme } from "../ui/Theme.ts"

/** A highlight as a card: its thumbnail with its length, and its headline; Glass or Team, as the game cards. */
export function HighlightCard(props: { highlight: Highlight; focused: boolean; onChoose: () => void }) {
  const theme = useTheme()
  const { highlight } = props
  return (
    <button
      type="button"
      onClick={props.onChoose}
      className={cn(
        "flex w-56 shrink-0 flex-col overflow-hidden rounded-lg text-left transition-transform duration-100 motion-reduce:transition-none",
        theme === "glass" ? "border bg-card/60 backdrop-blur" : "bg-card",
        props.focused && (theme === "glass" ? "scale-[1.04] shadow-lg" : "outline outline-2 outline-white")
      )}
    >
      <span className="relative block aspect-video bg-well">
        {highlight.thumbnail !== undefined && (
          <img src={highlight.thumbnail} alt="" loading="lazy" className="size-full object-cover" />
        )}
        <span className="absolute right-1.5 bottom-1.5 rounded-sm bg-black/70 px-1 font-mono text-[11px] text-white">
          {highlight.durationText()}
        </span>
      </span>
      <span className={cn("line-clamp-2 p-2 text-xs", theme === "team" && "bg-black/80 text-white")}>
        {highlight.headline}
      </span>
    </button>
  )
}
```

- [ ] **Step 2: The page's highlights.** In `GameStats.tsx`, import `useAtomSet`, `DisplayInput`, `* as DisplayState`,
  `HighlightCard`, `type Highlight`; in `sectionsOf`, after the scoring section:

```tsx
    ...(stats.highlights.length > 0
      ? [{ section: "highlights", node: <Highlights highlights={stats.highlights} /> }]
      : [])
```

  and below `Scoring`:

```tsx
function Highlights(props: { highlights: ReadonlyArray<Highlight> }) {
  const input = useAtomSet(DisplayState.display)
  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {props.highlights.map((highlight) => (
        <HighlightCard
          key={highlight.id}
          highlight={highlight}
          focused={false}
          onChoose={() => input(DisplayInput.ChosenClip({ highlight }))}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 3: The clip tile.**
  - `TileBody.tsx` takes `heard: boolean` beside `tile` and `snapshot`, and gains
    `ClipTile: ({ highlight }) => <ClipVideo highlight={highlight} heard={props.heard} />,`, with below:

```tsx
/** A highlight in a page video: it plays at once, muted unless its tile has audio focus, and rests on its last frame. */
function ClipVideo(props: { highlight: Highlight; heard: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  // React sets `muted` only when the element is made; audio focus moving later sets it here.
  useEffect(() => {
    if (ref.current !== null) ref.current.muted = !props.heard
  }, [props.heard])
  return (
    <div className="relative flex size-full items-center justify-center">
      <video
        ref={ref}
        src={props.highlight.video}
        poster={props.highlight.thumbnail}
        autoPlay
        controls
        playsInline
        muted={!props.heard}
        className="max-h-full max-w-full"
      />
      <span className="label-caps absolute top-2 left-2 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
        Replay
      </span>
    </div>
  )
}
```

  - `ScreenView.tsx`'s `TileFace` passes `heard={key !== undefined && props.screen.hears(key)}` with
    `const key = Tile.key(props.tile)`. A `ClipTile` has no game: render it as `TileFace` with `snapshot={undefined}`,
    beside the branch phase 4 made for `CustomTile` (e.g. `Tile.guards.ClipTile(tile) || Tile.guards.CustomTile(tile)`).
  - `TileChrome.tsx`: a `ClipTile`'s header reads `Replay · {tile.highlight.headline}` (truncated) where an empty tile
    reads its "Empty — …" text and a game tile its score.
  - `remote/ScreenMap.tsx`: a `ClipTile` is named by its headline, as phase 4 names a custom tile by its name.

- [ ] **Step 4: CONTEXT.md.** **Tile**'s row gains "a **clip tile** (a highlight in a page video)". **Display
  input**'s row gains "a highlight chosen (`ChosenClip`)". **Guide** (phase 3's row) gains "a league's full guide ends
  with a Highlights shelf: today's final games' highlights, then yesterday's, asked when the shelf first shows". Add
  under "Viewing":

```md
| **Clip tile** | A tile playing one highlight in a page video (`ClipTile`, keyed `clip:<highlight id>`), with a Replay badge, muted unless it has audio focus, resting on its last frame at the end. No provider view; clips are kept nowhere. | replay tile |
```

- [ ] **Step 5: `pnpm check`**, then commit:

```bash
git add apps/web/src packages/api/src/TileKey.ts CONTEXT.md
git commit -m "$(cat <<'EOF'
feat: highlights in the guide, on the game page, and in a clip tile

A league's full guide ends with today's and yesterday's highlights; the game
page lists its game's; a chosen clip plays in a ClipTile's page video,
muted unless it has audio focus.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Contract notes

1. **Port `stats` signature.** The contract says `stats(game: GameId): Effect<GameStats, StatsUnavailable>`. The port's
   existing `plays(league, game)` takes the league (it picks the summary URL) and fails with `ProviderUnavailable`, so
   this part makes it `stats(league: LeagueId, game: GameId): Effect<GameStats, ProviderUnavailable>`. The `Stats`
   service maps that error to `StatsUnavailable` (in `packages/api`), the way the Schedule maps it to
   `ScheduleUnavailable`.
2. **`EspnSummary.decode` signature.** It is `decode(league, game, body)`, an `Effect` failing with `SchemaError`
   rather than `decode(payload, game): GameStats`. It takes the league because baseball's scoring plays come from
   `plays` (MLB sends no `scoringPlays`), and basketball, where every basket scores, gets none. It takes the body so
   the JSON decode happens in one place, as `EspnPlay.summaryPlays(league, body)` does.
3. **The `highlights` RPC's error** is `StatsUnavailable` (when the day cannot be listed). The contract gave none.
   A final game whose summary fails is logged and left out; the whole answer does not fail.
4. **New names not in the contract:** `DisplayInput.GamePageOpened({ game })`, which the palette uses to open a page
   because `Opened` takes only payload-less overlays; `ScreenCommand.AssignStats({ tile, game })` and
   `AssignClip({ tile, highlight })`, since `Assign` stays a `GameId`; `ScreenRejection` reason `"silent-tile"`
   (focusing audio on a stats tile); `HubClient.stats/highlights/plays`; `Games.everyPlay`;
   `GuideShelves.highlightShelf`, `GuideShelves.highlightsShown`, and a last `highlights` parameter on
   `guideShelves`; `stats/HighlightCard.tsx`.
5. **`GameStats` additions:** `static homeShare(stat)` (the bar's split; numeric means both values match
   `^\d+(\.\d+)?$`). `Highlight#durationText()`. `TeamStat`, `Leader` and `WinChance` are exported `Schema.Struct`s
   beside `GameStats`, each with a CONTEXT row.
6. **The scoring summary** looks up `GameStats.scoringPlays` ids in `Games.everyPlay` (every page of the one-shot
   `plays` RPC) merged with `Games.plays` (the live page). This follows the spec's "the scoring plays' text, from the
   game's plays". The live page alone would miss early scoring plays of a long game.
7. **`statsLive` for a game that is not live** sends empty stats (upcoming) or the final stats once (over), and moves
   on as the game's progress changes, through `Schedule.gameLive` with `Stream.switchMap`. The web reads `statsLive`
   only for a live game and `stats` otherwise, as the spec says.
8. **MLB and NBA stats on a running Hub** are unavailable for now: `EspnLeague.followed` serves only NFL and FBS, so
   `EspnLeague.of("mlb")` is none and the Hub lists no MLB or NBA games. The decode and its fixtures cover all four
   leagues, so a later `EspnLeague` row turns them on.
9. **MLB team stats** keep 11 rows out of about 170: batting hits, home runs, RBIs, walks, strikeouts, stolen bases,
   left on base and average; pitching pitches and ERA; fielding errors (`groupedKept` in `EspnSummary.ts`). MLB sends
   no `leaders`, so its leaders are empty.
10. **Stats beside in a one-slot layout** sends `SetLayout Pair`, then `AssignStats` into slot 1. When no slot is
    empty, the stats replace the tile in the slot after the game's, which the spec's "else the slot after the game's"
    implies.
11. **Assumed phase 3 and 4 shapes**, used by anchor:
    - `Display.apply/press(input, screen, shelves)`, with phase 3's `Info` case left doing nothing.
    - `GuideItem` as a `Data.taggedEnum` with `$is` and `$match`.
    - `guideShelves(games, customs, …)` as the pure builder, plus a `shelves` atom.
    - FullGuide's `entry` and its per-item focus and click.
    - `teamColor(team, surface)`, given here the same `surface` value GameCard's Team variant gives it.
    - A `placed`-like helper for `CustomTile`, and a `place` helper behind `ChosenCustom`, if phase 4 made them; this
      part reuses them rather than adding a second.
12. **Fixtures:** `nfl-summary-401872971.json` is now the full summary of the same game. That keeps `EspnPlay`'s and
    `EspnProvider`'s assertions on its drives. It has no videos (they have expired), so the NFL fixture is the
    "no highlights" case, and FBS, MLB and NBA carry the highlight assertions.

---

## Phase 8 — Docs and eye-check

### Task 43 (phase 8, was task 8.1): Glossary, technical spec, eye-check list — then commit

**Files:**
- Modify: `CONTEXT.md`, `docs/technical-spec.md`, `docs/game-day-checklist.md`, `docs/specs/2026-10-16-ui-overhaul-design.md`

**Interfaces:** Consumes everything above. Produces documentation only.

- [ ] **Step 1: Glossary sweep.** Run `git diff a948d5b --stat` and, for every new exported type name in the diff
  (`rg -n "^export (class|const|type|interface) " $(git diff a948d5b --name-only -- '*.ts' '*.tsx')`), confirm a
  `CONTEXT.md` row exists (React components are exempt). Add any missing row in the file's style. Remove rows for
  removed names (the top bar, if named).
- [ ] **Step 2: Technical spec.** In `docs/technical-spec.md`: the Display section describes the Screen with the docked
  ribbon and the full guide instead of the top bar; the guide's state in the `Display` fold; `setGuideOpen` on the
  bridge; themes; custom, stats and clip tiles and `TileKey`; the Hub's `Stats` service, its refresh while followed,
  and the `stats`, `statsLive`, `highlights` RPCs; update the source trees for every new and removed file.
- [ ] **Step 3: Spec amendments.** Append a short "Amendments while planning" section to the spec listing Amendments
  1–9 of the plan in one line each.
- [ ] **Step 4: Eye-check list.** Append to `docs/game-day-checklist.md`, in its numbering style, a section
  **Eye-check: UI overhaul** with these items:
  - Glass and Team themes in the ribbon, the full guide, a stats page and a stats tile.
  - The ribbon docks under the Screen in the desktop shell and every video keeps playing, resized.
  - With the guide closed, arrow keys reach a focused player (seek on a YouTube custom tile); with it open, they move the guide.
  - A YouTube video and a playlist play in the shell (watch page) and in a browser (embed; no autoplay expected).
  - A stats page and a stats tile for a live game update about every 30 s.
  - A highlight plays in a tile, muted until it has audio focus.
  - A toast hides only the strip of video it covers; the connection-lost toast clears when the Hub is back.
  - Ctrl+K still works, including Add YouTube… and Stats entries.
  - The Remote moves, solos and clears a custom tile.
- [ ] **Step 5: Check and commit.**

```bash
pnpm check
git add CONTEXT.md docs/technical-spec.md docs/game-day-checklist.md docs/specs/2026-10-16-ui-overhaul-design.md
git commit -m "docs: the UI overhaul in the glossary, the tech spec, and an eye-check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `pnpm check` exits 0.
