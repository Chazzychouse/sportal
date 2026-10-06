# Guide-only channels — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry out `docs/specs/2026-10-06-guide-only-design.md`. The source's guide becomes the only answer to
where a game airs. The hand-picked channel lineup goes from every app: its store, its endpoints, the picking tile,
the shell's guide views, and the buttons.

**Architecture:** One branch `guide-only` in the worktree `../sportal-guide-only` (it exists, with the spec
committed). Tasks 1–5 run in order. Each task is one commit, and `pnpm check` passes on each. The order puts the new
answer in first (Task 1). Then the hand pick goes from the Hub outwards: the Hub and its clients (Task 2), the
domain's leftovers (Task 3), the shell (Task 4), and the docs (Task 5).

**Tech Stack:** Effect 4, Electron, React, Vitest with `@effect/vitest`, Biome, dependency-cruiser, knip, pnpm
workspaces.

## Global constraints

- Read `AGENTS.md` and `CONTEXT.md` before any task. Their rules apply to every line written here.
- Effect 4 is newer than training data. Before writing Effect code, read `node_modules/effect/ai-docs/src/index.md`
  and the example it points to for the API at hand. Copy the patterns of the file you are editing.
- `pnpm check` passes before every commit. Run single tests with `pnpm vitest run <path>`.
- This change only removes things, apart from the one new answer, **no guide**. Add no module, service, setting, or
  helper.
- A glossary row changes in the same commit as the code it names (AGENTS.md).
- No export lives only for its tests (`knip --production`). Deleting the last user of an export deletes the export
  in the same commit.
- No `any`, non-null assertions, enums, default exports, or casts outside decoding.
- Comments: doc comments on major exports. Inline comments only for a non-obvious why. Rewrite any doc comment that
  mentions the lineup, learning, picking, or a guide view.
- This plan gives signatures and test cases. Write bodies from the code you are changing.
- Commits: Task 1 is `feat:`, Tasks 2–4 are `refactor:`, Task 5 is `docs:`. Every commit ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Setup

- [ ] `cd ../sportal-guide-only && pnpm install --frozen-lockfile --prefer-offline`
- [ ] `pnpm check` should PASS. Every task below runs in `../sportal-guide-only`.

## File map

| File | Change | Task |
|---|---|---|
| `packages/domain/src/Channel.ts` | + `NoGuide`; − `ChannelCarriage`, `ChannelLineup`, `ChannelUrlRefused`; − `Unlearned`, `learnedFor` | 1, 2, 3 |
| `packages/domain/src/Channel.test.ts` | deleted (it tests only the lineup) | 2 |
| `packages/domain/src/Stage.ts` | + `DataTile.why.NoGuide`; − `PickingChannel`, `StreamTile.learnedFor`; one refresh rule | 1, 3 |
| `packages/domain/src/Guide.ts` | `Carried` without `learnedFor` | 3 |
| `apps/hub/src/source/Source.ts` | − `learn`, `markNotCarried`, `forget` | 2 |
| `apps/hub/src/source/ChannelStore.ts` (+ test) | deleted | 2 |
| `apps/hub/src/source/youtube-tv/YouTubeTv.ts` | state is the fresh guide or none; `NoGuide` without one | 2 |
| `apps/hub/src/scenario/ScenarioSource.ts` | − three stubs; − `learnedFor` | 2, 3 |
| `apps/hub/src/HubMode.ts` | stops providing `ChannelStore` | 2 |
| `apps/hub/src/hub-server/HubServer.ts` | − `channels` group | 2 |
| `packages/api/src/SportalApi.ts` | − `channels` group | 2 |
| `packages/api/src/ShellBridge.ts`, `ShellChannel.ts` | − `ChannelPick`, `onChannelPicked`, `channelPicked`, `TilePlacement.role` | 4 |
| `apps/desktop/src/main/TileViews.ts` (+ test) | − `channelPicks`, `Role`; an entry carries `interactive` | 4 |
| `apps/desktop/src/main/YouTubeTv.ts` | − `isChannelAddress` | 4 |
| `apps/desktop/src/main/main.ts`, `apps/desktop/src/preload/ShellBridge.ts` | − the channel-pick forward | 4 |
| `apps/web/src/hub/HubClient.ts` | − `learnChannel`, `markNotCarried`, `forgetChannel` | 2 |
| `apps/web/src/stage/StageView.tsx` | − pick subscription, buttons, `notices`, `channelCommand`, `channelNotice` | 2 |
| `apps/web/src/stage/TileBody.tsx` | + `NoGuide` copy; − picking tile | 1, 3 |
| `apps/web/src/stage/TileRects.ts` (+ test) | − picking placement (3); − `role` (4) | 3, 4 |
| `CONTEXT.md` | rows per task | 1–4 |
| `docs/technical-spec.md`, `docs/game-day-checklist.md` | brought in line | 5 |

---

### Task 1: A source can answer no guide

Adds the answer and the data tile that shows it. Nothing produces it yet, so behaviour does not change.

**Files:**
- Modify: `packages/domain/src/Channel.ts` (`ChannelAvailability`), `packages/domain/src/Stage.ts` (`Tile`, `tileFor`)
- Test: `packages/domain/src/Stage.test.ts`
- Modify: `apps/web/src/stage/TileBody.tsx` (`noStream`)
- Modify: `CONTEXT.md`

**Interfaces:**
- Produces: `ChannelAvailability.NoGuide({ source: SourceName })`.
- Produces: `DataTile.why` gains `Schema.TaggedStruct("NoGuide", {})`.

- [ ] **Step 1: Write the failing tests** in `Stage.test.ts`:
  - `Stage#apply` › "assigns a game its source has no guide for as a data tile saying so". Assigning with
    `availabilityOf` answering `NoGuide({ source: "YouTube TV" })` gives
    `{ _tag: "DataTile", game, why: { _tag: "NoGuide" } }`.
  - `Stage#refresh` › "keeps a guide-matched stream tile playing when its source has no guide". Use a stream tile
    without `learnedFor`. A refresh answering `NoGuide` leaves it as it was.
  - `Stage#refresh` › "turns a no-guide data tile into a stream once the guide carries its game".
- [ ] **Step 2:** `pnpm vitest run packages/domain/src/Stage.test.ts`. Expect FAIL: typecheck errors on `NoGuide`.
- [ ] **Step 3: Implement.**
  - Add the `NoGuide` variant to `ChannelAvailability` and its doc comment ("…or no guide, when the source has no
    fresh guide to say").
  - Add the `NoGuide` reason to `DataTile.why`. Add a `tileFor` case for it.
  - In `TileBody.noStream`, `NoGuide` reads "Waiting for the YouTube TV guide".
  - `CONTEXT.md`: in **Channel availability**, add "no guide (the source has no fresh guide to say)". Add a row
    **No guide**: "A source's answer while it has no fresh guide: before the first read, and once the last is
    stale." Avoid: "unknown".
- [ ] **Step 4:** `pnpm vitest run packages/domain/src/Stage.test.ts`. Expect PASS. Then `pnpm check`.
- [ ] **Step 5: Commit** `feat(domain): a source can answer no guide`.

---

### Task 2: YouTube TV answers from its guide alone

The hand pick goes from the Hub, the API, and the web UI in one commit. These three share the `channels` API group,
so none of them compiles alone.

**Files:**
- Modify: `apps/hub/src/source/Source.ts`, `apps/hub/src/source/youtube-tv/YouTubeTv.ts`,
  `apps/hub/src/scenario/ScenarioSource.ts`, `apps/hub/src/HubMode.ts`, `apps/hub/src/hub-server/HubServer.ts`
- Delete: `apps/hub/src/source/ChannelStore.ts`, `apps/hub/src/source/ChannelStore.test.ts`
- Modify: `packages/api/src/SportalApi.ts`
- Modify: `packages/domain/src/Channel.ts` (delete `ChannelCarriage`, `ChannelLineup`, `ChannelUrlRefused`)
- Delete: `packages/domain/src/Channel.test.ts`
- Modify: `apps/web/src/hub/HubClient.ts`, `apps/web/src/stage/StageView.tsx`
- Test: `apps/hub/src/source/youtube-tv/YouTubeTv.test.ts`, `apps/hub/src/StageSessions.test.ts`,
  `apps/hub/src/hub-server/HubServer.test.ts`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `ChannelAvailability.NoGuide` (Task 1).
- Produces: the `Source` service is
  ```ts
  {
    readonly availability: Effect.Effect<(game: GameSnapshot) => ChannelAvailability>
    readonly changes: Stream.Stream<void>
    readGuide(guide: string): Effect.Effect<void, GuideUnreadable>
  }
  ```
- Produces: `YouTubeTv.layer: Layer.Layer<Source>`. It has no `ChannelStore` requirement.

- [ ] **Step 1: Change the tests.**
  - `YouTubeTv.test.ts`:
    - Rewrite "starts with every network unlearned…" as "answers no guide before any guide is read". The result is
      `NoGuide({ source: "YouTube TV" })`.
    - Rewrite "falls back to the lineup once its guide is 45 minutes old, and signals then" as "answers no guide
      once its guide is 45 minutes old, and signals then".
    - Delete every case that learns, marks not carried, forgets, or loads the store. That is lines 40–156 today
      and "keeps answering from the guide after the lineup changes". Also delete the store-seeding helper.
    - `testSource()` provides `YouTubeTv.layer` with no store and no database.
  - `StageSessions.test.ts`: these cases used `learn` only to make the source change. Make the change with
    `source.readGuide(recordedGuide)` instead. Before the read the game's tile is the `NoGuide` data tile; assert
    that after the read it is no longer that tile.
    - "refreshes the stage when the source learns a channel" becomes "refreshes the stage when the source reads a
      guide".
    - "does not miss a change made the moment the layer has built": its `learnAtOnce` becomes a read at once.
    - "applies a command with availability as it is when the command lands…" and "keeps a playing tile whose game
      has left the slate when another network is learned": the trigger becomes a guide read.
    - "assigns a carried game as a stream tile…" no longer seeds through `learn`/`markNotCarried`. It reads the
      recorded guide under the `TestClock` at the read instant, as the stale-guide case already does. Then it
      assigns one game the guide carries and one it does not.
    - "keeps a guide-matched tile playing when its guide goes stale and the lineup answers" becomes "…when its
      guide goes stale". Its middle assertion expects `NoGuide`.
    - Drop `ChannelStore.layer` from the test layer.
  - `HubServer.test.ts`:
    - Delete "refuses to learn an address that is not a channel".
    - Rewrite "turns an assignment on an unlearned network into a picking tile" and the `it.live` learn/forget/
      not-carried case as one case: "turns an assignment with no guide read into a data tile saying so".
    - Drop `ChannelStore.layer` from `hubUnderTest`.
- [ ] **Step 2:** `pnpm vitest run apps/hub`. Expect FAIL. `YouTubeTv` still answers `Unlearned`, and the layer
  still needs `ChannelStore`.
- [ ] **Step 3: Implement.**
  - `Source.ts`: remove the three methods and the `ChannelStoreError` and `ChannelUrlRefused` imports. Rewrite
    `availability`'s doc: "from its latest guide while that is fresh; otherwise no guide".
  - `YouTubeTv.ts`:
    - The state is `SubscriptionRef<Option<Guide>>`. `availability` answers from a fresh guide, or
      `NoGuide({ source })` with none.
    - The expiry fiber and the `changes` stream keep their shape.
    - Delete `record`, `learn`, `markNotCarried`, `forget`, `decodeLiveChannelUrl`, and the module-level `guide`
      constant. `LiveChannelUrl` and `decodeLiveChannelUrlOption` stay: `liveOf` uses them.
    - Rewrite the layer's doc comment and `staleAfter`'s ("…so the source answers no guide until the next read").
  - `ScenarioSource.ts`: delete the three stubs and "Nothing is learned or stored."
  - `HubMode.ts`: `YouTubeTv.layer` without `Layer.provide(ChannelStore.layer)`.
  - `HubServer.ts` and `SportalApi.ts`: delete the `channels` group and its handlers. If `storeFailureDies` has no
    other user, delete it too.
  - `Channel.ts`: delete `ChannelCarriage`, `ChannelLineup`, `ChannelUrlRefused`. Delete `Channel.test.ts`.
  - `HubClient.ts`: delete `learnChannel`, `markNotCarried`, `forgetChannel`.
  - `StageView.tsx`: delete the `onChannelPicked` effect, both buttons, the `learnedFor` local, the `notices`
    state, its slot in `TileChrome`'s header, `channelCommand`, and `channelNotice`. Delete the imports that leave
    unused.
  - `CONTEXT.md`: delete the rows **Channel carriage**, **Channel lineup**, **Channel URL refused**, **Channel
    store**, **Channel store error**. In **Hub client**, drop "and channel".
- [ ] **Step 4:** `pnpm vitest run apps/hub packages/domain`. Expect PASS. Then `pnpm check`.
- [ ] **Step 5: Commit** `refactor: YouTube TV answers from its guide alone; the hand-picked lineup is gone`.

---

### Task 3: No picking tile, one refresh rule

Nothing produces `Unlearned` or a hand-picked tile after Task 2. This task deletes them from the domain and from what
reads them.

**Files:**
- Modify: `packages/domain/src/Channel.ts`, `packages/domain/src/Guide.ts`, `packages/domain/src/Stage.ts`
- Test: `packages/domain/src/Stage.test.ts`, `packages/domain/src/Guide.test.ts`
- Modify: `apps/hub/src/scenario/ScenarioSource.ts`
- Test: `apps/hub/src/source/youtube-tv/YouTubeTv.test.ts` (`onNews3`), `apps/hub/src/StageSessions.test.ts`,
  `apps/hub/src/hub-server/HubServer.test.ts` (fixtures with `learnedFor` or `PickingChannel`)
- Modify: `apps/web/src/stage/TileBody.tsx`, `apps/web/src/stage/TileRects.ts`
- Test: `apps/web/src/stage/TileRects.test.ts`, `apps/web/src/stage/TileActions.test.ts` (fixtures only)
- Modify: `CONTEXT.md`

**Interfaces:**
- Produces: `ChannelAvailability.Carried({ channel: Channel })`.
- Produces: `Tile` is `Empty | StreamTile { game, channel } | DataTile { game, why }`.
- Produces: `Stage#refresh(availabilityOf: (game: GameId) => Option.Option<ChannelAvailability>): Stage`. A
  `StreamTile` is replaced only by `Carried` on a channel whose `locator.url` differs from its own. Every other
  occupied tile becomes `tileFor(game, availability)`. A game `availabilityOf` knows nothing about keeps its tile.

- [ ] **Step 1: Change the tests** in `Stage.test.ts`:
  - Delete "assigns a game on an unlearned network as a picking tile".
  - Delete these `Stage#refresh` cases: "turns every picking tile…", "moves a picking tile…", "turns a stream tile
    back into a picking tile…", and "makes a hand-picked stream tile follow its channel…".
  - "keeps a guide-matched stream tile playing on any answer but a channel" becomes "keeps a stream tile playing on
    any answer but another channel". It covers `NoGuide`, `Upcoming`, both `NotCarried` reasons, and `Carried` on
    the tile's own channel. Fold in Task 1's no-guide refresh case.
  - "moves a guide-matched stream tile to the channel a later guide carries it on" becomes "moves a stream tile to
    the channel a later guide carries it on".
  - In every fixture, drop `learnedFor` from `Carried` answers and stream tiles.
- [ ] **Step 2:** `pnpm vitest run packages/domain`. Expect PASS. A tile the guide matched already follows this
  rule, and Step 3 only deletes the other kind. The own-channel case guards the rewrite: it must stay green.
- [ ] **Step 3: Implement.**
  - `Channel.ts`: drop `Unlearned` and `Carried.learnedFor`. Rewrite the doc comment as "carried, upcoming, not
    carried with why, or no guide".
  - `Guide.ts`: `Carried({ channel })`.
  - `Stage.ts`:
    - Delete `PickingChannel` and `StreamTile.learnedFor` with its doc comment.
    - In `tileFor`, delete the `Unlearned` case and the `learnedFor` spread.
    - Write `refresh` to the rule above. Rewrite its doc comment: one rule, no origins.
    - Drop the imports left unused (`SourceName`, `StreamLocator`, `Network` if nothing else uses them).
  - `ScenarioSource.ts`: `Carried({ channel })`.
  - `TileBody.tsx`: delete the `PickingChannel` case. Its doc reads "covers a stream tile's well".
  - `TileRects.ts`: delete the `PickingChannel` branch of `placements`, and "and picking" from its doc.
  - Hub, web, and `Guide.test.ts` fixtures: drop `learnedFor` and `PickingChannel`.
  - `CONTEXT.md`:
    - Delete **Picking tile**.
    - **Tile** reads "a **stream tile**, a **data tile**, or empty".
    - **Channel availability** loses "unlearned".
- [ ] **Step 4:** `pnpm vitest run packages/domain apps/hub apps/web`. Expect PASS. Then `pnpm check`.
- [ ] **Step 5: Commit** `refactor(domain): no picking tile; a stream tile moves only to another channel`.

---

### Task 4: The shell has only stream views

**Files:**
- Modify: `packages/api/src/ShellBridge.ts`, `packages/api/src/ShellChannel.ts`
- Modify: `apps/desktop/src/main/TileViews.ts`, `apps/desktop/src/main/YouTubeTv.ts`, `apps/desktop/src/main/main.ts`,
  `apps/desktop/src/preload/ShellBridge.ts`
- Test: `apps/desktop/src/main/TileViews.test.ts`
- Modify: `apps/web/src/stage/TileRects.ts`
- Test: `apps/web/src/stage/TileRects.test.ts`
- Modify: `CONTEXT.md`

**Interfaces:**
- Produces: `TilePlacement = { game, url, bounds, muted, interactive }`.
- Produces: `TileViews` is `{ sync, hide, hotkeys, tilePresses }`.
- Produces: an `Entry` is `{ view, url: Option<string>, interactive: boolean, bounds }`.
- Produces: `ShellBridge` without `onChannelPicked`, and `ShellChannel` without `channelPicked`.

- [ ] **Step 1: Change the tests.**
  - `TileViews.test.ts`:
    - Delete the `TileViews.channelPicks` describe.
    - Hotkeys: rename to "forwards hotkeys from stream views and keeps them from the page", without the guide view.
    - Mouse filter: rename "…a guide view gets them all" to "keeps every mouse event from a stream view's page",
      without the guide view.
    - "does not report a press on an interactive view, or on a view removed in a sync": replace its guide view
      with a second stream view.
    - Drop `role` from the base `placement`.
  - `TileRects.test.ts`: drop `role` from expected placements.
- [ ] **Step 2:** `pnpm vitest run apps/desktop apps/web`. Expect FAIL: typecheck errors on `role`.
- [ ] **Step 3: Implement.**
  - `ShellBridge.ts` (api):
    - Delete `TilePlacement.role`, `ChannelPick`, and `onChannelPicked`.
    - `TilePlacement`'s doc loses its stream-or-guide sentence.
    - `readGuide`'s doc is unchanged.
  - `ShellChannel.ts`: delete `channelPicked`.
  - `preload/ShellBridge.ts`: delete `onChannelPicked`. `main.ts`: delete the `channelPicked` forward.
  - `TileViews.ts`:
    - Delete `channelPicks`, the `picks` PubSub, `landed`, and both navigation listeners.
    - Delete `Role` and the `Data` import. An `Entry` holds `interactive`.
    - The key and mouse listeners drop their role checks.
    - Delete the comment "A guide view gets every key…".
    - The class doc loses "or guide tile" and "reads the address a guide view lands on". The `Entry` doc loses its
      guide sentence.
  - `desktop/YouTubeTv.ts`: delete `isChannelAddress`.
  - `TileRects.ts`: `placements` builds `{ url, muted, interactive }` for a stream tile only.
  - `CONTEXT.md`:
    - Delete **Channel pick**.
    - **Tile views**: "per stream tile".
    - **Tile placement**: "Where a game's stream tile sits in a Display's window, what it loads, and whether it is
      muted or interactive, as told to the shell".
- [ ] **Step 4:** `pnpm vitest run apps/desktop apps/web`. Expect PASS. Then `pnpm check`.
- [ ] **Step 5: Commit** `refactor(shell): only stream views; the channel pick is gone`.

---

### Task 5: Docs match

**Files:**
- Modify: `docs/technical-spec.md`, `docs/game-day-checklist.md`

- [ ] **Step 1:** Edit `docs/technical-spec.md`:
  - Tree: `Channel.ts` is "SourceName, Channel, ChannelAvailability". Delete the `ChannelStore.ts` line.
    `YouTubeTv.ts` is "Guide reading and availability".
  - Stage state: "each empty, stream, or data".
  - `grep -n -i "learn\|picking\|lineup\|carriage" docs/technical-spec.md` shows nothing about channels.
- [ ] **Step 2:** Edit `docs/game-day-checklist.md`:
  - Row 4: drop "and no channel picking".
  - Row 9: drop the fallback sentence.
  - Row 10: delete it.
  - Row 13: "while the shell has read a guide in the last 45 minutes, tiles there are guide-matched as in the shell;
    with no guide read (or the last one stale), a game's tile says 'Waiting for the YouTube TV guide'".
  - Row 22: drop "with no picking tile".
  - Row 30: delete it.
  - Row 35: drop "no picking tile".
  - Renumber the rows and fix any cross-references to row numbers.
  - Add a row after row 4: "Quit the shell for 45 minutes, or start the Hub with no shell; assign a game | Its tile
    says 'Waiting for the YouTube TV guide'; opening the shell turns it into a stream within seconds".
- [ ] **Step 3:** `pnpm check`. Expect PASS.
- [ ] **Step 4: Commit** `docs: the technical spec and game-day checklist have no hand-picked channels`.

---

## After the tasks

- [ ] `plannotator review` on the branch against `main`.
- [ ] On merge, add a `docs/history.md` row in the merge's follow-up commit, as for `hub-one-path`.
