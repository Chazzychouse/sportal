# Stage Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Stage becomes a real multiview: named layouts with movable dividers, a bench, swap and promote, solo, Display full screen, audio that follows the game, hotkeys, a command palette, and transitions in which the video moves with its tile, on a shadcn-based UI.

**Architecture:** `packages/domain` gains `Layout` (slot geometry as fractions) and a wider `Stage` (layout, splits, bench, solo, audio by game). The web UI turns the Stage area's size and `Layout#slots` into pixel rectangles once, and uses the same numbers to position its tile chrome and to place the shell's provider views. The shell keys views by game, so a moved game keeps its player, and interpolates view bounds toward each new target with the curve the CSS uses. Overlays render through an overlay host that hides only the views they cover.

**Tech Stack:** TypeScript 6, Effect 4.0.0, React 19, Tailwind 4, shadcn (Radix, cmdk, sonner), Electron 44 (castlabs), Vitest 5.

**Spec:** `docs/specs/2026-10-03-stage-control-design.md`.

## Global Constraints

- Read `AGENTS.md` first; its file-layout and in-file order rules are requirements. Effect 4 APIs are checked in `node_modules/effect/ai-docs/src/` and `src/`, never written from memory.
- `pnpm check` passes before every commit.
- Every exported type name is a `CONTEXT.md` term; a new term adds its row in the same commit.
- Provider pages are loaded unmodified: the shell sets only a view's address, bounds, visibility, and mute flag, and reads keyboard input on stream views. Nothing is injected; provider video is never captured.
- Dividers are held to 0.2–0.8.
- Stage transitions: 280 ms, cubic-bezier `[0.2, 0, 0, 1]`, one constant shared by the CSS and `syncTiles`.

## Where this plan differs from the spec

- **`audioFocus` and `solo` are optional fields, not `Option`s:** `Schema.optional(GameId)`, the way `learnedFor` already is, so the wire stays plain JSON.
- **`solo` names a game, not a slot.** Following the game through swap and promote, and ending when it is cleared or benched, then fall out of the invariant "solo is an on-stage game" with no bookkeeping.
- **When no game has audio, the first non-empty on-stage tile gets it** (the main tile first), not only when the focused game leaves. Otherwise a fresh Stage would be silent until someone pressed audio.
- **`MainThree` uses only `x`** (main tile left, three stacked right). `MainFive` uses `x` and `y`: main top left, two stacked right of it, three along the bottom.
- **The spike adds a fourth question:** does a divider drag that starts in the shell UI keep receiving pointer moves while the cursor is over a provider view? If not, provider views hide for the length of a drag.
- **The hotkey table lives in `packages/api/src/Hotkey.ts`**, because the web UI and the shell both read it.
- **Pixel geometry is computed in the web UI, not measured per tile:** the Stage area's size is observed once; tiles are positioned in pixels from it.

## File map

```
spikes/shell-playback/transitions.cjs, package.json           Task 0 (throwaway)
packages/domain/src/Layout.ts, Layout.test.ts                  Task 1
packages/domain/src/Stage.ts, Stage.test.ts                    Task 2
apps/web/src/hub/Live.test.ts, apps/web/src/stage/StageView.tsx Task 2 (follow the new fields)
packages/api/src/Hotkey.ts, Hotkey.test.ts                     Task 3
packages/api/src/ShellBridge.ts                                Task 3
apps/desktop/src/main/Transition.ts, Transition.test.ts        Task 4
apps/desktop/src/main/TileViews.ts, TileViews.test.ts          Tasks 3, 4, 5
apps/desktop/src/main/main.ts, src/preload/ShellBridge.ts      Task 5
apps/web/components.json, src/design/*, theme/theme.css,
  vite.config.ts, tsconfig.json, knip.json, biome.json         Task 6
apps/web/src/stage/TileRects.ts, TileRects.test.ts             Task 7
apps/web/src/App.tsx, src/frame/*, src/stage/*, slate/SlateView.tsx  Task 8
apps/web/src/OverlayHost.tsx, src/stage/CommandPalette.tsx,
  src/stage/Hotkeys.ts, src/hub/HubClient.ts                   Task 9
CONTEXT.md, docs/*                                              Tasks 1–3, 10
```

---

### Task 0: Spike — transitions, overlay transparency, drags over views

**Files:**
- Create: `spikes/shell-playback/transitions.cjs`
- Modify: `spikes/shell-playback/package.json` (scripts)

Throwaway. It reuses the signed-in `persist:spike` session and the Electron already installed there.

- [ ] **Step 1:** Write `transitions.cjs`: three views on channel addresses from argv, laid out as layout A (three columns) or B (one large left, two stacked right). Keys in the shell window: `A` animate to the other layout over 280 ms on a 16 ms timer with cubic-bezier `[0.2, 0, 0, 1]`; `D` dip and settle (hide, wait 280 ms, set bounds, show); `O` toggle a transparent view over everything with a translucent backdrop and a box; `X` loop `A` every second for a minute. The window's own page has a divider in a gap between views; dragging it logs each `pointermove` to the terminal with the cursor's x.
- [ ] **Step 2:** Add `"start:transitions": "electron transitions.cjs --ozone-platform=x11"` and `"start:transitions:wayland": "electron transitions.cjs"`.
- [ ] **Step 3:** The user runs both and reports: stutter or black frames on `A` and `X`; how `D` looks; whether `O` shows video through the backdrop; whether pointer moves keep logging with the cursor over a view.
- [ ] **Step 4:** Record the results in ADR 0002 as "Amendment: Stage transitions (2026-10-03)" and pick the shell's strategy (Task 4 step 5).

---

### Task 1: `Layout`

**Files:**
- Create: `packages/domain/src/Layout.ts`, `packages/domain/src/Layout.test.ts`
- Modify: `CONTEXT.md` (rows: Layout reworded, Split)

**Interfaces:**
- Produces: `LayoutName` (`"Single" | "Pair" | "Quad" | "MainThree" | "MainFive"`), `Split` (`{ x: number; y: number }`), class `Layout { name; split; slots(): ReadonlyArray<{x;y;width;height}> }` with statics `Layout.slotCount(name)`, `Layout.defaultSplit(name)`, `Layout.next(name)`, `Layout.holds(split)` (both dividers in 0.2–0.8).

- [ ] **Step 1: Write the failing tests** (`Layout.test.ts`):

```ts
import { assert, describe, it } from "@effect/vitest"
import { Layout, LayoutName } from "./Layout.ts"

describe("Layout#slots", () => {
  it("gives Single one slot filling the area", () => {
    assert.deepStrictEqual(layout("Single").slots(), [{ x: 0, y: 0, width: 1, height: 1 }])
  })

  it("splits Pair at x", () => {
    assert.deepStrictEqual(layout("Pair", { x: 0.6, y: 0.5 }).slots(), [
      { x: 0, y: 0, width: 0.6, height: 1 },
      { x: 0.6, y: 0, width: 0.4, height: 1 }
    ])
  })

  it("splits Quad at x and y, main tile top left", () => {
    const [main, right, bottom, corner] = layout("Quad", { x: 0.25, y: 0.75 }).slots()
    assert.deepStrictEqual(main, { x: 0, y: 0, width: 0.25, height: 0.75 })
    assert.deepStrictEqual(right, { x: 0.25, y: 0, width: 0.75, height: 0.75 })
    assert.deepStrictEqual(bottom, { x: 0, y: 0.75, width: 0.25, height: 0.25 })
    assert.deepStrictEqual(corner, { x: 0.25, y: 0.75, width: 0.75, height: 0.25 })
  })

  it("puts MainThree's main tile left of three stacked tiles", () => {
    const slots = layout("MainThree", { x: 0.75, y: 0.5 }).slots()
    assert.deepStrictEqual(slots[0], { x: 0, y: 0, width: 0.75, height: 1 })
    assert.deepStrictEqual(
      slots.slice(1).map((slot) => slot.y),
      [0, 1 / 3, 2 / 3]
    )
    for (const slot of slots.slice(1)) assert.strictEqual(slot.width, 0.25)
  })

  it("puts MainFive's main tile top left, two beside it and three along the bottom", () => {
    const slots = layout("MainFive").slots()
    assert.strictEqual(slots.length, 6)
    assert.deepStrictEqual(slots[0], { x: 0, y: 0, width: 2 / 3, height: 2 / 3 })
    assert.deepStrictEqual(
      slots.slice(3).map((slot) => slot.y),
      [2 / 3, 2 / 3, 2 / 3]
    )
  })

  for (const name of LayoutName.literals)
    for (const split of [Layout.defaultSplit(name), { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }])
      it(`tiles the whole area without overlap: ${name} at ${split.x},${split.y}`, () => {
        const slots = layout(name, split).slots()
        assert.strictEqual(slots.length, Layout.slotCount(name))
        const area = slots.reduce((sum, slot) => sum + slot.width * slot.height, 0)
        assert.closeTo(area, 1, 1e-9)
        for (const [i, a] of slots.entries())
          for (const b of slots.slice(i + 1)) assert.isFalse(overlaps(a, b), `${name} ${i} overlaps`)
      })
})

describe("Layout statics", () => {
  it("cycles through the layouts in order and wraps", () => {
    assert.strictEqual(Layout.next("Single"), "Pair")
    assert.strictEqual(Layout.next("MainFive"), "Single")
  })

  it("holds dividers between 0.2 and 0.8", () => {
    assert.isTrue(Layout.holds({ x: 0.2, y: 0.8 }))
    assert.isFalse(Layout.holds({ x: 0.19, y: 0.5 }))
    assert.isFalse(Layout.holds({ x: 0.5, y: 0.81 }))
  })
})

function layout(name: LayoutName, split = Layout.defaultSplit(name)) {
  return new Layout({ name, split })
}

function overlaps(a: Rect, b: Rect) {
  const e = 1e-9
  return a.x + a.width > b.x + e && b.x + b.width > a.x + e && a.y + a.height > b.y + e && b.y + b.height > a.y + e
}

type Rect = ReturnType<Layout["slots"]>[number]
```

- [ ] **Step 2:** `pnpm vitest run packages/domain/src/Layout.test.ts` — FAIL, module not found.
- [ ] **Step 3: Implement** `Layout.ts`:

```ts
import { Schema } from "effect"

/** The layouts a Stage can take, in the order the next-layout hotkey cycles through them. */
export const LayoutName = Schema.Literals(["Single", "Pair", "Quad", "MainThree", "MainFive"])
export type LayoutName = typeof LayoutName.Type

/** Where a layout's dividers sit, as fractions of the Stage area. A layout uses none, `x`, or both. */
export const Split = Schema.Struct({ x: Schema.Finite, y: Schema.Finite })
export type Split = typeof Split.Type

/** A layout with its dividers: the slots it arranges, main tile first, as fractions of the Stage area. */
export class Layout extends Schema.Class<Layout>("sportal/Layout")({ name: LayoutName, split: Split }) {
  static slotCount(name: LayoutName): number {
    return { Single: 1, Pair: 2, Quad: 4, MainThree: 4, MainFive: 6 }[name]
  }

  static defaultSplit(name: LayoutName): Split {
    switch (name) {
      case "MainThree":
        return { x: 0.75, y: 0.5 }
      case "MainFive":
        return { x: 2 / 3, y: 2 / 3 }
      default:
        return { x: 0.5, y: 0.5 }
    }
  }

  static next(name: LayoutName): LayoutName {
    const names = LayoutName.literals
    return names[(names.indexOf(name) + 1) % names.length] ?? names[0]
  }

  /** Whether both dividers are where a person can still see every tile: 0.2–0.8. */
  static holds(split: Split): boolean {
    return [split.x, split.y].every((at) => at >= 0.2 && at <= 0.8)
  }

  slots(): ReadonlyArray<{ x: number; y: number; width: number; height: number }> {
    const { x, y } = this.split
    switch (this.name) {
      case "Single":
        return [rect(0, 0, 1, 1)]
      case "Pair":
        return [rect(0, 0, x, 1), rect(x, 0, 1, 1)]
      case "Quad":
        return [rect(0, 0, x, y), rect(x, 0, 1, y), rect(0, y, x, 1), rect(x, y, 1, 1)]
      case "MainThree":
        return [rect(0, 0, x, 1), rect(x, 0, 1, 1 / 3), rect(x, 1 / 3, 1, 2 / 3), rect(x, 2 / 3, 1, 1)]
      case "MainFive":
        return [
          rect(0, 0, x, y),
          rect(x, 0, 1, y / 2),
          rect(x, y / 2, 1, y),
          rect(0, y, x / 2, 1),
          rect(x / 2, y, x, 1),
          rect(x, y, 1, 1)
        ]
    }
  }
}

/** The rectangle between two corners. */
function rect(left: number, top: number, right: number, bottom: number) {
  return { x: left, y: top, width: right - left, height: bottom - top }
}
```

(`names[0]` fallback satisfies `noUncheckedIndexedAccess`; if `LayoutName.literals[0]` is typed `"Single"` the `??` is fine.)

- [ ] **Step 4:** Run the test — PASS. Adjust exact-equality expectations only where floating point forces `closeTo`.
- [ ] **Step 5:** `CONTEXT.md`, Viewing table: reword **Layout** to "A named arrangement of tile slots whose dividers can be moved." Add **Split**: "Where a layout's dividers sit, as fractions of the Stage area." | not: ratio, sizes.
- [ ] **Step 6:** `pnpm check`; commit `feat(domain): layouts arrange slots, and a split moves their dividers`.

---

### Task 2: The Stage gets layouts, a bench, solo, swap, promote, and audio by game

**Files:**
- Modify: `packages/domain/src/Stage.ts`, `packages/domain/src/Stage.test.ts`
- Modify: `apps/web/src/hub/Live.test.ts`, `apps/web/src/stage/StageView.tsx` (follow `audioFocus` by game)
- Modify: `CONTEXT.md` (Bench, Solo, Swap; Audio focus reworded)

**Interfaces:**
- Consumes: `Layout`, `LayoutName`, `Split` (Task 1).
- Produces:
  - `Stage` fields `tiles`, `layout: LayoutName`, `splits: { [K in LayoutName]: Split }`, `audioFocus?: GameId`, `solo?: GameId`.
  - Methods: `stage.currentLayout(): Layout`, `stage.onStage(): ReadonlyArray<Tile>` (the first `slotCount` tiles), `stage.slotOf(game): number | undefined` (on-stage index), `apply`, `refresh`.
  - `StageCommand` adds `Swap { a, b }`, `Promote { tile }`, `SetLayout { layout }`, `SetSplit { split }`, `Solo { tile }`, `Unsolo {}`.
  - `StageRejection.reason`: `"no-such-tile" | "empty-tile" | "offstage-tile" | "split-out-of-range"`.

- [ ] **Step 1: Update tests.** In `Stage.test.ts` replace the three audio tests and the `refresh` "leaves empty tiles empty and audio focus" test, and add a `describe` per new command:

```ts
// replaces "moves audio focus" and "leaves audio focus where it was on assign and clear"
it("gives audio to the first game on stage when no game has it", () => {
  const stage = assign(Stage.initial, 2, bama, onFox)
  assert.strictEqual(stage.audioFocus, bama)
})

it("moves audio focus to a tile's game, and keeps it there on assign elsewhere", () => {
  const two = assign(assign(Stage.initial, 0, bama, onFox), 1, irish, onFox)
  const focused = run(two, { _tag: "FocusAudio", tile: 1 })
  assert.strictEqual(focused.audioFocus, irish)
  assert.strictEqual(assign(focused, 2, usc, onFox).audioFocus, irish)
})

it("moves audio to the main tile's game when the focused game is cleared", () => {
  const two = run(assign(assign(Stage.initial, 0, bama, onFox), 1, irish, onFox), { _tag: "FocusAudio", tile: 1 })
  assert.strictEqual(run(two, { _tag: "Clear", tile: 1 }).audioFocus, bama)
})

it("rejects audio for an empty tile", () => {
  assert.strictEqual(rejection(Stage.initial, { _tag: "FocusAudio", tile: 3 }), "empty-tile")
})

it("rejects a tile that does not exist, saying why", () => {
  assert.strictEqual(rejection(Stage.initial, { _tag: "FocusAudio", tile: 4 }), "no-such-tile")
})
```

```ts
describe("Stage layouts and the bench", () => {
  it("starts as an empty Quad with default splits", () => {
    assert.strictEqual(Stage.initial.layout, "Quad")
    assert.strictEqual(Stage.initial.tiles.length, 4)
    assert.deepStrictEqual(Stage.initial.splits.MainFive, Layout.defaultSplit("MainFive"))
  })

  it("benches the tiles that no longer fit, and brings them back in order", () => {
    const full = [bama, irish, usc, ohio].reduce((stage, game, tile) => assign(stage, tile, game, onFox), Stage.initial)
    const pair = run(full, { _tag: "SetLayout", layout: "Pair" })
    assert.deepStrictEqual(pair.onStage().map(gameOf), [bama, irish])
    assert.deepStrictEqual(pair.tiles.map(gameOf), [bama, irish, usc, ohio])
    assert.deepStrictEqual(run(pair, { _tag: "SetLayout", layout: "Quad" }).tiles, full.tiles)
  })

  it("pads a growing layout with empty tiles and trims empties off the end of the bench", () => {
    const one = assign(Stage.initial, 0, bama, onFox)
    const five = run(one, { _tag: "SetLayout", layout: "MainFive" })
    assert.strictEqual(five.tiles.length, 6)
    assert.strictEqual(run(five, { _tag: "SetLayout", layout: "Single" }).tiles.length, 1)
  })

  it("moves audio off a benched game to the main tile's game", () => {
    const two = run(assign(assign(Stage.initial, 0, bama, onFox), 1, irish, onFox), { _tag: "FocusAudio", tile: 1 })
    assert.strictEqual(run(two, { _tag: "SetLayout", layout: "Single" }).audioFocus, bama)
  })

  it("keeps a game in one tile across stage and bench", () => {
    const benched = run(assign(assign(Stage.initial, 0, bama, onFox), 1, irish, onFox), { _tag: "SetLayout", layout: "Single" })
    const moved = assign(benched, 0, irish, onFox)
    assert.deepStrictEqual(moved.tiles.map(gameOf), [irish, undefined].slice(0, moved.tiles.length))
  })

  it("rejects audio and solo for a benched tile", () => {
    const benched = run(assign(assign(Stage.initial, 0, bama, onFox), 1, irish, onFox), { _tag: "SetLayout", layout: "Single" })
    assert.strictEqual(rejection(benched, { _tag: "FocusAudio", tile: 1 }), "offstage-tile")
    assert.strictEqual(rejection(benched, { _tag: "Solo", tile: 1 }), "offstage-tile")
  })

  it("sets the current layout's split and remembers each layout's own", () => {
    const moved = run(Stage.initial, { _tag: "SetSplit", split: { x: 0.3, y: 0.7 } })
    assert.deepStrictEqual(moved.splits.Quad, { x: 0.3, y: 0.7 })
    assert.deepStrictEqual(moved.splits.Pair, Layout.defaultSplit("Pair"))
    assert.deepStrictEqual(moved.currentLayout().split, { x: 0.3, y: 0.7 })
  })

  it("rejects a split outside 0.2–0.8", () => {
    assert.strictEqual(rejection(Stage.initial, { _tag: "SetSplit", split: { x: 0.1, y: 0.5 } }), "split-out-of-range")
  })
})

describe("Stage swap and promote", () => {
  it("swaps two tiles, on stage or benched", () => {
    const three = [bama, irish, usc].reduce((stage, game, tile) => assign(stage, tile, game, onFox), Stage.initial)
    assert.deepStrictEqual(run(three, { _tag: "Swap", a: 0, b: 2 }).tiles.map(gameOf), [usc, irish, bama, undefined])
    const benched = run(three, { _tag: "SetLayout", layout: "Pair" })
    assert.deepStrictEqual(run(benched, { _tag: "Swap", a: 1, b: 2 }).onStage().map(gameOf), [bama, usc])
  })

  it("keeps audio with its game through a swap", () => {
    const two = assign(assign(Stage.initial, 0, bama, onFox), 1, irish, onFox)
    assert.strictEqual(run(two, { _tag: "Swap", a: 0, b: 1 }).audioFocus, bama)
  })

  it("promotes a tile into the main tile and gives it audio", () => {
    const two = assign(assign(Stage.initial, 0, bama, onFox), 3, irish, onFox)
    const promoted = run(two, { _tag: "Promote", tile: 3 })
    assert.deepStrictEqual(promoted.tiles.map(gameOf), [irish, undefined, undefined, bama])
    assert.strictEqual(promoted.audioFocus, irish)
  })

  it("promotes a benched game", () => {
    const benched = run(assign(assign(Stage.initial, 0, bama, onFox), 1, irish, onFox), { _tag: "SetLayout", layout: "Single" })
    assert.deepStrictEqual(run(benched, { _tag: "Promote", tile: 1 }).onStage().map(gameOf), [irish])
  })

  it("rejects promoting an empty tile", () => {
    assert.strictEqual(rejection(Stage.initial, { _tag: "Promote", tile: 1 }), "empty-tile")
  })
})

describe("Stage solo", () => {
  const two = assign(assign(Stage.initial, 0, bama, onFox), 1, irish, onFox)

  it("solos a tile's game and gives it audio", () => {
    const solo = run(two, { _tag: "Solo", tile: 1 })
    assert.strictEqual(solo.solo, irish)
    assert.strictEqual(solo.audioFocus, irish)
  })

  it("follows its game through a swap, and ends when the game is cleared or benched", () => {
    const solo = run(two, { _tag: "Solo", tile: 1 })
    assert.strictEqual(run(solo, { _tag: "Swap", a: 0, b: 1 }).solo, irish)
    assert.isUndefined(run(solo, { _tag: "Clear", tile: 1 }).solo)
    assert.isUndefined(run(solo, { _tag: "SetLayout", layout: "Single" }).solo)
  })

  it("ends on Unsolo", () => {
    assert.isUndefined(run(run(two, { _tag: "Solo", tile: 0 }), { _tag: "Unsolo" }).solo)
  })

  it("rejects soloing an empty tile", () => {
    assert.strictEqual(rejection(two, { _tag: "Solo", tile: 2 }), "empty-tile")
  })
})
```

In `describe("Stage#refresh")`, replace the empties/audio test and add the bench:

```ts
it("leaves empty tiles empty and audio focus where it was", () => {
  const two = run(assign(assign(Stage.initial, 0, bama, foxUnlearned), 1, irish, onFox), { _tag: "FocusAudio", tile: 1 })
  const refreshed = two.refresh(some(onFox))
  assert.deepStrictEqual(refreshed.tiles.map((tile) => tile._tag), ["StreamTile", "StreamTile", "Empty", "Empty"])
  assert.strictEqual(refreshed.audioFocus, irish)
})

it("re-resolves benched tiles too", () => {
  const benched = run(assign(assign(Stage.initial, 0, bama, onFox), 1, irish, foxUnlearned), { _tag: "SetLayout", layout: "Single" })
  assert.strictEqual(benched.refresh(some(onFox)).tiles[1]?._tag, "StreamTile")
})
```

Helpers at the bottom of the test file (beside the existing `assign` and `some`):

```ts
const usc = GameId.make("401856800")
const ohio = GameId.make("401858473")

function run(stage: Stage, command: StageCommand) {
  return Result.getOrThrow(stage.apply(command, nowhere))
}

function rejection(stage: Stage, command: StageCommand) {
  const result = stage.apply(command, nowhere)
  return Result.isFailure(result) ? result.failure.reason : undefined
}

function gameOf(tile: Tile) {
  return tile._tag === "Empty" ? undefined : tile.game
}
```

(`usc` and `ohio` go with the other constants at the top; `Layout`, `StageCommand`, `Tile` are imported.)

- [ ] **Step 2:** Run `pnpm vitest run packages/domain/src/Stage.test.ts` — FAIL (no `layout`, unknown commands).
- [ ] **Step 3: Implement.** In `Stage.ts`:

```ts
export class Stage extends Schema.Class<Stage>("sportal/Stage")({
  /** The first `Layout.slotCount(layout)` tiles are on stage, main tile first; the rest are the bench. */
  tiles: Schema.Array(Tile),
  layout: LayoutName,
  /** Each layout's own split, kept while another layout is shown. */
  splits: Schema.Struct({ Single: Split, Pair: Split, Quad: Split, MainThree: Split, MainFive: Split }),
  /** The game whose sound is on. Always an on-stage game, or none when the stage is empty. */
  audioFocus: Schema.optional(GameId),
  /** The game filling the Stage. Always an on-stage game. */
  solo: Schema.optional(GameId)
}) {
  /** An empty Quad, every layout at its default split. */
  static readonly initial = settle({
    tiles: [],
    layout: "Quad",
    splits: {
      Single: Layout.defaultSplit("Single"),
      Pair: Layout.defaultSplit("Pair"),
      Quad: Layout.defaultSplit("Quad"),
      MainThree: Layout.defaultSplit("MainThree"),
      MainFive: Layout.defaultSplit("MainFive")
    }
  })

  currentLayout(): Layout {
    return new Layout({ name: this.layout, split: this.splits[this.layout] })
  }

  /** The tiles in the layout's slots, main tile first. */
  onStage(): ReadonlyArray<Tile> {
    return this.tiles.slice(0, Layout.slotCount(this.layout))
  }

  /** The slot a game is in, if it is on stage. */
  slotOf(game: GameId): number | undefined {
    const slot = this.onStage().findIndex((tile) => tile._tag !== "Empty" && tile.game === game)
    return slot === -1 ? undefined : slot
  }

  apply(command, availabilityOf): Result.Result<Stage, StageRejection> {
    switch (command._tag) {
      case "SetLayout":
        return Result.succeed(settle({ ...this.fields(), layout: command.layout }))
      case "SetSplit":
        return Layout.holds(command.split)
          ? Result.succeed(settle({ ...this.fields(), splits: { ...this.splits, [this.layout]: command.split } }))
          : reject("split-out-of-range")
      case "Unsolo":
        return Result.succeed(settle({ ...this.fields(), solo: undefined }))
      case "Swap":
        if (!this.has(command.a) || !this.has(command.b)) return reject("no-such-tile")
        return Result.succeed(settle({ ...this.fields(), tiles: swapped(this.tiles, command.a, command.b) }))
    }
    // Every other command names one tile.
    const tile = this.tiles[command.tile]
    if (tile === undefined) return reject("no-such-tile")
    switch (command._tag) {
      case "Assign": { ...existing body, then settle({ ...this.fields(), tiles }) }
      case "Clear":
        return Result.succeed(settle({ ...this.fields(), tiles: this.tiles.map((t, i) => (i === command.tile ? empty : t)) }))
      case "Promote":
        if (tile._tag === "Empty") return reject("empty-tile")
        return Result.succeed(settle({ ...this.fields(), tiles: swapped(this.tiles, 0, command.tile), audioFocus: tile.game }))
      case "FocusAudio":
      case "Solo": {
        if (command.tile >= Layout.slotCount(this.layout)) return reject("offstage-tile")
        if (tile._tag === "Empty") return reject("empty-tile")
        return Result.succeed(settle({
          ...this.fields(),
          audioFocus: tile.game,
          ...(command._tag === "Solo" ? { solo: tile.game } : {})
        }))
      }
    }
  }

  refresh(...) { same body, but `return settle({ ...this.fields(), tiles: ... })` }

  private has(index: number) { return index >= 0 && index < this.tiles.length }
  private fields() { return { tiles: this.tiles, layout: this.layout, splits: this.splits, audioFocus: this.audioFocus, solo: this.solo } }
}
```

New commands and rejection (types inferred from the schemas):

```ts
export const StageCommand = Schema.Union([
  Schema.TaggedStruct("Assign", { tile: Schema.Int, game: GameId }),
  Schema.TaggedStruct("Clear", { tile: Schema.Int }),
  Schema.TaggedStruct("FocusAudio", { tile: Schema.Int }),
  Schema.TaggedStruct("Swap", { a: Schema.Int, b: Schema.Int }),
  Schema.TaggedStruct("Promote", { tile: Schema.Int }),
  Schema.TaggedStruct("SetLayout", { layout: LayoutName }),
  Schema.TaggedStruct("SetSplit", { split: Split }),
  Schema.TaggedStruct("Solo", { tile: Schema.Int }),
  Schema.TaggedStruct("Unsolo", {})
])

export class StageRejection extends Schema.TaggedError<StageRejection>()(
  "StageRejection",
  { reason: Schema.Literals(["no-such-tile", "empty-tile", "offstage-tile", "split-out-of-range"]) },
  { httpApiStatus: 422 }
) {}
```

Private helpers below, in order of first use:

```ts
/**
 * Builds a Stage that keeps the invariants: the layout's slots exist, the bench ends in a game, audio is on
 * an on-stage game (the focused one if it is still on stage, else the first on stage), and solo is on stage.
 */
function settle(fields: {
  tiles: ReadonlyArray<Tile>
  layout: LayoutName
  splits: Stage["splits"]
  audioFocus?: GameId | undefined
  solo?: GameId | undefined
}): Stage {
  const slots = Layout.slotCount(fields.layout)
  const tiles = [...fields.tiles]
  while (tiles.length < slots) tiles.push(empty)
  while (tiles.length > slots && tiles.at(-1)?._tag === "Empty") tiles.pop()
  const onStage = tiles.slice(0, slots).flatMap((tile) => (tile._tag === "Empty" ? [] : [tile.game]))
  const audioFocus = onStage.find((game) => game === fields.audioFocus) ?? onStage[0]
  const solo = onStage.find((game) => game === fields.solo)
  return new Stage({
    tiles,
    layout: fields.layout,
    splits: fields.splits,
    ...(audioFocus === undefined ? {} : { audioFocus }),
    ...(solo === undefined ? {} : { solo })
  })
}

function reject(reason: StageRejection["reason"]) {
  return Result.fail(new StageRejection({ reason }))
}

function swapped(tiles: ReadonlyArray<Tile>, a: number, b: number): ReadonlyArray<Tile> {
  return tiles.map((tile, index) => (index === a ? (tiles[b] ?? tile) : index === b ? (tiles[a] ?? tile) : tile))
}
```

`Stage.initial` is defined with a static initializer that calls `settle`, which is hoisted; `settle` constructs `Stage`, which is already defined when the static runs. `empty` stays the module constant it is today, but moves above the class because `Stage.initial` reads it while the class is evaluated (AGENTS.md: a value a class reads when it is defined goes above it).

- [ ] **Step 4:** Run the Stage tests — PASS. Then `pnpm vitest run apps/hub` — the StageSessions tests still pass (tile 9 is still `no-such-tile`).
- [ ] **Step 5: Follow the fields in the web UI.** `apps/web/src/hub/Live.test.ts`: build the stage as `Result.getOrThrow(Stage.initial.apply({ _tag: "SetLayout", layout: "Pair" }, ...))` or `new Stage({ ...Stage.initial, layout: "Pair" })` and assert `next.stage.layout === "Pair"`. In `StageView.tsx`, `hasAudio` and `muted` compare `tile.game` with `stage.audioFocus` (empty tiles have no audio).
- [ ] **Step 6:** `CONTEXT.md` Viewing: **Audio focus** → "The single game whose sound is on; it follows the game when tiles move." Add **Bench**: "The tiles a layout has no slot for, kept in order and not played." | not: queue, reserve. **Solo**: "One on-stage game filling the whole Stage." | not: fullscreen, maximize. **Swap**: "Exchange two tiles, on stage or benched." | not: move. Update **Stage command**'s meaning: "An instruction to change a Stage: assign, clear, swap, promote, solo, change layout or split, or focus audio."
- [ ] **Step 7:** `pnpm check`; commit `feat(domain): the Stage takes layouts, a bench, solo, swap and promote; audio follows its game`.

---

### Task 3: The Shell bridge keys tiles by game; hotkeys are one table

**Files:**
- Create: `packages/api/src/Hotkey.ts`, `packages/api/src/Hotkey.test.ts`
- Modify: `packages/api/src/ShellBridge.ts`, `apps/desktop/src/main/TileViews.ts`, `TileViews.test.ts`, `apps/web/src/stage/StageView.tsx`
- Modify: `CONTEXT.md` (Hotkey, Stage transition, Full screen; Tile placement and Channel pick reworded)

**Interfaces:**
- Produces:
  - `Hotkey` (a `Schema.Union` of `FocusAudio { slot }`, `Promote { slot }`, `ToggleSolo`, `Unsolo`, `FullScreen`, `NextLayout`, `CommandPalette`) and `Hotkey.of(key: { code: string; shift: boolean; control: boolean; meta: boolean }): Hotkey | undefined`. `slot` is 0-based.
  - `TilePlacement { game: GameId; url; role; bounds; muted }`, `ChannelPick { game: GameId; url }`, `StageTransition { durationMs: number; easing: readonly [number, number, number, number] }`.
  - `ShellBridge` adds `syncTiles(placements, transition?)`, `setHidden(games)`, `setFullScreen(on)`, `onFullScreenChanged(listener)`, `onHotkey(listener)`.
  - `TileViews` keyed by `GameId`; `channelPicks: Stream<ChannelPick>` with `game`.

- [ ] **Step 1: Hotkey tests** (`Hotkey.test.ts`):

```ts
import { assert, describe, it } from "@effect/vitest"
import { Hotkey } from "./Hotkey.ts"

const key = (code: string, modifiers: Partial<{ shift: boolean; control: boolean; meta: boolean }> = {}) =>
  Hotkey.of({ code, shift: false, control: false, meta: false, ...modifiers })

describe("Hotkey.of", () => {
  it("reads digits as audio focus and shifted digits as promote, 0-based", () => {
    assert.deepStrictEqual(key("Digit1"), { _tag: "FocusAudio", slot: 0 })
    assert.deepStrictEqual(key("Digit9", { shift: true }), { _tag: "Promote", slot: 8 })
  })

  it("reads the letter and function keys", () => {
    assert.deepStrictEqual(key("KeyF"), { _tag: "ToggleSolo" })
    assert.deepStrictEqual(key("Escape"), { _tag: "Unsolo" })
    assert.deepStrictEqual(key("F11"), { _tag: "FullScreen" })
    assert.deepStrictEqual(key("KeyL"), { _tag: "NextLayout" })
    assert.deepStrictEqual(key("KeyK", { control: true }), { _tag: "CommandPalette" })
    assert.deepStrictEqual(key("KeyK", { meta: true }), { _tag: "CommandPalette" })
  })

  it("leaves every other key, and Sportal's keys with Ctrl or Cmd, to the page", () => {
    assert.isUndefined(key("KeyA"))
    assert.isUndefined(key("Digit0"))
    assert.isUndefined(key("Digit1", { control: true }))
    assert.isUndefined(key("KeyF", { meta: true }))
  })
})
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** `Hotkey.ts`:

```ts
import { Schema } from "effect"

/** A key Sportal acts on, wherever it was pressed: in the web UI, or in a stream view that had focus. */
export const Hotkey = Object.assign(
  Schema.Union([
    Schema.TaggedStruct("FocusAudio", { slot: Schema.Int }),
    Schema.TaggedStruct("Promote", { slot: Schema.Int }),
    Schema.TaggedStruct("ToggleSolo", {}),
    Schema.TaggedStruct("Unsolo", {}),
    Schema.TaggedStruct("FullScreen", {}),
    Schema.TaggedStruct("NextLayout", {}),
    Schema.TaggedStruct("CommandPalette", {})
  ]),
  {
    /** The hotkey a key press means, by its physical `code`; none for a key the page should have. */
    of(key: { code: string; shift: boolean; control: boolean; meta: boolean }): Hotkey | undefined {
      if (key.control || key.meta) return key.code === "KeyK" ? { _tag: "CommandPalette" } : undefined
      const digit = /^Digit([1-9])$/.exec(key.code)?.[1]
      if (digit !== undefined) return { _tag: key.shift ? "Promote" : "FocusAudio", slot: Number(digit) - 1 }
      switch (key.code) {
        case "KeyF":
          return { _tag: "ToggleSolo" }
        case "Escape":
          return { _tag: "Unsolo" }
        case "F11":
          return { _tag: "FullScreen" }
        case "KeyL":
          return { _tag: "NextLayout" }
        default:
          return undefined
      }
    }
  }
)
export type Hotkey = typeof Hotkey.Type
```

(If `Object.assign` over a schema loses its type, make `of` a separate export named `hotkeyOf`; check how the codebase attaches statics to a `Schema.Union` first: `ChannelAvailability` uses `Data.taggedEnum`, which carries constructors. Prefer whichever reads as `Hotkey.of`.)

- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5: Shell bridge.** In `ShellBridge.ts`: `TilePlacement` replaces `tile: Schema.Int` with `game: GameId`; `ChannelPick` likewise. Add:

```ts
/** How the shell moves provider views to new bounds: over `durationMs`, along a CSS cubic-bezier. */
export const StageTransition = Schema.Struct({
  durationMs: Schema.Int,
  easing: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite])
})
export type StageTransition = typeof StageTransition.Type
```

and to the interface:

```ts
  /** Replaces the full set of provider views: views not listed are closed. With a transition, views move there over its duration. */
  syncTiles(placements: ReadonlyArray<TilePlacement>, transition?: StageTransition): void
  /** Hides exactly these games' views, without unloading them or muting them, and shows the rest. */
  setHidden(games: ReadonlyArray<GameId>): void
  /** Puts the shell window in or out of full screen. */
  setFullScreen(on: boolean): void
  /** Calls `listener` whenever the window enters or leaves full screen, however it happened. */
  onFullScreenChanged(listener: (on: boolean) => void): () => void
  /** Calls `listener` for each Sportal hotkey pressed while a stream view had keyboard focus. */
  onHotkey(listener: (hotkey: Hotkey) => void): () => void
```

- [ ] **Step 6: TileViews by game.** In `TileViews.test.ts`, change the fixtures to `game: GameId.make("one")` (and `"two"` where a test used `tile: 1`), and pick expectations to `{ game, url }`. Add:

```ts
it.effect("moves a game's view without reloading it when the game changes slot", () =>
  Effect.gen(function* () {
    const { tiles } = yield* attached()
    yield* tiles.sync([placement, { ...placement, game: two, url: "https://tv.youtube.com/watch/two" }])
    const moved = { x: 700, y: 20, width: 640, height: 360 }
    yield* tiles.sync([{ ...placement, bounds: moved }, { ...placement, game: two, url: "https://tv.youtube.com/watch/two" }])
    expect(created).toHaveLength(2)
    expect(created[0]?.webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(created[0]?.setBounds).toHaveBeenLastCalledWith(moved)
  }).pipe(Effect.scoped)
)
```

In `TileViews.ts`: `views` becomes `Map<GameId, Entry>`, `create(game)`, `placement.game` everywhere `placement.tile` was, `publishUnsafe(picks, { game, url })`.
- [ ] **Step 7: Web follows.** `StageView.tsx` `placements` emit `game: tile.game`; `onChannelPicked` finds the tile with `props.stage.tiles.findIndex((t) => t._tag === "PickingChannel" && t.game === pick.game)`.
- [ ] **Step 8:** The preload gets stub-free real members in Task 5; for this commit, add to `apps/desktop/src/preload/ShellBridge.ts`: `syncTiles: (placements, transition) => ipcRenderer.send("sportal:sync-tiles", placements, transition)` and the four new members sending `sportal:set-hidden`, `sportal:set-full-screen`, and listening on `sportal:full-screen-changed`, `sportal:hotkey`, in the shape of `onChannelPicked`. Main does not handle them yet.
- [ ] **Step 9:** `CONTEXT.md` Viewing and Devices: **Tile placement** → "Where a game's stream or picking tile sits in a Display's window, what it loads, and whether it is a stream or a guide, as told to the shell." **Channel pick** → "...landed on a channel's address, for a game." Add **Hotkey**: "A key Sportal acts on, wherever it was pressed." | not: shortcut, keybind. **Stage transition**: "How the Stage moves tiles to new places: one duration and easing, shared by the web UI and the shell." | not: animation. **Full screen**: "The Display's window filling its monitor with only the Stage; local to the Display, not a Stage state." | not: solo.
- [ ] **Step 10:** `pnpm check`; commit `feat(api,desktop): provider views follow their game; one hotkey table`.

---

### Task 4: The shell moves views along a Stage transition, and hides views on request

**Files:**
- Create: `apps/desktop/src/main/Transition.ts`, `apps/desktop/src/main/Transition.test.ts`
- Modify: `apps/desktop/src/main/TileViews.ts`, `TileViews.test.ts`

**Interfaces:**
- Consumes: `StageTransition`, `TilePlacement` (Task 3).
- Produces: `Transition.progress(easing, t: number): number` (eased 0–1), `Transition.between(from, to, eased)` (bounds, rounded). `TileViews.sync(placements, transition?)`, `TileViews.hide(games)`.

- [ ] **Step 1: Transition tests:**

```ts
import { assert, describe, it } from "@effect/vitest"
import { Transition } from "./Transition.ts"

const standard = [0.2, 0, 0, 1] as const

describe("Transition.progress", () => {
  it("starts at 0 and ends at 1", () => {
    assert.strictEqual(Transition.progress(standard, 0), 0)
    assert.strictEqual(Transition.progress(standard, 1), 1)
  })

  it("follows the CSS curve: linear is the identity, ease-out runs ahead of it", () => {
    assert.closeTo(Transition.progress([0, 0, 1, 1], 0.3), 0.3, 1e-6)
    assert.isAbove(Transition.progress(standard, 0.5), 0.5)
  })

  it("clamps outside 0–1", () => {
    assert.strictEqual(Transition.progress(standard, 1.5), 1)
  })
})

describe("Transition.between", () => {
  it("lands exactly on the target", () => {
    const to = { x: 641, y: 33, width: 637, height: 359 }
    assert.deepStrictEqual(Transition.between({ x: 0, y: 0, width: 10, height: 10 }, to, 1), to)
  })

  it("is whole pixels on the way", () => {
    const halfway = Transition.between({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 15, height: 15 }, 0.5)
    assert.deepStrictEqual(halfway, { x: 3, y: 3, width: 13, height: 13 })
  })
})
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** `Transition.ts` (a cubic-bezier solved for x by Newton's method, then bisection):

```ts
import type { StageTransition, TilePlacement } from "@sportal/api/ShellBridge"

type Bounds = TilePlacement["bounds"]

/** The arithmetic of a Stage transition: how far along the curve a moment is, and where a view is then. */
export const Transition = {
  /** The eased progress at `t` (0–1 of the duration), as CSS computes `cubic-bezier(x1, y1, x2, y2)`. */
  progress(easing: StageTransition["easing"], t: number): number {
    if (t <= 0) return 0
    if (t >= 1) return 1
    const [x1, y1, x2, y2] = easing
    return bezier(y1, y2, solveX(x1, x2, t))
  },

  /** The bounds `eased` of the way from `from` to `to`, in whole pixels; exactly `to` at 1. */
  between(from: Bounds, to: Bounds, eased: number): Bounds {
    if (eased >= 1) return to
    const at = (a: number, b: number) => Math.round(a + (b - a) * eased)
    return { x: at(from.x, to.x), y: at(from.y, to.y), width: at(from.width, to.width), height: at(from.height, to.height) }
  }
}

/** One coordinate of a cubic bezier from 0 to 1 with control points `p1` and `p2`, at parameter `s`. */
function bezier(p1: number, p2: number, s: number) {
  const inverse = 1 - s
  return 3 * inverse * inverse * s * p1 + 3 * inverse * s * s * p2 + s * s * s
}

/** The parameter at which the curve's x is `x`. */
function solveX(x1: number, x2: number, x: number) {
  let s = x
  for (let step = 0; step < 8; step++) {
    const error = bezier(x1, x2, s) - x
    if (Math.abs(error) < 1e-7) return s
    const slope = 3 * (1 - s) * (1 - s) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2)
    if (Math.abs(slope) < 1e-6) break
    s -= error / slope
  }
  let low = 0
  let high = 1
  s = x
  while (high - low > 1e-7) {
    if (bezier(x1, x2, s) < x) low = s
    else high = s
    s = (low + high) / 2
  }
  return s
}
```

(`Transition` is a namespace object rather than a class because it holds no state; it is a pure module owned by its concept. If the reviewer prefers, export `progress` and `between` as functions imported as `* as Transition`.)

- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5: TileViews animation tests** (use `TestClock`; the fake view records `setBounds` and gains `setVisible: vi.fn()`):

```ts
describe("TileViews transitions", () => {
  const transition = { durationMs: 160, easing: [0, 0, 1, 1] as const }
  const target = { x: 110, y: 20, width: 640, height: 360 }

  it.effect("moves a view to its new bounds over the duration, landing exactly", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([{ ...placement, bounds: target }], transition)
      yield* TestClock.adjust("80 millis")
      expect(created[0]?.setBounds).toHaveBeenLastCalledWith({ x: 60, y: 20, width: 640, height: 360 })
      yield* TestClock.adjust("100 millis")
      expect(created[0]?.setBounds).toHaveBeenLastCalledWith(target)
    }).pipe(Effect.scoped)
  )

  it.effect("starts a new transition from where the views are", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([{ ...placement, bounds: target }], transition)
      yield* TestClock.adjust("80 millis")
      yield* tiles.sync([placement], transition)
      yield* TestClock.adjust("16 millis")
      const [last] = created[0]?.setBounds.mock.lastCall ?? []
      expect(last.x).toBeGreaterThan(50)
      expect(last.x).toBeLessThan(60)
    }).pipe(Effect.scoped)
  )

  it.effect("shows a new view at its target once the transition ends", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([placement, { ...placement, game: two, bounds: target }], transition)
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(false)
      yield* TestClock.adjust("200 millis")
      expect(created[1]?.setBounds).toHaveBeenLastCalledWith(target)
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(true)
    }).pipe(Effect.scoped)
  )
})

describe("TileViews.hide", () => {
  it.effect("hides exactly the named games, and keeps them hidden through syncs", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      const other = { ...placement, game: two, url: "https://tv.youtube.com/watch/two" }
      yield* tiles.sync([placement, other])
      yield* tiles.hide([two])
      expect(created[0]?.setVisible).toHaveBeenLastCalledWith(true)
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(false)
      yield* tiles.sync([placement, other])
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(false)
      yield* tiles.hide([])
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(true)
    }).pipe(Effect.scoped)
  )
})
```

- [ ] **Step 6:** Run — FAIL.
- [ ] **Step 7: Implement in `TileViews`:**
  - `Entry` gains `bounds: Bounds` (where the view is now) and the service gains `hide(games: ReadonlyArray<GameId>): Effect<void>`.
  - A `hidden: ReadonlySet<GameId>` and a set of `arriving` games (created in a transition, not yet shown) decide visibility: `entry.view.setVisible(!hidden.has(game) && !arriving.has(game))` after every sync, hide, and animation end.
  - `sync(placements, transition?)` does what it does today for create, remove, load, role, and mute, then:
    - with no transition: interrupts any running animation (`FiberHandle.clear`), sets each view's bounds to its target.
    - with a transition: records `from = entry.bounds` for each existing view; new views get their target bounds and join `arriving`; runs `animate` in a `FiberHandle` (`FiberHandle.run` interrupts the previous animation, so a new sync starts from the current `entry.bounds`).
  - `animate`: reads `Clock.currentTimeMillis` at start; every 16 ms (`Effect.sleep("16 millis")` in a loop) computes `t = elapsed / durationMs`, `eased = Transition.progress(easing, t)`, and sets each still-present view's bounds to `Transition.between(from, to, eased)`, updating `entry.bounds`; after `t >= 1` sets exact targets, clears `arriving`, and re-applies visibility. A view removed mid-animation is skipped because the step reads `views.get(game) === entry`.
  - The **dip and settle** strategy (if Task 0 chose it): `animate` instead hides every moving view, sleeps `durationMs`, sets targets, and re-applies visibility. Keep exactly one strategy in code; the other is not written.
- [ ] **Step 8:** Run — PASS, including every older TileViews test.
- [ ] **Step 9:** `pnpm check`; commit `feat(desktop): provider views move along a Stage transition and hide on request`.

---

### Task 5: Full screen, hotkeys from stream views, and the IPC

**Files:**
- Modify: `apps/desktop/src/main/TileViews.ts`, `TileViews.test.ts`, `apps/desktop/src/main/main.ts`, `apps/desktop/src/preload/ShellBridge.ts`

**Interfaces:**
- Consumes: `Hotkey.of` (Task 3), `TileViews.sync/hide` (Task 4).
- Produces: `TileViews.hotkeys: Stream<Hotkey>`; IPC channels `sportal:sync-tiles` (placements, transition), `sportal:set-hidden`, `sportal:set-full-screen`, `sportal:full-screen-changed`, `sportal:hotkey`.

- [ ] **Step 1: Test** in `TileViews.test.ts`:

```ts
describe("TileViews.hotkeys", () => {
  it.effect("forwards Sportal's keys from stream views, keeps them from the page, and leaves guide views alone", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement, { ...placement, game: two, role: "guide", url: "https://tv.youtube.com/live" }])
      const hotkeys = yield* collect(tiles.hotkeys, 1)
      const press = (index: number, code: string) => {
        const event = { preventDefault: vi.fn() }
        created[index]?.webContents.emit("before-input-event", event, { type: "keyDown", code, shift: false, control: false, meta: false })
        return event
      }
      expect(press(1, "Digit2").preventDefault).not.toHaveBeenCalled()
      expect(press(0, "KeyA").preventDefault).not.toHaveBeenCalled()
      expect(press(0, "Digit2").preventDefault).toHaveBeenCalled()
      expect(yield* Fiber.join(hotkeys)).toEqual([{ _tag: "FocusAudio", slot: 1 }])
    }).pipe(Effect.scoped)
  )
})
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.** In `create`, add a `before-input-event` listener: only when `views.get(game) === entry && entry.role === "stream" && input.type === "keyDown"`, compute `Hotkey.of(input)`; if defined, `event.preventDefault()` and publish to a `hotkeys` PubSub. Expose `hotkeys: Stream.fromPubSub(...)`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5: main.ts.**
  - `sportal:sync-tiles` decodes `(placements, transition)`: `Schema.decodeUnknownOption(Schema.Array(TilePlacement))` and `Schema.decodeUnknownOption(Schema.UndefinedOr(StageTransition))`; the sliding queue holds `{ placements, transition }`.
  - `sportal:set-hidden` decodes `Schema.Array(GameId)` and runs `tiles.hide`.
  - `sportal:set-full-screen` decodes a boolean and calls `window.setFullScreen(on)`.
  - `window.on("enter-full-screen")` / `"leave-full-screen"` send `sportal:full-screen-changed` with `true`/`false` (registered with `acquireRelease`, like the IPC listeners).
  - `tiles.hotkeys` forwards each to `sportal:hotkey`, like `channelPicks`.
  - Every handler checks `event.sender === window.webContents`, as the existing ones do.
- [ ] **Step 6: Preload** forwards the two new listeners the way `onChannelPicked` does (never exposing the IPC event).
- [ ] **Step 7:** `pnpm check`; `pnpm --filter @sportal/desktop build`; commit `feat(desktop): full screen and stream-view hotkeys over the Shell bridge`.

---

### Task 6: shadcn in `src/design/`, and the theme

**Files:**
- Create: `apps/web/components.json`, `apps/web/src/design/ClassName.ts`, `apps/web/src/design/*.tsx` (generated)
- Modify: `apps/web/package.json`, `vite.config.ts`, `tsconfig.json`, `src/theme/theme.css`, `knip.json`, `biome.json`

- [ ] **Step 1:** `components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "", "css": "src/theme/theme.css", "baseColor": "zinc", "cssVariables": true },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/design",
    "ui": "@/design",
    "utils": "@/design/ClassName",
    "lib": "@/design",
    "hooks": "@/design"
  }
}
```

- [ ] **Step 2:** `@` alias: `vite.config.ts` `resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }`; `tsconfig.json` `"paths": { "@/*": ["./src/*"] }`. Check dependency-cruiser resolves `@/` (add `tsConfig: { fileName: "apps/web/tsconfig.json" }` to its options if not).
- [ ] **Step 3:** `pnpm dlx shadcn@latest add button command dialog dropdown-menu toggle-group tooltip sonner` in `apps/web`. If the CLI writes `src/lib/utils.ts` anyway, move `cn` to `src/design/ClassName.ts`, delete `src/lib/`, and fix imports to `@/design/ClassName`.
- [ ] **Step 4:** `knip.json`: add an `apps/web` workspace with `"ignore": []` and `"ignoreExportsUsedInFile": true`, and an `ignoreIssues` (or `ignore` of exports) for `src/design/**` only, so unused named exports of vendored primitives are not reported. Biome: if generated files trip recommended rules, add an `overrides` entry for `apps/web/src/design/**` turning off only the rules they trip, listed by name.
- [ ] **Step 5:** Theme tokens in `theme.css` (dark only for now; the `.dark` block shadcn writes becomes `:root`): a near-black background, zinc neutrals, one accent (signal green `oklch(0.79 0.18 152)` for audio and live), an amber for warnings, `--radius: 0.375rem`, tabular numbers on `body`. Font: Inter (or the system UI stack) for chrome, a mono for clocks.
- [ ] **Step 6:** `pnpm check`; `pnpm --filter @sportal/web build`; commit `feat(web): shadcn primitives in design/, dark broadcast theme`.

---

### Task 7: Tile rectangles in pixels

**Files:**
- Create: `apps/web/src/stage/TileRects.ts`, `apps/web/src/stage/TileRects.test.ts`

**Interfaces:**
- Consumes: `Stage#currentLayout`, `Layout#slots`, `Stage#solo`, `Stage#slotOf`.
- Produces:
  - `tileRects(stage: Stage, area: { width: number; height: number }): ReadonlyArray<{ x; y; width; height }>` — one per on-stage slot, whole pixels, inset by half the gap; a soloed slot gets the whole area and the others a zero-size rect at their own position.
  - `videoBounds(rect)` — the part of a tile below its header: `{ x, y: y + header, width, height: height - header }`.
  - `placements(stage, rects, origin: { x; y })` — `TilePlacement`s for stream and picking tiles, offset by the Stage area's position in the window, skipping zero-size rects.
  - Constants `gap = 6`, `header = 28` (pixels), beside their only user.

- [ ] **Step 1: Tests:**

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { Result } from "effect"
import { placements, tileRects, videoBounds } from "./TileRects.ts"

const area = { width: 1600, height: 900 }

describe("tileRects", () => {
  it("lays a Quad out in whole pixels with a gap between tiles", () => {
    const [main, right] = tileRects(Stage.initial, area)
    assert.deepStrictEqual(main, { x: 3, y: 3, width: 794, height: 444 })
    assert.deepStrictEqual(right, { x: 803, y: 3, width: 794, height: 444 })
  })

  it("gives a soloed game the whole area and the others nothing", () => {
    const stage = soloed()
    const rects = tileRects(stage, area)
    assert.deepStrictEqual(rects[1], { x: 3, y: 3, width: 1594, height: 894 })
    assert.strictEqual(rects[0]?.width, 0)
  })
})

describe("placements", () => {
  it("places a stream tile's video below its header, offset by the Stage area's position", () => {
    const stage = withStream()
    const [placement] = placements(stage, tileRects(stage, area), { x: 352, y: 48 })
    assert.deepStrictEqual(placement?.bounds, { x: 355, y: 79, width: 794, height: 416 })
  })

  it("places nothing for a tile with no size", () => {
    const stage = soloed()
    assert.strictEqual(placements(stage, tileRects(stage, area), { x: 0, y: 0 }).length, 1)
  })
})
```

with `withStream()` / `soloed()` building stages from `new Stage({ ...Stage.initial, tiles: [...] })` holding `StreamTile`s (copy the `foxChannel` shape from `Stage.test.ts`).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** `TileRects.ts`: scale each slot fraction to pixels by rounding the slot's edges (`left = round(x * width)`, `right = round((x + w) * width)`) so neighbouring tiles share an edge, then inset by `gap / 2`. Solo: the soloed slot becomes `{0, 0, width, height}` inset; others `{ ...ownRect, width: 0, height: 0 }`. `placements` moves the body of today's `placements` from `StageView.tsx` here, reading bounds from `videoBounds(rect)` plus `origin`, `muted: tile.game !== stage.audioFocus`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** `pnpm check`; commit `feat(web): tile rectangles and placements are computed from the layout`.

---

### Task 8: The frame and the Stage view

Visual work: invoke the `frontend-design` skill at the start of this task for the frame, tile chrome, layout glyphs, and bench.

**Files:**
- Create: `apps/web/src/frame/TopBar.tsx`, `apps/web/src/frame/FullScreen.ts`, `apps/web/src/stage/TileChrome.tsx`, `apps/web/src/stage/Dividers.tsx`, `apps/web/src/stage/Bench.tsx`, `apps/web/src/stage/LayoutGlyph.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/stage/StageView.tsx`, `apps/web/src/slate/SlateView.tsx`

**Interfaces:**
- Consumes: `tileRects`, `placements`, `videoBounds` (Task 7); `ShellBridge` (Task 3); design primitives (Task 6).
- Produces:
  - `useFullScreen(): { on: boolean; toggle(): void }` — the shell's `setFullScreen`/`onFullScreenChanged` inside the shell, the Fullscreen API in a browser.
  - `stageTransition = { durationMs: 280, easing: [0.2, 0, 0, 1] }` exported from `StageView.tsx` (the CSS transition is built from it).
  - `StageView` props unchanged plus `fullScreen: boolean`.

Steps:
- [ ] **Step 1: `FullScreen.ts`.** `useFullScreen` with `useSyncExternalStore`: in the shell subscribe with `onFullScreenChanged`; in a browser with `fullscreenchange`. `toggle` calls `setFullScreen(!on)` or `requestFullscreen`/`exitFullscreen`.
- [ ] **Step 2: `App.tsx`.** Grid: top bar row over `[sidebar | stage]`; full screen collapses to the Stage alone. The sidebar holds `SlateView` (restyled with design primitives, same content) and `Bench`.
- [ ] **Step 3: `TopBar.tsx`.** Wordmark; layout picker (`ToggleGroup` of `LayoutGlyph`s, one per `LayoutName.literals`, dispatching `SetLayout`); solo toggle for the selected tile (`Solo`/`Unsolo`); full screen button; connection state; sign-in button (moved from the slate header).
- [ ] **Step 4: `StageView.tsx`.**
  - Observe the Stage area with a `ResizeObserver` into `{ width, height, x, y }` state.
  - `rects = tileRects(stage, area)`; render each on-stage tile absolutely at its rect, keyed by game (`tile.game`, or `slot-${index}` for empty), with `transition: left, top, width, height ${durationMs}ms cubic-bezier(...)`.
  - `useLayoutEffect` on `[stage, area]`: `syncTiles(placements(stage, rects, area), changedArrangement ? stageTransition : undefined)`, where `changedArrangement` is true when the layout, split, solo, or any game's slot changed since the last sync (kept in a ref), and false for a resize.
  - Remove the window `resize` listener; the `ResizeObserver` covers it.
  - Keep the channel-pick and guide effects as they are.
- [ ] **Step 5: `TileChrome.tsx`.** The header strip (height `header` from `TileRects.ts`): slot number, score line, audio indicator (button: `FocusAudio`), promote (`Promote`), solo (`Solo`/`Unsolo`), clear, and the tile's existing notices and channel buttons (`Not on YouTube TV`, `wrong channel`). The header is a drop target: dropping a dragged tile or bench game sends `Swap { a: from, b: slot }`; the header is draggable with its tile index.
- [ ] **Step 6: `Dividers.tsx`.** For the current layout's used dividers (`x` for all but `Single`; `y` for `Quad` and `MainFive`), a handle in the gap. Pointer down captures; moves compute the split from the pointer and the area, clamped to 0.2–0.8, held in local state that `StageView` uses in place of the Stage's split while dragging, synced without a transition; pointer up sends `SetSplit`. If Task 0 found pointer moves stop over provider views, `setHidden` every game for the drag.
- [ ] **Step 7: `Bench.tsx`.** Benched non-empty tiles as compact rows (score line, network). Click sends `Swap { a: benchIndex, b: selected }`; rows are draggable onto tile headers.
- [ ] **Step 8:** `pnpm check`; run the web dev server and look at it in a browser (layouts switch with animated chrome, dividers move, bench appears when shrinking); commit `feat(web): the frame, layouts, dividers, bench, solo and full screen`.

---

### Task 9: Overlay host, command palette, hotkeys, rejections

**Files:**
- Create: `apps/web/src/OverlayHost.tsx`, `apps/web/src/stage/CommandPalette.tsx`, `apps/web/src/stage/Hotkeys.ts`
- Modify: `apps/web/src/design/dialog.tsx`, `dropdown-menu.tsx`, `tooltip.tsx` (their `Content` registers with the host), `apps/web/src/hub/HubClient.ts`, `apps/web/src/App.tsx`, `apps/web/src/stage/StageView.tsx`

**Interfaces:**
- Produces:
  - `OverlayHost` (context provider) with `useCovering(ref: RefObject<HTMLElement | null>)` for overlay content, and `useVideoAreas(areas: ReadonlyArray<{ game: GameId; bounds }>)` called by `StageView` with the placements. The host intersects every open overlay's `getBoundingClientRect()` (re-measured on resize via `ResizeObserver`) with the video areas and calls `window.sportalShell?.setHidden(games)` when the set changes.
  - `dispatch(command)` now returns `Promise<Option<StageRejection>>`; rejections show as a toast (`sonner`, bottom left, over the sidebar).
  - `useHotkeys(handlers)`: one `keydown` listener on `window` using `Hotkey.of` (skipping events whose target is an input, unless it is ⌘K) plus `sportalShell.onHotkey`, both calling the same handler.

Steps:
- [ ] **Step 1: `OverlayHost.tsx`** as above. The intersection is a pure function in the file (tested in `OverlayHost.test.ts`: overlapping, touching, and disjoint rects).
- [ ] **Step 2:** In the three design `Content` components, add `const ref = useRef(null); useCovering(ref)` and pass `ref` through (merged with a forwarded ref if the component has one).
- [ ] **Step 3: `HubClient.dispatch`** returns the rejection (`Effect.flip` on `StageRejection`, everything else as `Option.none()` after logging); `App` shows `toast(rejectionText(reason))` for one.
- [ ] **Step 4: `Hotkeys.ts`** and wiring in `App`: `FocusAudio{slot}` → `dispatch FocusAudio{tile: slot}`; `Promote` likewise; `ToggleSolo` → `Solo{tile: selected}` or `Unsolo`; `Unsolo`; `FullScreen` → `toggle`; `NextLayout` → `SetLayout{Layout.next(stage.layout)}`; `CommandPalette` → open.
- [ ] **Step 5: `CommandPalette.tsx`** (`CommandDialog`): groups Games (each slate game: "Watch in tile N"), Tiles (promote, solo, audio, clear per occupied slot), Layout (each layout), Display (full screen). Values include team names, abbreviations, and networks so cmdk's fuzzy search finds them.
- [ ] **Step 6:** `pnpm check`; commit `feat(web): overlays hide only the video they cover; command palette and hotkeys`.

---

### Task 10: Docs

**Files:** `docs/technical-spec.md` §5.3, `docs/game-day-checklist.md`, `docs/adr/0002-desktop-shell-playback.md` (if Task 0 did not already), `AGENTS.md` (the `src/design/` exception to file naming).

- [ ] **Step 1:** §5.3: state and commands as built; invariants as in the spec; geometry in `Layout`.
- [ ] **Step 2:** Game-day rows: a promote animates with video playing; full screen and solo stack; hotkeys with a stream focused, and typing in a guide; a divider drag tracks the video; a tile menu blanks only its tile; the command palette blanks only what it covers; shrinking to `Single` and back restores every game; a swap does not reload either player.
- [ ] **Step 3:** AGENTS.md "Where code goes": "`apps/web/src/design/` holds vendored shadcn primitives under the CLI's own file names; nothing else goes there."
- [ ] **Step 4:** `pnpm check`; commit `docs: stage control in the technical spec, game-day rows, and the design folder`.
