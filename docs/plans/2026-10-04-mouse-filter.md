# Mouse Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stream tile's player never sees the pointer, so YouTube TV's title and controls stop covering the game; a click on a video selects its tile, and `I` lets the mouse through to the selected tile's player.

**Architecture:** `TileViews` handles each provider view's `before-mouse-event` and prevents it while the view is a stream that is not interactive. A left press on a filtered view is published as the game's id; `main.ts` sends it to the web UI over a new bridge call, `onTilePressed`, and `StageView` selects the tile holding that game. `TilePlacement` gains `interactive`; the web UI keeps one interacting game, local like the selected tile, toggled by the new `Interact` hotkey and ended by selecting another tile. The shell focuses a view when it becomes interactive.

**Tech Stack:** Effect 4 (`Context.Service`, `Layer`, `PubSub`, `Stream`, `Schema`), Electron 44 (castlabs `v44.1.0+wvcus`, `WebContents` `before-mouse-event`), React 19, `@effect/vitest`.

**Spec:** `docs/specs/2026-10-04-mouse-filter-design.md`. Findings: ADR 0002, "Amendment: the mouse filter". Work only in the worktree `/home/chazzy/development/projects/sportal/.worktrees/mouse-filter` (branch `mouse-filter`), created from the main checkout with `git worktree add .worktrees/mouse-filter -b mouse-filter` and then `pnpm install --frozen-lockfile --prefer-offline` inside it. Never edit files or switch branches in the main checkout.

## Global Constraints

- Read `AGENTS.md` first; its file-layout and in-file order rules are requirements. Effect 4 APIs are checked in `node_modules/effect/ai-docs/src/`, never written from memory.
- `pnpm check` passes before every commit.
- Every exported type name is a `CONTEXT.md` term; a new term adds its row in the same commit.
- Provider pages are loaded unmodified: the shell sets a view's address, bounds, visibility, mute flag, and focus, reads the keys pressed in a stream view, and withholds mouse input from a stream view. Nothing is injected.
- A picking tile (role `guide`) always gets the mouse.
- At most one tile is interacting, and it is local to the Display, like the selected tile.
- Comments only where the why is not obvious; doc comments on exports.

---

## File map

```
packages/api/src/ShellBridge.ts                 Task 1 (TilePlacement.interactive, ShellBridge.onTilePressed)
apps/desktop/src/main/TileViews.ts, .test.ts    Task 1 (filter, presses, focus)
apps/desktop/src/main/main.ts                   Task 1 (forward presses)
apps/desktop/src/preload/ShellBridge.ts         Task 1 (onTilePressed)
apps/web/src/stage/TileRects.ts, .test.ts       Task 1 (interactive: false), Task 2 (interacting game)
packages/api/src/Hotkey.ts, .test.ts            Task 2 (Interact)
apps/web/src/App.tsx                            Task 2 (interacting state, select)
apps/web/src/stage/StageView.tsx                Task 2 (pass interacting, select on press)
CONTEXT.md                                      Task 2 (Interacting tile)
docs/game-day-checklist.md                      Task 3
```

### Task 1: The shell filters stream views and reports presses

**Files:**
- Modify: `packages/api/src/ShellBridge.ts`
- Modify: `apps/desktop/src/main/TileViews.ts`
- Test: `apps/desktop/src/main/TileViews.test.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/preload/ShellBridge.ts`
- Modify: `apps/web/src/stage/TileRects.ts` (one field, so the web UI still typechecks)

**Interfaces:**
- Produces: `TilePlacement.interactive: boolean`; `ShellBridge.onTilePressed(listener: (game: GameId) => void): () => void`; `TileViews.tilePresses: Stream.Stream<GameId>`; IPC channel `"sportal:tile-pressed"` carrying a `GameId`.

- [ ] **Step 1: Extend the contract.** In `packages/api/src/ShellBridge.ts`, add the field to `TilePlacement` and extend its doc comment:

```ts
/**
 * Where a game's provider view sits in the Display's window, in CSS pixels, and what it loads. A `stream` view
 * plays a channel; a `guide` view shows the source's guide so the user can pick the channel for a network.
 * An `interactive` stream's player gets the mouse; every other stream's player never sees it.
 * A view belongs to its game, so a game that changes tiles keeps its player.
 */
export const TilePlacement = Schema.Struct({
  game: GameId,
  url: Schema.String,
  role: Schema.Literals(["stream", "guide"]),
  bounds: Schema.Struct({ x: Schema.Int, y: Schema.Int, width: Schema.Int, height: Schema.Int }),
  muted: Schema.Boolean,
  interactive: Schema.Boolean
})
```

and add to `ShellBridge`, after `onHotkey`:

```ts
  /** Calls `listener` with the game whose stream view was clicked while its player had no mouse. Returns a function that stops the calls. */
  onTilePressed(listener: (game: GameId) => void): () => void
```

- [ ] **Step 2: Keep the web UI compiling.** In `apps/web/src/stage/TileRects.ts`, `placements` adds `interactive: false` to both view shapes (Task 2 replaces the stream's):

```ts
        ? {
            url: tile.channel.locator.url.startsWith("/")
              ? new URL(tile.channel.locator.url, page).href
              : tile.channel.locator.url,
            role: "stream" as const,
            muted: stage.audioFocus !== tile.game,
            interactive: false
          }
        : tile._tag === "PickingChannel"
          ? // A guide can preview what is on; it never takes the sound.
            { url: tile.guide.url, role: "guide" as const, muted: true, interactive: false }
          : undefined
```

- [ ] **Step 3: Write the failing tests.** In `apps/desktop/src/main/TileViews.test.ts`:
  - add `interactive: false` to the shared `placement` constant;
  - add `focus: vi.fn()` to `fakeContents()`;
  - add this block after `describe("TileViews.hotkeys", …)`:

```ts
describe("TileViews mouse filter", () => {
  const guide = { ...placement, game: two, role: "guide" as const, url: "https://tv.youtube.com/live" }
  const mouse = (view: number, type: string, button?: string) => {
    const event = { preventDefault: vi.fn() }
    created[view]?.webContents.emit("before-mouse-event", event, { type, button, x: 5, y: 5 })
    return event.preventDefault
  }

  it.effect("keeps every mouse event from a stream view's page; a guide view gets them all", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement, guide])
      for (const type of ["mouseMove", "mouseEnter", "mouseDown", "mouseUp", "mouseWheel", "contextMenu"])
        expect(mouse(0, type)).toHaveBeenCalled()
      expect(mouse(1, "mouseMove")).not.toHaveBeenCalled()
      expect(mouse(1, "mouseDown", "left")).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("lets the mouse reach an interactive stream view, and filters it again once it is not", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([{ ...placement, interactive: true }])
      expect(mouse(0, "mouseMove")).not.toHaveBeenCalled()
      yield* tiles.sync([placement])
      expect(mouse(0, "mouseMove")).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("focuses a view when it becomes interactive, and only then", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      expect(created[0]?.webContents.focus).not.toHaveBeenCalled()
      yield* tiles.sync([{ ...placement, interactive: true }])
      yield* tiles.sync([{ ...placement, interactive: true, muted: false }])
      expect(created[0]?.webContents.focus).toHaveBeenCalledTimes(1)
    }).pipe(Effect.scoped)
  )

  it.effect("reports a left press on a filtered stream view as its game", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement, guide])
      const presses = yield* collect(tiles.tilePresses, 1)
      mouse(1, "mouseDown", "left")
      mouse(0, "mouseDown", "right")
      mouse(0, "mouseUp", "left")
      mouse(0, "mouseDown", "left")
      expect(yield* Fiber.join(presses)).toEqual([one])
    }).pipe(Effect.scoped)
  )

  it.effect("does not report a press on an interactive view, or on a view removed in a sync", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([{ ...placement, interactive: true }])
      const presses = yield* collect(tiles.tilePresses, 1)
      mouse(0, "mouseDown", "left")
      yield* tiles.sync([{ ...placement, game: two }])
      mouse(0, "mouseDown", "left")
      mouse(1, "mouseDown", "left")
      expect(yield* Fiber.join(presses)).toEqual([two])
    }).pipe(Effect.scoped)
  )
})
```

- [ ] **Step 4: Run them to see them fail.**
  Run: `pnpm vitest run apps/desktop/src/main/TileViews.test.ts`
  Expected: the five new tests FAIL (no `preventDefault` calls, `tilePresses` undefined, `focus` never called); the existing tests pass.

- [ ] **Step 5: Implement in `apps/desktop/src/main/TileViews.ts`.**
  - Class doc comment, second sentence onward, becomes: "The shell only ever sets a view's address, bounds, visibility, mute flag, and focus, reads the address a guide view lands on, reads the keys pressed in a stream view, and keeps the mouse from a stream view's player unless it is interactive; the provider's page is never modified."
  - In the service shape, after `hotkeys`:

```ts
    /** Each game whose stream view was pressed with the left button while its player had no mouse. The page never receives it. */
    readonly tilePresses: Stream.Stream<GameId>
```

  - In the layer, beside `const hotkeys = …`: `const presses = yield* PubSub.unbounded<GameId>()`
  - In `create`, the new entry gets `interactive: false`, and after the `before-input-event` handler:

```ts
          // YouTube TV shows its title and controls whenever the pointer moves over a player.
          entry.view.webContents.on("before-mouse-event", (event, mouse) => {
            if (views.get(game) !== entry || entry.role !== "stream" || entry.interactive) return
            event.preventDefault()
            if (mouse.type === "mouseDown" && mouse.button === "left") PubSub.publishUnsafe(presses, game)
          })
```

  - In `sync`, replace `entry.role = placement.role` with:

```ts
            entry.role = placement.role
            if (placement.interactive && !entry.interactive) entry.view.webContents.focus()
            entry.interactive = placement.interactive
```

  - Return `tilePresses: Stream.fromPubSub(presses)` beside `hotkeys`.
  - `Entry` gains `interactive: boolean`, and its doc comment reads "One game's view, the address last placed in it, its role, whether its player gets the mouse, the last channel address it reported, and where it is now."

- [ ] **Step 6: Run the tests to see them pass.**
  Run: `pnpm vitest run apps/desktop/src/main/TileViews.test.ts`
  Expected: PASS, all tests.

- [ ] **Step 7: Forward presses to the web UI.** In `apps/desktop/src/main/main.ts`, after the `tiles.hotkeys` fork in `serveHub`:

```ts
    yield* Effect.forkScoped(
      tiles.tilePresses.pipe(
        Stream.runForEach((game) =>
          Effect.sync(() => {
            if (!window.isDestroyed()) window.webContents.send("sportal:tile-pressed", game)
          })
        )
      ),
      { startImmediately: true }
    )
```

  In `apps/desktop/src/preload/ShellBridge.ts`, import `GameId` as a type (`import type { GameId } from "@sportal/domain/Game"`) and add after `onHotkey`:

```ts
  onTilePressed: (listener) => {
    // The page gets the game alone, never the IPC event.
    const forward = (_event: IpcRendererEvent, game: GameId) => listener(game)
    ipcRenderer.on("sportal:tile-pressed", forward)
    return () => {
      ipcRenderer.removeListener("sportal:tile-pressed", forward)
    }
  },
```

- [ ] **Step 8: Check and commit.**
  Run: `pnpm check`
  Expected: passes.

```bash
git add packages/api/src/ShellBridge.ts apps/desktop/src/main/TileViews.ts apps/desktop/src/main/TileViews.test.ts apps/desktop/src/main/main.ts apps/desktop/src/preload/ShellBridge.ts apps/web/src/stage/TileRects.ts
git commit -m "feat(desktop): stream views never give their player the mouse; a press selects the tile"
```

### Task 2: `I` makes the selected tile interacting; a press selects a tile

**Files:**
- Modify: `packages/api/src/Hotkey.ts`
- Test: `packages/api/src/Hotkey.test.ts`
- Modify: `apps/web/src/stage/TileRects.ts`
- Test: `apps/web/src/stage/TileRects.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/stage/StageView.tsx`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `TilePlacement.interactive`, `ShellBridge.onTilePressed` (Task 1); `Stage#slotOf(game): number | undefined` (exists).
- Produces: `Hotkey` case `{ _tag: "Interact" }`; `placements(stage, rects, origin, page, interacting: GameId | undefined)`.

- [ ] **Step 1: Write the failing hotkey test.** In `packages/api/src/Hotkey.test.ts`, in "reads the letter and function keys", add:

```ts
    assert.deepStrictEqual(key("KeyI"), { _tag: "Interact" })
    assert.deepStrictEqual(key("KeyI", {}, "stream"), { _tag: "Interact" })
```

- [ ] **Step 2: Run it to see it fail.**
  Run: `pnpm vitest run packages/api/src/Hotkey.test.ts`
  Expected: FAIL, `undefined` is not `{ _tag: "Interact" }`.

- [ ] **Step 3: Add the hotkey.** In `packages/api/src/Hotkey.ts`:
  - in the union, after `SelectTile`:

```ts
    /** Give the selected tile's player the mouse, or take it back. */
    Schema.TaggedStruct("Interact", {}),
```

  - in `of`'s switch, after `case "KeyL"`:

```ts
        case "KeyI":
          return { _tag: "Interact" }
```

  - in `keys`, after the `F` (ToggleSolo) entry:

```ts
      {
        group: "Tiles",
        keys: ["I"],
        does: "Use the selected tile's player with the mouse, or stop",
        press: { code: "KeyI", from: "stream" },
        hotkey: { _tag: "Interact" }
      },
```

- [ ] **Step 4: Run it to see it pass.**
  Run: `pnpm vitest run packages/api/src/Hotkey.test.ts`
  Expected: PASS, including the `Hotkey.keys` tests that every hotkey is listed and every listed press reads back.

- [ ] **Step 5: Write the failing placements test.** In `apps/web/src/stage/TileRects.test.ts`, pass `undefined` as a fifth argument to every existing `placements(…)` call, and add to `describe("placements", …)`:

```ts
  it("gives the mouse only to the interacting game's stream", () => {
    const stage = streaming()
    assert.deepStrictEqual(
      placements(stage, tileRects(stage, area), { x: 0, y: 0 }, "http://127.0.0.1:4401", irish).map(
        (placement) => placement.interactive
      ),
      [false, true]
    )
    assert.deepStrictEqual(
      placements(stage, tileRects(stage, area), { x: 0, y: 0 }, "http://127.0.0.1:4401", undefined).map(
        (placement) => placement.interactive
      ),
      [false, false]
    )
  })
```

- [ ] **Step 6: Run it to see it fail.**
  Run: `pnpm vitest run apps/web/src/stage/TileRects.test.ts`
  Expected: FAIL, `[false, false]` is not `[false, true]`.

- [ ] **Step 7: Implement `placements`.** In `apps/web/src/stage/TileRects.ts`, add the parameter, set the stream's field from it, and extend the doc comment:

```ts
/**
 * What the shell must show for each stream and picking tile with a size: its game's view, in window pixels.
 * `origin` is where the Stage area sits in the window; `page` is the web UI's own address, which a source's path
 * (a scenario's synthetic stream) is resolved against. Only `interacting`'s stream gets the mouse.
 */
export function placements(
  stage: Stage,
  rects: ReturnType<typeof tileRects>,
  origin: { x: number; y: number },
  page: string,
  interacting: GameId | undefined
): Array<TilePlacement> {
```

  with `interactive: tile.game === interacting` in the stream shape (the guide keeps `interactive: false`) and `import type { GameId } from "@sportal/domain/Game"`.

- [ ] **Step 8: Run it to see it pass.**
  Run: `pnpm vitest run apps/web/src/stage/TileRects.test.ts`
  Expected: PASS.

- [ ] **Step 9: Hold the interacting game in `App.tsx`.**
  - After `const [selected, setSelected] = useState(0)`:

```ts
  // The game whose player gets the mouse, after `I`. Local, like `selected`, and ended by selecting another tile.
  const [interacting, setInteracting] = useState<GameId | undefined>(undefined)
  const select = (tile: number) => {
    setSelected(tile)
    if (tile !== selected) setInteracting(undefined)
  }
```

  - Replace `setSelected(dropped.select)` in `dropCard` with `select(dropped.select)`, the `SelectTile` case with `return hotkey.slot < live.stage.onStage().length ? select(hotkey.slot) : undefined`, and `onSelect={setSelected}` on `StageView` with `onSelect={select}`.
  - Add the case, after `SelectTile`:

```ts
      case "Interact": {
        const tile = live.stage.onStage()[selected]
        if (tile?._tag !== "StreamTile") return
        return setInteracting((game) => (game === tile.game ? undefined : tile.game))
      }
```

  - Pass `interacting={interacting}` to `StageView`.

- [ ] **Step 10: Use it in `StageView.tsx`.**
  - Add `interacting: GameId | undefined` to the props (import `GameId` from `@sportal/domain/Game` as a type, beside `GameSnapshot`).
  - `const placed = placements(shown, rects, area, window.location.origin, props.interacting)`
  - After the `onChannelPicked` effect:

```ts
  // A click on a video reaches the shell, not this page: the shell reports which game's view it was.
  useEffect(
    () =>
      window.sportalShell?.onTilePressed((game) => {
        const slot = props.stage.slotOf(game)
        if (slot !== undefined) props.onSelect(slot)
      }),
    [props.stage, props.onSelect]
  )
```

- [ ] **Step 11: Add the glossary row.** In `CONTEXT.md`, after the **Audio focus** row in the Stage table:

```md
| **Interacting tile** | The one stream tile whose player gets the mouse, after `I`; every other stream tile's player never sees the pointer. Local to the Display, like the selected tile. | active, unlocked |
```

- [ ] **Step 12: Check and commit.**
  Run: `pnpm check`
  Expected: passes.

```bash
git add packages/api/src/Hotkey.ts packages/api/src/Hotkey.test.ts apps/web/src/stage/TileRects.ts apps/web/src/stage/TileRects.test.ts apps/web/src/App.tsx apps/web/src/stage/StageView.tsx CONTEXT.md
git commit -m "feat(web): I gives the selected tile's player the mouse; a press on a video selects its tile"
```

### Task 3: Game-day rows, and the user's run

**Files:**
- Modify: `docs/game-day-checklist.md`

- [ ] **Step 1: Add the rows** after row 36:

```md
| 37 | With two games playing, rest and move the pointer over each video | No YouTube TV title or controls appear on either |
| 38 | Click a video that is not the selected tile | That tile becomes selected; playback does not pause or change |
| 39 | Select a playing tile and press `I`, then use the player's controls with the mouse | The controls appear and work on that tile only; the other tiles still show no controls |
| 40 | Press `I` again, or select another tile | The player stops getting the mouse; hovering it shows nothing again |
```

- [ ] **Step 2: Commit.**

```bash
git add docs/game-day-checklist.md
git commit -m "docs: game-day rows for the mouse filter"
```

- [ ] **Step 3: Hand over to the user.** Agent-launched Electron misreports rendering on this machine: ask the user to run `pnpm dev:x11` from the worktree (stopping any Hub already on port 4400) and walk rows 37–40, with live games or `SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_SCENARIO_SPEED=10 pnpm dev:x11`. Native Wayland is expected to fail for reasons outside this plan (ADR 0002).
