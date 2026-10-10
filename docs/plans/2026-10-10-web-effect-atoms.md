# The web UI on Effect and atoms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up `apps/web` with no change in behaviour: views render and send what a person did; state and every
effect on the window, the shell, the Hub, and storage live in atoms over one `Atom.runtime` of Effect services.

**Architecture:** A `Shell` service is the one reader of `window.sportalShell`, `document` full screen, and page keys.
One `Atom.runtime` (`WebRuntime.ts`) provides `Shell` and `HubClient`. The Display's local state becomes a writable
atom taking a `DisplayInput`; guide relay, tile placements, and overlay covering become mounted atoms. Mechanical
cleanups (renames, loose functions onto their types, the Field's state machine out of its component) land first.

**Tech Stack:** Effect 4.0.0 (`effect/reactivity` Atom, AtomRegistry), `@effect/atom-react` 4.0.0, React 19,
Vitest via `@effect/vitest`, TypeScript 7 with `@effect/tsgo`.

**Spec:** `docs/specs/2026-10-10-web-effect-atoms-design.md`.

## Global Constraints

- Read `AGENTS.md` before touching code. Its module shapes, in-file order, and "one spelling per kind" table apply to
  every file below.
- No behaviour change. Every existing test assertion is kept as it moves.
- A commit that rewrites or moves a test lists, in its body, each old test name and the new test names carrying its
  assertions (AGENTS.md, Tests).
- `pnpm check` passes before every commit (format, lint, typecheck with Effect diagnostics, depcruise, knip
  `--production`, tests). Run it from the worktree root. `knip --production` fails on an export only tests use: every
  export a task adds is used by production code in the same task.
- Every exported type name is a term in `CONTEXT.md` (React components and `Test*.ts` excepted). New ones land in Task 11;
  until then `pnpm check` does not police glossary terms, so this ordering is safe.
- Effect 4 is newer than training data: when a signature is in doubt, read
  `node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/reactivity/Atom.d.ts` (and `Stream.d.ts`, `Layer.d.ts`)
  rather than guessing.
- Comments: a doc comment on each major export; an inline comment only for a non-obvious why. Trim restating
  comments in code you move.
- Tests: `it("should …")`, `describe` names the unit, Arrange / Act / Assert separated by blank lines, no AAA comments,
  one behaviour per test.
- Work in the worktree `../sportal-web` on branch `web-effect-atoms` (Task 0). Do not touch the main checkout: it has
  the user's uncommitted edits in `packages/api/src/SportalApi.ts` and `apps/hub/src/HubServer.ts`.

## File map (end state)

| File | Responsibility |
|---|---|
| `apps/web/src/WebRuntime.ts` *(new)* | `runtime`: the one `Atom.runtime` of `HubClient` and `Shell` |
| `apps/web/src/shell/Shell.ts` *(new)* | `Shell` service: page keys, shell events, shell calls; `layer`, `layerBridge`, `layerBrowser`, `layerTest` |
| `apps/web/src/hub/HubClient.ts` | `HubClient` service with `sendGuide`; `layerTest` |
| `apps/web/src/hub/GuideRelay.ts` *(new)* | `relay` mounted atom |
| `apps/web/src/hub/HubRuntime.ts` | deleted |
| `apps/web/src/display/Display.ts` | `Display`, `DisplayStep` (`DisplayStep.of`), `DisplayInput`, `Overlay`; `Display#apply` |
| `apps/web/src/display/DisplayState.ts` *(new)* | `display`, `cards`, `fullScreen`, `toggleFullScreen`, `inputs`, `signIn`, `openSignIn` atoms |
| `apps/web/src/display/Covering.ts` *(new)* | `overlays` atom, `sync` mounted atom |
| `apps/web/src/display/OverlayRef.ts` *(new)* | `useOverlayRef`: the ref an overlay's content takes |
| `apps/web/src/display/OverlayHost.tsx`, `FullScreen.ts`, `Hotkeys.ts` | deleted |
| `apps/web/src/screen/TileRects.ts` | pure geometry: `tileRects`, `placements`, `coveredGames`, `gap`, `tileHeader`; rectangles typed `TileBounds` |
| `apps/web/src/screen/TilePlacements.ts` *(new)* | `area`, `dragged`, `shown`, `rects`, `placements` atoms, `screenTransition`, `sync` mounted atom |
| `apps/web/src/screen/TileAction.ts` *(was TileActions.tsx)* | `TileAction` data class |
| `apps/web/src/slate/StripCard.ts` *(was StripCards.ts)* | `StripCard`, `Place` |
| `apps/web/src/layout/Layout.ts` | `Layout` with `Layout.label`; `Slot` |
| `apps/web/src/game/FieldDrawing.ts` *(new)* | `FieldDrawing` (state + `initial`, `step`, `spotsOf`), `FieldEvent` |
| `packages/domain/src/Slate.ts` | adds `Slate#gameOf` |
| `packages/domain/src/Game.ts` | adds `GameSnapshot#scoreline` |
| `apps/web/src/TestWeb.ts` | `slate` becomes a `Slate`; adds `MemoryStorage`, `until`, `keep`, `registryOf`, `withShell` |

---

### Task 0: Worktree

- [ ] **Step 1: Create the worktree from main**

```bash
cd /home/chazzy/development/projects/sportal
git worktree add ../sportal-web -b web-effect-atoms main
cd ../sportal-web
pnpm install
```

Expected: `pnpm install` finishes; the `prepare` script patches `tsc` with `@effect/tsgo`.

- [ ] **Step 2: Baseline**

Run: `pnpm check`
Expected: PASS. If it fails on main, stop and report; do not start on a red baseline.

---

### Task 1: `StripCard.ts`, and `Slate#gameOf`

**Files:**
- Modify: `packages/domain/src/Slate.ts`, `packages/domain/src/Slate.test.ts`
- Rename: `apps/web/src/slate/StripCards.ts` → `apps/web/src/slate/StripCard.ts`,
  `apps/web/src/slate/StripCards.test.ts` → `apps/web/src/slate/StripCard.test.ts`
- Modify: `apps/web/src/TestWeb.ts`, `apps/web/src/display/Display.ts`, `apps/web/src/display/Display.test.ts`,
  `apps/web/src/display/DisplayView.tsx`, `apps/web/src/display/CommandPalette.tsx`,
  `apps/web/src/screen/ScreenView.tsx`, `apps/web/src/slate/SlateView.tsx`, `apps/web/src/slate/PlaceBadge.tsx`

**Interfaces:**
- Produces: `Slate#gameOf(id: GameId): Option.Option<Game>`; `StripCard.of(screen: Screen, slate: Slate)`;
  `TestWeb.slate: Slate`.

- [ ] **Step 1: Write the failing domain test**

In `packages/domain/src/Slate.test.ts`, change the Game import to bring the class in as a value:

```ts
import { Game, GameId, type GameSnapshot } from "./Game.ts"
```

and add, after the `describe("Slate.empty", …)` block:

```ts
describe("Slate#gameOf", () => {
  it("should find a listed game by its id", () => {
    const game = Game.of(snapshot({ id: one }))
    const slate = new Slate({ games: [game] })

    const found = slate.gameOf(one)

    assert.deepStrictEqual(found, Option.some(game))
  })

  it("should find nothing for an id the slate does not list", () => {
    const slate = new Slate({ games: [Game.of(snapshot({ id: one }))] })

    const found = slate.gameOf(two)

    assert.isTrue(Option.isNone(found))
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/domain/src/Slate.test.ts`
Expected: FAIL, `slate.gameOf is not a function` (or a type error).

- [ ] **Step 3: Add `gameOf`**

In `packages/domain/src/Slate.ts`, import `Array as Arr` and `Option` from `effect` (`import { Array as Arr, Data, Option, Schema } from "effect"`) and add after `static readonly empty`:

```ts
  /** Game `id`, when the slate lists it. */
  gameOf(id: GameId): Option.Option<Game> {
    return Arr.findFirst(this.games, (game) => game.snapshot.id === id)
  }
```

- [ ] **Step 4: Run the domain test**

Run: `pnpm vitest run packages/domain/src/Slate.test.ts`
Expected: PASS.

- [ ] **Step 5: Rename the strip card module and take a `Slate`**

```bash
git mv apps/web/src/slate/StripCards.ts apps/web/src/slate/StripCard.ts
git mv apps/web/src/slate/StripCards.test.ts apps/web/src/slate/StripCard.test.ts
```

In `apps/web/src/slate/StripCard.ts` replace the imports and `StripCard.of` with:

```ts
import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import type { Slate } from "@sportal/domain/Slate"
import { Array as Arr, Data, Option } from "effect"
import type { Screen } from "../screen/Screen.ts"
```

```ts
  static of(screen: Screen, slate: Slate): ReadonlyArray<StripCard> {
    const benched = screen.benched()
    const bench = benched.map(({ tile, game }) => {
      const snapshot = Option.getOrUndefined(Option.map(slate.gameOf(game), (found) => found.snapshot))
      return new StripCard({ id: game, game: snapshot, place: Place.Bench({ tile }), section: "Bench" })
    })
    const rest = slate.games
      .map(({ snapshot }) => snapshot)
      .filter((game) => !benched.some((bench) => bench.game === game.id))
      .toSorted(GameSnapshot.watchOrder)
      .map((game) => {
        const slot = screen.slotOf(game.id)
        const place = slot === undefined ? undefined : Place.Slot({ slot })
        return new StripCard({ id: game.id, game, place, section: sections[game.progress()] })
      })
    return [...bench, ...rest]
  }
```

(The doc comment above `of` stays as it is.)

- [ ] **Step 6: `TestWeb.slate` becomes a `Slate`**

In `apps/web/src/TestWeb.ts`:

```ts
/** Four games in no order: live, soon, later, done are the ids; the strip puts them live, soon, later, done. */
export const slate = new Slate({ games: [done, later, live, soon].map(Game.of) })
```

(`Slate` is already imported there.)

- [ ] **Step 7: Follow the rename and the `Slate` everywhere**

- `apps/web/src/slate/StripCard.test.ts`: `import { StripCard } from "./StripCard.ts"`.
- `apps/web/src/display/Display.ts`, `apps/web/src/display/Display.test.ts`, `apps/web/src/display/DisplayView.tsx`,
  `apps/web/src/slate/SlateView.tsx`, `apps/web/src/slate/PlaceBadge.tsx`: import from `…/StripCard.ts`.
- `apps/web/src/display/DisplayView.tsx`: `const cards = StripCard.of(screen, live.slate)`, pass `slate={live.slate}`
  to `ScreenView` and `CommandPalette`.
- `apps/web/src/display/CommandPalette.tsx`: the prop becomes `slate: Slate` (`import type { Slate } from "@sportal/domain/Slate"`);
  replace `snapshots`/`gameOn` with

```ts
  const snapshots = props.slate.games.map(({ snapshot }) => snapshot)
  const occupied = props.screen.onScreen().flatMap((tile, slot) => {
    if (Tile.guards.Empty(tile)) return []
    const name = Option.match(props.slate.gameOf(tile.game), {
      onNone: () => `Tile ${slot + 1}`,
      onSome: ({ snapshot }) => scoreline(snapshot)
    })
    return [{ slot, name }]
  })
```

- `apps/web/src/screen/ScreenView.tsx`: the prop becomes `slate: Slate`; the tile's game is

```ts
        const game = Tile.guards.Empty(tile) ? undefined : Option.getOrUndefined(props.slate.gameOf(tile.game))
```

- [ ] **Step 8: Check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: StripCard.ts, and Slate#gameOf finds a listed game

StripCards.test.ts -> StripCard.test.ts: every test kept under its name.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `GameSnapshot#scoreline`

**Files:**
- Modify: `packages/domain/src/Game.ts`, `packages/domain/src/Game.test.ts`
- Modify: `apps/web/src/game/Score.tsx`, `apps/web/src/game/Score.test.ts`, `apps/web/src/display/CommandPalette.tsx`

**Interfaces:**
- Produces: `GameSnapshot#scoreline(): string`.

- [ ] **Step 1: Move the tests to the domain (failing)**

In `packages/domain/src/Game.test.ts`, after `describe("GameSnapshot#matchup", …)`:

```ts
describe("GameSnapshot#scoreline", () => {
  it("should read the away side first, the abbreviations around the scores", () => {
    const game = liveSnapshot({
      away: { ...snapshot().away, score: 21 },
      home: { ...snapshot().home, score: 14 }
    })

    const line = game.scoreline()

    assert.strictEqual(line, "AWAY 21–14 HOME")
  })

  it("should show no score before kickoff", () => {
    const line = snapshot().scoreline()

    assert.strictEqual(line, "AWAY @ HOME")
  })
})
```

Delete the `describe("scoreline", …)` block from `apps/web/src/game/Score.test.ts` and change its import to
`import { Score } from "./Score.tsx"`.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/domain/src/Game.test.ts`
Expected: FAIL, `scoreline is not a function`.

- [ ] **Step 3: Add the method; remove the loose function**

In `packages/domain/src/Game.ts`, after `matchup()`:

```ts
  /** The score as one line of text: "KC 21–14 BUF", or "KC @ BUF" before there is a score. */
  scoreline(): string {
    if (!this.scored()) return `${this.away.team.abbreviation} @ ${this.home.team.abbreviation}`
    return `${this.away.team.abbreviation} ${this.away.score}–${this.home.score} ${this.home.team.abbreviation}`
  }
```

Delete `scoreline` from `apps/web/src/game/Score.tsx`. In `apps/web/src/display/CommandPalette.tsx` drop the
`scoreline` import and write `snapshot.scoreline()` / `game.scoreline()` at its three uses.

- [ ] **Step 4: Check and commit**

Run: `pnpm check` — Expected: PASS.

```bash
git add -A
git commit -m "refactor: the scoreline is GameSnapshot#scoreline

Score.test.ts \"scoreline\" -> Game.test.ts \"GameSnapshot#scoreline\": both tests kept under their names.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `TileAction`

**Files:**
- Create: `apps/web/src/screen/TileAction.ts`, rename `apps/web/src/screen/TileActions.test.ts` → `apps/web/src/screen/TileAction.test.ts`
- Delete: `apps/web/src/screen/TileActions.tsx`
- Modify: `apps/web/src/screen/TileChrome.tsx`, `apps/web/src/display/CommandPalette.tsx`

**Interfaces:**
- Produces: `class TileAction { id: "hear" | "promote" | "solo" | "unsolo" | "clear"; verb; label; command: ScreenCommand; key: string | undefined; static of(screen, slot, selected): ReadonlyArray<TileAction>; shortcut(): string | undefined }`.

- [ ] **Step 1: Move the tests (failing)**

```bash
git mv apps/web/src/screen/TileActions.test.ts apps/web/src/screen/TileAction.test.ts
```

In it: `import { TileAction } from "./TileAction.ts"`; `describe("TileAction.of", …)`; every
`tileActions(` becomes `TileAction.of(`. Append:

```ts
describe("TileAction#shortcut", () => {
  it("should read a shifted digit with the shift sign", () => {
    const promote = actionOf(TestWeb.fill([TestWeb.bama, TestWeb.irish]), 1, true, "promote")

    const shortcut = promote?.shortcut()

    assert.strictEqual(shortcut, "⇧2")
  })

  it("should read Escape as Esc", () => {
    const unsolo = actionOf(TestWeb.soloed([TestWeb.bama, TestWeb.irish], 1), 1, true, "unsolo")

    const shortcut = unsolo?.shortcut()

    assert.strictEqual(shortcut, "Esc")
  })

  it("should have none for an action with no key", () => {
    const clear = actionOf(TestWeb.fill([TestWeb.bama]), 0, true, "clear")

    const shortcut = clear?.shortcut()

    assert.isUndefined(shortcut)
  })
})
```

Run: `pnpm vitest run apps/web/src/screen/TileAction.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Write `TileAction.ts`**

```ts
import { Data } from "effect"
import { type Screen, type ScreenCommand, Tile } from "./Screen.ts"

/**
 * One thing that can be done to an on-screen tile. A host renders it as a button or a palette item and sends
 * `command` itself. `verb` is the short form for a list that already names the tile; `key` is the hotkey, in the
 * form `aria-keyshortcuts` takes.
 */
export class TileAction extends Data.Class<{
  readonly id: "hear" | "promote" | "solo" | "unsolo" | "clear"
  readonly verb: string
  readonly label: string
  readonly command: ScreenCommand
  readonly key: string | undefined
}> {
  /**
   * What can be done to the tile in `slot`, in the order every host lists it: hear it, promote it unless it is the
   * main tile, solo or unsolo it, clear it. An empty tile has none. Solo acts on the selected tile, so only `selected`
   * gives it a key; Escape unsolos from anywhere.
   */
  static of(screen: Screen, slot: number, selected: boolean): ReadonlyArray<TileAction> {
    const tile = screen.onScreen()[slot]
    if (tile === undefined || Tile.guards.Empty(tile)) return []

    const hearLabel = screen.hears(tile.game) ? "Sound on" : "Hear this game"
    const hear = new TileAction({
      id: "hear",
      verb: "Hear",
      label: hearLabel,
      command: { _tag: "FocusAudio", tile: slot },
      key: String(slot + 1)
    })
    const promote = new TileAction({
      id: "promote",
      verb: "Promote",
      label: "Promote to the main tile",
      command: { _tag: "Promote", tile: slot },
      key: `Shift+${slot + 1}`
    })
    const solo = screen.soloes(tile.game)
      ? new TileAction({ id: "unsolo", verb: "Unsolo", label: "Unsolo", command: { _tag: "Unsolo" }, key: "Escape" })
      : new TileAction({
          id: "solo",
          verb: "Solo",
          label: "Solo",
          command: { _tag: "Solo", tile: slot },
          key: selected ? "F" : undefined
        })
    const clear = new TileAction({
      id: "clear",
      verb: "Clear",
      label: "Clear",
      command: { _tag: "Clear", tile: slot },
      key: undefined
    })
    return slot === 0 ? [hear, solo, clear] : [hear, promote, solo, clear]
  }

  /** The hotkey as a person reads it, in tooltips and the palette: `Shift+2` is "⇧2", `Escape` is "Esc". */
  shortcut(): string | undefined {
    return this.key?.replace("Shift+", "⇧").replace("Escape", "Esc")
  }
}
```

Delete `apps/web/src/screen/TileActions.tsx`.

- [ ] **Step 3: Hosts pick the icon**

`apps/web/src/screen/TileChrome.tsx`: replace the `TileActions.tsx` import with
`import { TileAction } from "./TileAction.ts"` and
`import { ArrowUpLeft, Shrink, SquareDashed, Volume2, VolumeX, X } from "lucide-react"` plus `import type { ReactNode } from "react"`.
The button loop becomes:

```tsx
        {TileAction.of(props.screen, slot, props.selected).map((action) => {
          const shortcut = action.shortcut()
          return (
            <Button
              key={action.id}
              variant="ghost"
              size="icon-xs"
              aria-label={action.label}
              aria-keyshortcuts={action.key}
              title={shortcut === undefined ? action.label : `${action.label} · ${shortcut}`}
              className={cn(
                "text-muted-foreground",
                action.id === "hear" && onAir && "text-on-air",
                action.id === "clear" && "hover:text-destructive"
              )}
              onClick={() => dispatch(action.command)}
            >
              {iconOf(action, onAir)}
            </Button>
          )
        })}
```

and below the component (before `tileDrag`):

```tsx
/** An action's icon; hear shows whether the tile's sound is on. */
function iconOf(action: TileAction, hearing: boolean): ReactNode {
  switch (action.id) {
    case "hear":
      return hearing ? <Volume2 /> : <VolumeX />
    case "promote":
      return <ArrowUpLeft />
    case "solo":
      return <SquareDashed />
    case "unsolo":
      return <Shrink />
    case "clear":
      return <X />
  }
}
```

`apps/web/src/display/CommandPalette.tsx`: replace the `TileActions.tsx` import with
`import { TileAction } from "../screen/TileAction.ts"`; `tileActions(props.screen, slot, slot === props.selected)`
becomes `TileAction.of(props.screen, slot, slot === props.selected)`; the shortcut cell becomes

```tsx
                      {action.shortcut() !== undefined && <CommandShortcut>{action.shortcut()}</CommandShortcut>}
```

- [ ] **Step 4: Check and commit**

Run: `pnpm check` — Expected: PASS.

```bash
git add -A
git commit -m "refactor: tile actions are TileAction values; hosts choose the icon

TileActions.test.ts -> TileAction.test.ts: every \"tileActions\" test kept under its name in
\"TileAction.of\". New: TileAction#shortcut (was keyText, untested).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `Layout.label` and `Slot`

**Files:**
- Modify: `apps/web/src/layout/Layout.ts`, `apps/web/src/layout/Layout.test.ts`, `apps/web/src/layout/LayoutGlyph.tsx`,
  `apps/web/src/layout/LayoutPicker.tsx`, `apps/web/src/display/CommandPalette.tsx`

**Interfaces:**
- Produces: `Layout.label(name: LayoutName): string`; `interface Slot { readonly x; readonly y; readonly width; readonly height }`; `Layout#slots(): ReadonlyArray<Slot>`.

- [ ] **Step 1: Failing test**

Append to `apps/web/src/layout/Layout.test.ts`:

```ts
describe("Layout.label", () => {
  it("should name each layout as people read it", () => {
    const labels = LayoutName.literals.map(Layout.label)

    assert.deepStrictEqual(labels, ["Single", "Side by side", "Quad", "Main + 3", "Main + 5"])
  })
})
```

Run: `pnpm vitest run apps/web/src/layout/Layout.test.ts` — Expected: FAIL.

- [ ] **Step 2: Move the label and name the slot**

In `apps/web/src/layout/Layout.ts`, add the static after `next`:

```ts
  /** A layout's name as people read it. */
  static label(name: LayoutName): string {
    return labels[name]
  }
```

`slots()` becomes `slots(): ReadonlyArray<Slot> {`. After the class:

```ts
/** A place in a layout: a rectangle as fractions of the Screen area. */
export interface Slot {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
```

`slotsOf`'s type becomes `Record<LayoutName, (split: Split) => ReadonlyArray<Slot>>`; `rect` gains `: Slot`. Move the
labels table from `LayoutGlyph.tsx` beside `dividers`:

```ts
const labels: Record<LayoutName, string> = {
  Single: "Single",
  Pair: "Side by side",
  Quad: "Quad",
  MainThree: "Main + 3",
  MainFive: "Main + 5"
}
```

Delete `layoutLabel` and `layoutLabels` from `LayoutGlyph.tsx`. In `LayoutPicker.tsx` and `CommandPalette.tsx`,
`layoutLabel(x)` becomes `Layout.label(x)` (import `Layout` from `../layout/Layout.ts` / `./Layout.ts`).

- [ ] **Step 3: Check and commit**

Run: `pnpm check` — Expected: PASS.

```bash
git add -A
git commit -m "refactor: Layout.label, and a layout's slot is a Slot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `Screen.apply` settles once

**Files:**
- Modify: `apps/web/src/screen/Screen.ts`

No behaviour change; `Screen.test.ts` already covers every branch.

- [ ] **Step 1: Rewrite `apply`, `slotOf`, and the helpers**

`slotOf`:

```ts
  slotOf(game: GameId): number | undefined {
    const slot = this.onScreen().findIndex((tile) => holds(tile, game))
    return slot === -1 ? undefined : slot
  }
```

`apply`:

```ts
  apply(
    command: ScreenCommand,
    availabilityOf: (game: GameId) => ReadonlyArray<ChannelAvailability>
  ): Result.Result<Screen, ScreenRejection> {
    const next = ScreenCommand.match<Result.Result<Unsettled, ScreenRejection>>(command, {
      SetLayout: ({ layout }) => Result.succeed({ ...this, layout }),
      SetSplit: ({ split }) => {
        const { min, max } = Screen.splitBounds
        const holdsSplit = [split.x, split.y].every((at) => at >= min && at <= max)
        return holdsSplit ? Result.succeed(this.withSplit(split)) : reject("split-out-of-range")
      },
      Unsolo: () => Result.succeed({ ...this, solo: Option.none() }),
      Swap: ({ a, b }) =>
        Option.isNone(Arr.get(this.tiles, a)) || Option.isNone(Arr.get(this.tiles, b))
          ? reject("no-such-tile")
          : Result.succeed({ ...this, tiles: swapped(this.tiles, a, b) }),
      Assign: ({ tile, game }) =>
        tileAt(this, tile, () => {
          const assigned = tileFor(game, availabilityOf(game))
          // A game appears in at most one tile, on screen or benched: assigning it elsewhere moves it.
          const tiles = this.tiles.map((existing, index) =>
            index === tile ? assigned : holds(existing, game) ? empty : existing
          )
          return Result.succeed({ ...this, tiles })
        }),
      Clear: ({ tile }) =>
        tileAt(this, tile, () => {
          const tiles = this.tiles.map((existing, index) => (index === tile ? empty : existing))
          return Result.succeed({ ...this, tiles })
        }),
      Promote: ({ tile }) =>
        tileAt(this, tile, (found) =>
          occupied(found, ({ game }) =>
            Result.succeed({ ...this, tiles: swapped(this.tiles, 0, tile), audioFocus: Option.some(game) })
          )
        ),
      FocusAudio: ({ tile }) =>
        onScreenAt(this, tile, ({ game }) => Result.succeed({ ...this, audioFocus: Option.some(game) })),
      Solo: ({ tile }) =>
        onScreenAt(this, tile, ({ game }) =>
          Result.succeed({ ...this, audioFocus: Option.some(game), solo: Option.some(game) })
        )
    })
    return Result.map(next, settle)
  }
```

After `ScreenRejection`, replace the `Occupied` alias block with:

```ts
/** A tile that holds a game. */
type Occupied = Exclude<Tile, { readonly _tag: "Empty" }>

/** A Screen's fields before `settle` makes them a Screen that keeps its invariants. */
interface Unsettled {
  readonly tiles: ReadonlyArray<Tile>
  readonly layout: LayoutName
  readonly splits: Screen["splits"]
  readonly audioFocus: Option.Option<GameId>
  readonly solo: Option.Option<GameId>
}
```

`tileAt`, `onScreenAt`, and `occupied` return `Result.Result<Unsettled, ScreenRejection>` and take
`f: (…) => Result.Result<Unsettled, ScreenRejection>`. `settle(fields: Unsettled): Screen`. `refresh` keeps calling
`settle({ ...this, tiles })`. Add below `occupied`:

```ts
function holds(tile: Tile, game: GameId): boolean {
  return !Tile.guards.Empty(tile) && tile.game === game
}
```

- [ ] **Step 2: Check and commit**

Run: `pnpm check` — Expected: PASS (Screen.test.ts unchanged and green).

```bash
git add -A
git commit -m "refactor: Screen.apply settles once; holds names the occupied-by check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `FieldDrawing`

**Files:**
- Create: `apps/web/src/game/FieldDrawing.ts`, `apps/web/src/game/FieldDrawing.test.ts`
- Modify: `apps/web/src/game/Field.tsx`

**Interfaces:**
- Produces: `type FieldDrawing` and `const FieldDrawing` (`Settled`, `Animating`, `$is`, `$match`, `initial(plays)`,
  `step(drawing, event)`, `spotsOf(game, play)`); `type FieldEvent` and `const FieldEvent` (`Arrived`, `Drawn`).

- [ ] **Step 1: Failing tests**

`apps/web/src/game/FieldDrawing.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { PlayId } from "@sportal/domain/Play"
import { liveSnapshot, play, team } from "@sportal/domain/TestGame"
import { FieldDrawing, FieldEvent } from "./FieldDrawing.ts"

describe("FieldDrawing.initial", () => {
  it("should take the plays on hand as drawn", () => {
    const drawing = FieldDrawing.initial([playAt(1), playAt(2)])

    assert.deepStrictEqual(drawing, FieldDrawing.Settled({ last: 2 }))
  })
})

describe("FieldDrawing.step", () => {
  it("should draw a play newer than the last", () => {
    const next = FieldDrawing.step(FieldDrawing.Settled({ last: 1 }), arrived([playAt(1), playAt(2)]))

    assert.deepStrictEqual(next, FieldDrawing.Animating({ play: playAt(2), queued: [], last: 2 }))
  })

  it("should queue only the newest three plays that arrive while one draws", () => {
    const drawing = FieldDrawing.Animating({ play: playAt(2), queued: [], last: 2 })

    const next = FieldDrawing.step(drawing, arrived([3, 4, 5, 6].map(playAt)))

    assert.deepStrictEqual(next, FieldDrawing.Animating({ play: playAt(2), queued: [4, 5, 6].map(playAt), last: 6 }))
  })

  it("should skip a play with no spot on the field", () => {
    const offField = play({ id: PlayId.make("2"), sequence: 2, end: { team: team("HOME").id } })

    const next = FieldDrawing.step(FieldDrawing.Settled({ last: 1 }), arrived([offField, playAt(3)]))

    assert.deepStrictEqual(next, FieldDrawing.Animating({ play: playAt(3), queued: [], last: 3 }))
  })

  it("should settle on the newest play sent when the plays go back to an earlier sequence", () => {
    const next = FieldDrawing.step(FieldDrawing.Settled({ last: 9 }), arrived([playAt(1), playAt(2)]))

    assert.deepStrictEqual(next, FieldDrawing.Settled({ last: 2 }))
  })

  it("should draw the next queued play once the drawing one is drawn", () => {
    const drawing = FieldDrawing.Animating({ play: playAt(2), queued: [playAt(3)], last: 3 })

    const next = FieldDrawing.step(drawing, FieldEvent.Drawn({ play: PlayId.make("2"), game }))

    assert.deepStrictEqual(next, FieldDrawing.Animating({ play: playAt(3), queued: [], last: 3 }))
  })

  it("should ignore a drawn play that is not the one drawing", () => {
    const drawing = FieldDrawing.Animating({ play: playAt(2), queued: [playAt(3)], last: 3 })

    const next = FieldDrawing.step(drawing, FieldEvent.Drawn({ play: PlayId.make("9"), game }))

    assert.strictEqual(next, drawing)
  })
})

const game = liveSnapshot()

/** The home team's one-yard rush with sequence `sequence`, its id the same number. */
function playAt(sequence: number) {
  return play({ id: PlayId.make(String(sequence)), sequence })
}

function arrived(plays: ReturnType<typeof playAt>[]) {
  return FieldEvent.Arrived({ plays, game })
}
```

Run: `pnpm vitest run apps/web/src/game/FieldDrawing.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Write `FieldDrawing.ts`**

```ts
import type { GameSnapshot } from "@sportal/domain/Game"
import { Play, type PlayId } from "@sportal/domain/Play"
import { Data, Option } from "effect"

/**
 * Which plays a field has drawn: settled on the situation after the play with sequence `last`, or animating `play`
 * with `queued` to follow. `last` is the newest play taken in, drawn, queued, or dropped from a full queue.
 */
export type FieldDrawing = Data.TaggedEnum<{
  Settled: { readonly last: number }
  Animating: { readonly play: Play; readonly queued: ReadonlyArray<Play>; readonly last: number }
}>
export const FieldDrawing = Object.assign(Data.taggedEnum<FieldDrawing>(), { initial, step, spotsOf })

/** What a field hears: plays arrived from the Hub, or a play finished drawing. */
export type FieldEvent = Data.TaggedEnum<{
  Arrived: { readonly plays: ReadonlyArray<Play>; readonly game: GameSnapshot }
  Drawn: { readonly play: PlayId; readonly game: GameSnapshot }
}>
export const FieldEvent = Data.taggedEnum<FieldEvent>()

/** A field's first drawing: the plays on hand are taken as drawn. */
function initial(plays: ReadonlyArray<Play>): FieldDrawing {
  return FieldDrawing.Settled({ last: newestOf(plays) })
}

/**
 * What a drawing becomes on an event. Each new play is drawn in turn, only the newest few when many arrive at once;
 * all are taken as drawn again when the plays go back to an earlier sequence (the feed started over).
 */
function step(drawing: FieldDrawing, event: FieldEvent): FieldDrawing {
  return FieldEvent.$match(event, {
    Arrived: ({ plays, game }) => {
      const newestSent = newestOf(plays)
      if (newestSent < drawing.last) return FieldDrawing.Settled({ last: newestSent })
      const fresh = plays.filter((play) => play.sequence > drawing.last).toSorted(Play.order)
      const newest = fresh.at(-1)
      if (newest === undefined) return drawing
      return FieldDrawing.$match(drawing, {
        Settled: () => nextOf(fresh.slice(-queueLength), newest.sequence, game),
        Animating: (current) =>
          FieldDrawing.Animating({
            ...current,
            queued: [...current.queued, ...fresh].slice(-queueLength),
            last: newest.sequence
          })
      })
    },
    Drawn: (drawn) =>
      FieldDrawing.$match(drawing, {
        Settled: () => drawing,
        Animating: ({ play, queued, last }) =>
          play.id === drawn.play ? nextOf(queued, last, drawn.game) : drawing
      })
  })
}

/** Where a play started and ended on the field, when both are on it. */
function spotsOf(game: GameSnapshot, play: Play) {
  return Option.all({ start: game.spotOf(play.start), end: game.spotOf(play.end) })
}

function newestOf(plays: ReadonlyArray<Play>): number {
  return Math.max(-1, ...plays.map((play) => play.sequence))
}

/** The first play in `queue` with both spots on the field, drawing; the plays before it are skipped. */
function nextOf(queue: ReadonlyArray<Play>, last: number, game: GameSnapshot): FieldDrawing {
  const index = queue.findIndex((play) => Option.isSome(spotsOf(game, play)))
  const play = queue[index]
  return play === undefined
    ? FieldDrawing.Settled({ last })
    : FieldDrawing.Animating({ play, queued: queue.slice(index + 1), last })
}

/**
 * The most plays a field waits to draw: a page that was hidden while plays arrived draws only the newest few, not the
 * whole backlog.
 */
const queueLength = 3
```

- [ ] **Step 3: `Field.tsx` renders only**

In `apps/web/src/game/Field.tsx`:
- Delete `Drawing`, `queueLength`, `FieldEvent`, `step`, `nextOf`, `spotsOf` and their comments.
- Imports: drop `Data` and `type PlayId`; add `import { FieldDrawing, FieldEvent } from "./FieldDrawing.ts"`.
- The reducer: `const [drawing, dispatch] = useReducer(FieldDrawing.step, plays, FieldDrawing.initial)`.
- `Drawing.$is("Settled")` → `FieldDrawing.$is("Settled")`; `Drawing.$match` → `FieldDrawing.$match`.
- In `PlayArrow`: `const spots = FieldDrawing.spotsOf(game, play)`.
- Trim the component's doc comment to what it draws (the drawing rules now live in `FieldDrawing.step`'s comment):

```ts
/**
 * A game's field from above, one SVG in yards: the end zones in their teams' colors, the ball and the lines of its
 * situation, and each new play drawn as an arrow from where it started to where it ended, as `FieldDrawing` orders
 * them. Out of play, or with no ball on the field, it is dimmed and shows no ball. The away team defends the left end
 * zone and the home team the right.
 */
```

- [ ] **Step 4: Run, check, commit**

Run: `pnpm vitest run apps/web/src/game/FieldDrawing.test.ts` — Expected: PASS.
Run: `pnpm check` — Expected: PASS.

```bash
git add -A
git commit -m "refactor: the Field's drawing state machine is FieldDrawing, with its tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `Shell`, one runtime, the Hub client, the guide relay

**Files:**
- Create: `apps/web/src/shell/Shell.ts`, `apps/web/src/shell/Shell.test.ts`, `apps/web/src/WebRuntime.ts`,
  `apps/web/src/hub/GuideRelay.ts`, `apps/web/src/hub/GuideRelay.test.ts`
- Modify: `apps/web/src/hub/HubClient.ts`, `apps/web/src/TestWeb.ts`, `apps/web/src/screen/ScreenView.tsx`,
  `apps/web/src/display/DisplayView.tsx`, `apps/web/src/screen/DisplayScreen.test.ts`,
  `apps/web/src/hub/LiveStream.test.ts`
- Delete: `apps/web/src/hub/HubRuntime.ts`

**Interfaces:**
- Produces:
  - `class Shell` (service id `"sportal/web/shell/Shell"`) with members `hotkeys: Stream<Hotkey>`,
    `fullScreen: Stream<boolean>`, `tilePressed: Stream<GameId>`, `guideRead: Stream<string>`,
    `setFullScreen(on): Effect<void>`, `syncTiles(placements, transition: Option<ScreenTransition>): Effect<void>`,
    `setHidden(games): Effect<void>`, `readGuide: Effect<void>`, `openSignIn: Option<Effect<void>>`;
    statics `layer`, `layerBridge(bridge)`, `layerBrowser`, `layerTest({ hotkeys?, fullScreen?, tilePressed?, guideRead?, record })`.
  - `class HubClient` with `sendGuide(guide: string): Effect<void, GuideUnreadable | HttpClientError.HttpClientError>`;
    `HubClient.layer`, `HubClient.layerTest(sendGuide)`.
  - `WebRuntime.runtime: AtomRuntime<HubClient | Shell>`.
  - `GuideRelay.relay: Atom<AsyncResult<void, …>>` (mounted).
  - `TestWeb.MemoryStorage`, `TestWeb.until(atom, predicate)`, `TestWeb.registryOf(layer)`, `TestWeb.withShell(events?)`
    returning `{ registry, calls }` where `calls: Queue.Queue<ShellCall | { _tag: "SendGuide"; guide: string }>`.

- [ ] **Step 1: `Shell.ts`**

```ts
import { Hotkey } from "@sportal/api/Hotkey"
import type { ScreenTransition, ShellBridge, TilePlacement } from "@sportal/api/ShellBridge"
import type { GameId } from "@sportal/domain/Game"
import { Context, Effect, Layer, Option, Queue, Stream } from "effect"

/**
 * The web UI's edge to its window and to the desktop shell: hotkeys, full screen, presses on a video, and the guide
 * the shell reads, and the calls that place videos and ask for a guide. The one reader of `window.sportalShell`.
 */
export class Shell extends Context.Service<
  Shell,
  {
    /** Hotkeys pressed on the page (not repeats, not typed into a field, not already handled; Ctrl+K always) and in a focused stream view. */
    readonly hotkeys: Stream.Stream<Hotkey>
    /** Whether the window is full screen, each time it changes. */
    readonly fullScreen: Stream.Stream<boolean>
    /** The game whose video was clicked while it was not interactive. */
    readonly tilePressed: Stream.Stream<GameId>
    /** Each guide the shell reads from the source, unchanged. */
    readonly guideRead: Stream.Stream<string>
    readonly setFullScreen: (on: boolean) => Effect.Effect<void>
    /** Replaces the provider views; with a transition they move along it, without one at once. */
    readonly syncTiles: (
      placements: ReadonlyArray<TilePlacement>,
      transition: Option.Option<ScreenTransition>
    ) => Effect.Effect<void>
    /** Hides exactly these games' videos and shows the rest. */
    readonly setHidden: (games: ReadonlyArray<GameId>) => Effect.Effect<void>
    /** Asks the shell to read the guide now. */
    readonly readGuide: Effect.Effect<void>
    /** Opens the YouTube TV sign-in; none in a plain browser, which has no sign-in to open. */
    readonly openSignIn: Option.Option<Effect.Effect<void>>
  }
>()("sportal/web/shell/Shell") {
  /** The shell's bridge when the page runs in the shell, else the browser's own. */
  static readonly layer: Layer.Layer<Shell> = Layer.unwrap(
    Effect.sync(() => {
      const bridge = window.sportalShell
      return bridge === undefined ? Shell.layerBrowser : Shell.layerBridge(bridge)
    })
  )

  static layerBridge(bridge: ShellBridge): Layer.Layer<Shell> {
    return Layer.succeed(
      Shell,
      Shell.of({
        hotkeys: Stream.merge(
          pageHotkeys,
          listened((listener) => bridge.onHotkey(listener))
        ),
        fullScreen: listened((listener) => bridge.onFullScreenChanged(listener)),
        tilePressed: listened((listener) => bridge.onTilePressed(listener)),
        guideRead: listened((listener) => bridge.onGuideRead(listener)),
        setFullScreen: (on) => Effect.sync(() => bridge.setFullScreen(on)),
        syncTiles: (placements, transition) =>
          Effect.sync(() => bridge.syncTiles(placements, Option.getOrUndefined(transition))),
        setHidden: (games) => Effect.sync(() => bridge.setHidden(games)),
        readGuide: Effect.sync(() => bridge.readGuide()),
        openSignIn: Option.some(Effect.sync(() => bridge.openSignIn()))
      })
    )
  }

  // Lazy: the helpers it reads are defined below the class.
  static readonly layerBrowser: Layer.Layer<Shell> = Layer.sync(Shell, () =>
    Shell.of({
      hotkeys: pageHotkeys,
      fullScreen: listened((listener) => {
        const changed = () => listener(document.fullscreenElement !== null)
        document.addEventListener("fullscreenchange", changed)
        return () => document.removeEventListener("fullscreenchange", changed)
      }),
      tilePressed: Stream.empty,
      guideRead: Stream.empty,
      // A browser refuses full screen outside a user gesture, or when the page may not have it.
      setFullScreen: (on) =>
        Effect.tryPromise(() => (on ? document.documentElement.requestFullscreen() : document.exitFullscreen())).pipe(
          Effect.catch((error) => Effect.logWarning("The browser did not change full screen", error))
        ),
      syncTiles: () => Effect.void,
      setHidden: () => Effect.void,
      readGuide: Effect.void,
      openSignIn: Option.none()
    })
  )

  /** A Shell giving these events (none where not given), and running `record` for each call it is asked to make. */
  static layerTest(options: {
    readonly hotkeys?: Stream.Stream<Hotkey>
    readonly fullScreen?: Stream.Stream<boolean>
    readonly tilePressed?: Stream.Stream<GameId>
    readonly guideRead?: Stream.Stream<string>
    readonly record: (
      call:
        | { readonly _tag: "SetFullScreen"; readonly on: boolean }
        | {
            readonly _tag: "SyncTiles"
            readonly placements: ReadonlyArray<TilePlacement>
            readonly transition: Option.Option<ScreenTransition>
          }
        | { readonly _tag: "SetHidden"; readonly games: ReadonlyArray<GameId> }
        | { readonly _tag: "ReadGuide" }
        | { readonly _tag: "OpenSignIn" }
    ) => Effect.Effect<void>
  }): Layer.Layer<Shell> {
    const { record } = options
    return Layer.succeed(
      Shell,
      Shell.of({
        hotkeys: options.hotkeys ?? Stream.empty,
        fullScreen: options.fullScreen ?? Stream.empty,
        tilePressed: options.tilePressed ?? Stream.empty,
        guideRead: options.guideRead ?? Stream.empty,
        setFullScreen: (on) => record({ _tag: "SetFullScreen", on }),
        syncTiles: (placements, transition) => record({ _tag: "SyncTiles", placements, transition }),
        setHidden: (games) => record({ _tag: "SetHidden", games }),
        readGuide: record({ _tag: "ReadGuide" }),
        openSignIn: Option.some(record({ _tag: "OpenSignIn" }))
      })
    )
  }
}

/** Hotkeys pressed on the page. Keys typed into a text field are the field's, and a key already handled is ignored, except Ctrl+K. */
const pageHotkeys: Stream.Stream<Hotkey> = Stream.callback<Hotkey>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const pressed = (event: KeyboardEvent) => {
        const hotkey = Hotkey.of(
          { code: event.code, shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey, meta: event.metaKey },
          "page"
        )
        if (hotkey === undefined || event.repeat) return
        if (!Hotkey.guards.CommandPalette(hotkey) && (isTyping(event.target) || event.defaultPrevented)) return
        // In the listener itself: a default prevented after the event has been dispatched is too late.
        event.preventDefault()
        Queue.offerUnsafe(queue, hotkey)
      }
      window.addEventListener("keydown", pressed)
      return pressed
    }),
    (pressed) => Effect.sync(() => window.removeEventListener("keydown", pressed))
  )
)

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  )
}

/** An event as a stream: `listen` subscribes, and the function it returns unsubscribes. */
function listened<A>(listen: (listener: (value: A) => void) => () => void): Stream.Stream<A> {
  return Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => listen((value) => Queue.offerUnsafe(queue, value))),
      (stop) => Effect.sync(stop)
    )
  )
}
```

`Stream.fromEventListener` is not used for page keys on purpose: it hands events over asynchronously, after the
dispatch, when `preventDefault` no longer works.

- [ ] **Step 2: Failing tests for the browser's page keys**

`apps/web/src/shell/Shell.test.ts` (node has `EventTarget` and `Event`, not a DOM; `window` and `HTMLElement` are
stubbed):

```ts
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { vi } from "vitest"
import { Shell } from "./Shell.ts"

describe("Shell.layerBrowser hotkeys", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget())
    vi.stubGlobal("HTMLElement", class {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should give a hotkey pressed on the page and prevent its default", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey
      const event = keydown({ code: "KeyS" })

      window.dispatchEvent(event)
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "ToggleSlate" })
      assert.isTrue(event.defaultPrevented)
    })
  )

  it.effect("should skip a repeated key", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey

      window.dispatchEvent(keydown({ code: "KeyS", repeat: true }))
      window.dispatchEvent(keydown({ code: "Slash", shiftKey: true }))
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "ShowKeys" })
    })
  )

  it.effect("should skip a key something already handled", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey
      const handled = keydown({ code: "KeyS" })
      handled.preventDefault()

      window.dispatchEvent(handled)
      window.dispatchEvent(keydown({ code: "Slash", shiftKey: true }))
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "ShowKeys" })
    })
  )

  it.effect("should give Ctrl+K even when something already handled it", () =>
    Effect.gen(function* () {
      const next = yield* firstHotkey
      const handled = keydown({ code: "KeyK", ctrlKey: true })
      handled.preventDefault()

      window.dispatchEvent(handled)
      const hotkey = yield* Fiber.join(next)

      assert.deepStrictEqual(hotkey, { _tag: "CommandPalette" })
    })
  )
})

/** The first hotkey the browser Shell gives, listening from the moment it is forked. */
const firstHotkey = Shell.use((shell) =>
  shell.hotkeys.pipe(Stream.runHead, Effect.flatMap(Effect.fromOption), Effect.forkChild({ startImmediately: true }))
).pipe(Effect.provide(Shell.layerBrowser))

/** A cancelable keydown with these keys, as a browser dispatches it. */
function keydown(keys: { code: string; shiftKey?: boolean; ctrlKey?: boolean; repeat?: boolean }) {
  return Object.assign(new Event("keydown", { cancelable: true }), {
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    ...keys
  })
}
```

If `Shell.use` does not accept an effect that returns a fiber (check `Context.Service`'s `use` in
`node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/Context.d.ts`), write it as
`Effect.gen(function* () { const shell = yield* Shell; return yield* <same pipe> })`. The typing rule
(`isTyping`) needs a DOM element as the event's target, which node cannot dispatch to `window`; it is moved unchanged
and covered by the eye-check in Task 12.

Run: `pnpm vitest run apps/web/src/shell/Shell.test.ts` — Expected: PASS once Step 1 is in (these characterise moved
behaviour; if one fails, the move changed behaviour — fix the code, not the test).

- [ ] **Step 3: `HubClient` offers `sendGuide`**

Replace `apps/web/src/hub/HubClient.ts`:

```ts
import type { GuideUnreadable } from "@sportal/api/GuideUnreadable"
import { SportalApi } from "@sportal/api/SportalApi"
import { Context, Effect, Layer, type Schema } from "effect"
import type { HttpClient, HttpClientError } from "effect/http"
import { HttpApiClient } from "effect/http-api"

/** This client's way to the Hub's HTTP API. */
export class HubClient extends Context.Service<
  HubClient,
  {
    /** Passes a guide the shell read to the Hub. What it changes arrives on the live stream. */
    readonly sendGuide: (guide: string) => Effect.Effect<void, GuideUnreadable | HttpClientError.HttpClientError>
  }
>()("sportal/web/hub/HubClient") {
  static readonly layer: Layer.Layer<HubClient, never, HttpClient.HttpClient> = Layer.effect(
    HubClient,
    Effect.gen(function* () {
      const api = yield* HttpApiClient.make(SportalApi)

      const sendGuide = Effect.fn("HubClient.sendGuide")(function* (guide: string) {
        yield* answerRead(api.guide.read({ payload: { guide } }))
      })
      return HubClient.of({ sendGuide })
    })
  )

  /** A Hub client that hands each guide to `sendGuide`. */
  static layerTest(sendGuide: (guide: string) => Effect.Effect<void>): Layer.Layer<HubClient> {
    return Layer.succeed(HubClient, HubClient.of({ sendGuide }))
  }
}

/** An answer this UI cannot read means it and the Hub disagree on the API: a defect, logged where it happens. */
function answerRead<A, E, R>(request: Effect.Effect<A, E | Schema.SchemaError, R>) {
  return request.pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.logError("The Hub's answer did not decode", error).pipe(Effect.andThen(Effect.die(error)))
    )
  )
}
```

If tsgo reports the layer's requirement or `sendGuide`'s error differently, write the type it reports — the
behaviour is fixed, the spelled type follows the compiler.

- [ ] **Step 4: `WebRuntime.ts`; delete `HubRuntime.ts`**

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Atom } from "effect/reactivity"
import { HubClient } from "./hub/HubClient.ts"
import { Shell } from "./shell/Shell.ts"

/** The one runtime the web UI's effects run in: the Hub client and the Shell. Tests swap `runtime.layer`. */
export const runtime = Atom.runtime(
  Layer.mergeAll(HubClient.layer, Shell.layer).pipe(Layer.provide(FetchHttpClient.layer))
)
```

```bash
git rm apps/web/src/hub/HubRuntime.ts
```

- [ ] **Step 5: `TestWeb` helpers**

Add to `apps/web/src/TestWeb.ts` (imports: `Effect, Layer, Queue, Stream` from `effect`; `AtomRegistry` as a value
from `effect/reactivity`; `HubClient` from `./hub/HubClient.ts`; `Shell` from `./shell/Shell.ts`;
`* as WebRuntime` from `./WebRuntime.ts`):

```ts
/** The first value of `atom` that `predicate` holds for. */
export function until<A>(atom: Atom.Atom<A>, predicate: (value: A) => boolean) {
  return Atom.toStream(atom).pipe(Stream.filter(predicate), Stream.runHead, Effect.flatMap(Effect.fromOption))
}

/** A registry whose web runtime is `layer` in place of the browser's. */
export function registryOf(layer: Layer.Layer<Shell | HubClient>) {
  return AtomRegistry.layerOptions({ initialValues: [[WebRuntime.runtime.layer, layer]] })
}

/**
 * A registry whose web runtime has a Shell giving `events` and a Hub client taking every guide, and each call the
 * Shell and the Hub client are asked to make, in order.
 */
export const withShell = Effect.fn("TestWeb.withShell")(function* (
  events: Omit<Parameters<typeof Shell.layerTest>[0], "record"> = {}
) {
  const calls = yield* Queue.unbounded<ShellCall | { readonly _tag: "SendGuide"; readonly guide: string }>()
  const layer = Layer.mergeAll(
    Shell.layerTest({ ...events, record: (call) => Effect.asVoid(Queue.offer(calls, call)) }),
    HubClient.layerTest((guide) => Effect.asVoid(Queue.offer(calls, { _tag: "SendGuide", guide })))
  )
  return { registry: registryOf(layer), calls }
})

type ShellCall = Parameters<Parameters<typeof Shell.layerTest>[0]["record"]>[0]

/** Keeps `screen` in this browser, as the Display would have before a reload. */
export const keep = Effect.fn("TestWeb.keep")(function* (screen: Screen) {
  const encoded = yield* Schema.encodeEffect(Screen)(screen)
  localStorage.setItem("sportal/screen", JSON.stringify(encoded))
})
```

Move `MemoryStorage` from `apps/web/src/screen/DisplayScreen.test.ts` into `TestWeb.ts`, exported, with its doc
comment, and import it there as `TestWeb.MemoryStorage`. In `DisplayScreen.test.ts`, replace `untilLive(p)` with
`TestWeb.until(LiveStream.live, p)`, `untilScreen(p)` with `TestWeb.until(DisplayScreen.screen, p)`, and the kept-screen
arrange in "should start from the Screen this browser kept" with `yield* TestWeb.keep(kept)`; delete the local
helpers. In `LiveStream.test.ts`, `until(p)` becomes `TestWeb.until(LiveStream.live, p)`; delete the local `until`.
Every test keeps its name and assertions.

- [ ] **Step 6: Failing tests for the relay**

`apps/web/src/hub/GuideRelay.test.ts`:

```ts
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Layer, Queue, Ref, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import { Shell } from "../shell/Shell.ts"
import * as TestWeb from "../TestWeb.ts"
import * as GuideRelay from "./GuideRelay.ts"
import { HubClient } from "./HubClient.ts"
import * as LiveStream from "./LiveStream.ts"

describe("GuideRelay.relay", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should send each guide the shell reads to the Hub", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell({ guideRead: Stream.make("<guide/>") })

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SendGuide", guide: "<guide/>" })
    })
  )

  it.effect("should ask the shell to read the guide when the live stream connects", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        const source = yield* TestWeb.opened
        source.onopen?.()
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "ReadGuide" })
    })
  )

  it.effect("should not ask again for a message while the live stream stays connected", () =>
    Effect.gen(function* () {
      const guides = yield* Queue.unbounded<string>()
      const { registry, calls } = yield* TestWeb.withShell({ guideRead: Stream.fromQueue(guides) })

      const second = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        const source = yield* TestWeb.opened
        source.onopen?.()
        yield* Queue.take(calls)
        source.onmessage?.({ data: TestWeb.slateMessage([]) })
        yield* TestWeb.until(LiveStream.live, (live) => live.slate.games.length === 0)
        yield* Queue.offer(guides, "<later/>")
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(second, { _tag: "SendGuide", guide: "<later/>" })
    })
  )

  it.effect("should listen for guides before it first asks for one", () =>
    Effect.gen(function* () {
      const listening = yield* Ref.make(false)
      const asked = yield* Queue.unbounded<boolean>()
      const shell = Shell.layerTest({
        guideRead: Stream.unwrap(Effect.as(Ref.set(listening, true), Stream.never)),
        record: (call) =>
          call._tag === "ReadGuide"
            ? Ref.get(listening).pipe(Effect.flatMap((on) => Queue.offer(asked, on)), Effect.asVoid)
            : Effect.void
      })
      const registry = TestWeb.registryOf(Layer.merge(shell, HubClient.layerTest(() => Effect.void)))

      const listeningWhenAsked = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        const source = yield* TestWeb.opened
        source.onopen?.()
        return yield* Queue.take(asked)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(listeningWhenAsked)
    })
  )
})
```

Run: `pnpm vitest run apps/web/src/hub/GuideRelay.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 7: `GuideRelay.ts`**

```ts
import { Effect, Stream } from "effect"
import { Shell } from "../shell/Shell.ts"
import { runtime } from "../WebRuntime.ts"
import { HubClient } from "./HubClient.ts"
import * as LiveStream from "./LiveStream.ts"

/**
 * Passes each guide the shell reads to the Hub, and asks the shell to read again each time the live stream connects,
 * since a guide read while the Hub was away was lost. Mounted once, by the Display.
 */
export const relay = runtime.atom((get) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const hub = yield* HubClient

    // Listening first, then asking: the shell's first read waits for the web UI to ask.
    yield* shell.guideRead.pipe(
      Stream.runForEach((guide) =>
        hub.sendGuide(guide).pipe(Effect.catch((failure) => Effect.logWarning("The Hub did not take a guide", failure)))
      ),
      Effect.forkScoped({ startImmediately: true })
    )
    yield* get.stream(LiveStream.live).pipe(
      Stream.map(({ connection }) => LiveStream.Connection.$is("Connected")(connection)),
      Stream.changes,
      Stream.filter((connected) => connected),
      Stream.runForEach(() => shell.readGuide)
    )
  })
)
```

Run: `pnpm vitest run apps/web/src/hub/GuideRelay.test.ts` — Expected: PASS.

- [ ] **Step 8: The Display mounts the relay; ScreenView stops relaying**

`apps/web/src/screen/ScreenView.tsx`: delete the `onGuideRead` effect, the `readGuide`-on-connect effect, the
`connected` const, and the imports of `sendGuide`, `runtime`, and `Effect`. The `connection` prop is now unused:
remove it from ScreenView's props and from DisplayView's `<ScreenView … />`.

`apps/web/src/display/DisplayView.tsx`: `import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"`,
`import * as GuideRelay from "../hub/GuideRelay.ts"`, and in the component body, beside
`useScreenRejectionToasts()`: `useAtomMount(GuideRelay.relay)`.

- [ ] **Step 9: Check and commit**

Run: `pnpm check` — Expected: PASS.

```bash
git add -A
git commit -m "feat: a Shell service and one web runtime; the guide relay is an atom

The Shell is the one reader of window.sportalShell, document full screen and page keys. HubClient
offers sendGuide; HubRuntime.ts goes. ScreenView no longer relays guides.

DisplayScreen.test.ts, LiveStream.test.ts: local until helpers and MemoryStorage move to TestWeb;
every test keeps its name and assertions.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The Display atom

**Files:**
- Modify: `apps/web/src/display/Display.ts`, `apps/web/src/display/Display.test.ts`
- Create: `apps/web/src/display/DisplayState.ts`, `apps/web/src/display/DisplayState.test.ts`
- Modify: `apps/web/src/display/DisplayView.tsx`, `apps/web/src/display/TopBar.tsx`,
  `apps/web/src/display/CommandPalette.tsx`, `apps/web/src/slate/SlateView.tsx`, `apps/web/src/layout/LayoutPicker.tsx`,
  `apps/web/src/screen/TileChrome.tsx`, `apps/web/src/screen/ScreenView.tsx`
- Delete: `apps/web/src/display/FullScreen.ts`, `apps/web/src/display/Hotkeys.ts`

**Interfaces:**
- Consumes: `Shell` members, `WebRuntime.runtime`, `TestWeb.withShell`, `TestWeb.keep`, `TestWeb.until`,
  `TestWeb.MemoryStorage` (Task 7); `StripCard.of(screen, slate)` (Task 1); `TileAction` (Task 3).
- Produces:
  - `DisplayInput` cases `Pressed { hotkey }`, `Selected { slot }`, `VideoPressed { game }`, `Dropped { card }`,
    `Commanded { command }`, `Opened { overlay: "Keys" | "Palette" }`, `Closed`, `SlateToggled`.
  - `Display#apply(input, screen, cards): DisplayStep`; `DisplayStep.of(display, commands?)`; exported `Overlay`.
  - `DisplayState.display: Atom.Writable<Display, DisplayInput>`, `DisplayState.cards: Atom.Atom<ReadonlyArray<StripCard>>`,
    `DisplayState.fullScreen: Atom.Atom<boolean>`, `DisplayState.toggleFullScreen` (write `undefined`),
    `DisplayState.inputs` (mounted), `DisplayState.signIn: Atom.Atom<boolean>`, `DisplayState.openSignIn` (write `undefined`).

- [ ] **Step 1: Failing tests for `Display#apply`**

Append to `apps/web/src/display/Display.test.ts` (import `DisplayInput` beside `Display, DisplayStep`):

```ts
describe("Display#apply", () => {
  it("should press a hotkey as press does", () => {
    const screen = TestWeb.withTiles(["live"])

    const step = apply(Display.initial, DisplayInput.Pressed({ hotkey: { _tag: "ToggleSlate" } }), screen)

    assert.deepStrictEqual(step, press(Display.initial, { _tag: "ToggleSlate" }, screen))
  })

  it("should select a slot as select does", () => {
    const screen = TestWeb.withTiles(["live", "soon"])

    const step = apply(Display.initial, DisplayInput.Selected({ slot: 1 }), screen)

    assert.deepStrictEqual(step, Display.initial.select(1, screen))
  })

  it("should select the slot a pressed video's game is in", () => {
    const screen = TestWeb.withTiles(["live", "soon"])

    const { display, commands } = apply(Display.initial, DisplayInput.VideoPressed({ game: GameId.make("soon") }), screen)

    assert.strictEqual(display.selected, 1)
    assert.deepStrictEqual(commands, [])
  })

  it("should do nothing for a pressed video whose game is not on screen", () => {
    const screen = TestWeb.withTiles(["live"])

    const { display } = apply(Display.initial, DisplayInput.VideoPressed({ game: GameId.make("gone") }), screen)

    assert.strictEqual(display, Display.initial)
  })

  it("should drop a card as drop does", () => {
    const screen = TestWeb.withTiles(["soon"])
    const free = cardOf(screen, 0)

    const step = apply(Display.initial, DisplayInput.Dropped({ card: free }), screen)

    assert.deepStrictEqual(step, Display.initial.drop(free, screen))
  })

  it("should send a command and change nothing", () => {
    const command: ScreenCommand = { _tag: "SetLayout", layout: "Single" }

    const { display, commands } = apply(Display.initial, DisplayInput.Commanded({ command }), TestWeb.withTiles([]))

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [command])
  })

  it("should open an overlay", () => {
    const { display } = apply(Display.initial, DisplayInput.Opened({ overlay: "Keys" }), TestWeb.withTiles([]))

    assert.isTrue(display.shows("Keys"))
  })

  it("should close the open overlay", () => {
    const { display } = apply(Display.initial.open("Palette"), DisplayInput.Closed(), TestWeb.withTiles([]))

    assert.strictEqual(display.overlay._tag, "None")
  })

  it("should toggle the slate", () => {
    const { display } = apply(Display.initial, DisplayInput.SlateToggled(), TestWeb.withTiles([]))

    assert.isFalse(display.slateOpen)
  })
})
```

and beside the `press` helper:

```ts
function apply(display: Display, input: DisplayInput, screen: Screen) {
  return display.apply(input, screen, StripCard.of(screen, TestWeb.slate))
}
```

Run: `pnpm vitest run apps/web/src/display/Display.test.ts` — Expected: FAIL.

- [ ] **Step 2: `Display.ts`**

Replace `apps/web/src/display/Display.ts`:

```ts
import { Hotkey } from "@sportal/api/Hotkey"
import type { GameId } from "@sportal/domain/Game"
import { Data, Option } from "effect"
import { Layout } from "../layout/Layout.ts"
import { type Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"
import { Place, StripCard } from "../slate/StripCard.ts"

/** The one overlay a Display has open, or none. Above the class: `Display.initial` reads it when the class is defined. */
export type Overlay = Data.TaggedEnum<{ None: object; Keys: object; Palette: object }>
export const Overlay = Data.taggedEnum<Overlay>()

/**
 * A Display's local state: what is selected, interacting, picked, and open. Never sent to the Hub. Each input
 * answers with the next Display and the screen commands for the caller to send.
 */
export class Display extends Data.Class<{
  /** The slot as last chosen; read it through `selectedOn`. */
  readonly selected: number
  /** Read it through `interactingOn`. */
  readonly interacting: GameId | undefined
  readonly pick: GameId | undefined
  readonly slateOpen: boolean
  readonly overlay: Overlay
}> {
  /** Slot 0, nothing interacting or picked, the slate open, and no overlay. */
  static readonly initial = new Display({
    selected: 0,
    interacting: undefined,
    pick: undefined,
    slateOpen: true,
    overlay: Overlay.None()
  })

  /** The selected slot on this Screen: the last slot when the layout now has fewer. */
  selectedOn(screen: Screen): number {
    return Math.min(this.selected, screen.onScreen().length - 1)
  }

  /**
   * The interacting game, while the selected slot still holds its stream; otherwise none. It returns when its game is
   * back in the selected slot.
   */
  interactingOn(screen: Screen): GameId | undefined {
    const tile = screen.onScreen()[this.selectedOn(screen)]
    return Tile.guards.StreamTile(tile) && tile.game === this.interacting ? this.interacting : undefined
  }

  /** What an input does on this Screen, with the slate strip's `cards`. */
  apply(input: DisplayInput, screen: Screen, cards: ReadonlyArray<StripCard>): DisplayStep {
    return DisplayInput.$match(input, {
      Pressed: ({ hotkey }) => this.press(hotkey, screen, cards),
      Selected: ({ slot }) => this.select(slot, screen),
      VideoPressed: ({ game }) => {
        const slot = screen.slotOf(game)
        return slot === undefined ? DisplayStep.of(this) : this.select(slot, screen)
      },
      Dropped: ({ card }) => this.drop(card, screen),
      Commanded: ({ command }) => DisplayStep.of(this, [command]),
      Opened: ({ overlay }) => DisplayStep.of(this.open(overlay)),
      Closed: () => DisplayStep.of(this.close()),
      SlateToggled: () => DisplayStep.of(this.toggleSlate())
    })
  }

  /** What a hotkey does. `FullScreen` does nothing here: it is the shell's or browser's, not the Display's. */
  press(hotkey: Hotkey, screen: Screen, cards: ReadonlyArray<StripCard>): DisplayStep {
    return Hotkey.match(hotkey, {
      SelectTile: ({ slot }) => this.select(slot, screen),
      ToggleSolo: () => {
        if (Option.isSome(screen.solo)) return DisplayStep.of(this, [{ _tag: "Unsolo" }])
        const slot = this.selectedOn(screen)
        return DisplayStep.of(this, Tile.guards.Empty(screen.onScreen()[slot]) ? [] : [{ _tag: "Solo", tile: slot }])
      },
      Unsolo: () =>
        !Overlay.$is("None")(this.overlay)
          ? DisplayStep.of(this.close())
          : DisplayStep.of(this, Option.isNone(screen.solo) ? [] : [{ _tag: "Unsolo" }]),
      Interact: () => {
        const tile = screen.onScreen()[this.selectedOn(screen)]
        if (!Tile.guards.StreamTile(tile)) return DisplayStep.of(this)
        const interacting = this.interactingOn(screen) === undefined ? tile.game : undefined
        return DisplayStep.of(new Display({ ...this, interacting }))
      },
      StepPick: ({ step }) => DisplayStep.of(new Display({ ...this, pick: StripCard.nextPick(cards, this.pick, step) })),
      DropPick: () => {
        const card = cards.find((card) => card.id === this.pick)
        return card === undefined ? DisplayStep.of(this) : this.drop(card, screen)
      },
      ToggleSlate: () => DisplayStep.of(this.toggleSlate()),
      ShowKeys: () => DisplayStep.of(Overlay.$is("Keys")(this.overlay) ? this.close() : this.open("Keys")),
      CommandPalette: () => DisplayStep.of(Overlay.$is("Palette")(this.overlay) ? this.close() : this.open("Palette")),
      FocusAudio: ({ slot }) => DisplayStep.of(this, [{ _tag: "FocusAudio", tile: slot }]),
      Promote: ({ slot }) => DisplayStep.of(this, [{ _tag: "Promote", tile: slot }]),
      NextLayout: () => DisplayStep.of(this, [{ _tag: "SetLayout", layout: Layout.next(screen.layout) }]),
      FullScreen: () => DisplayStep.of(this)
    })
  }

  /** Selects a slot on screen, ending interacting when the slot changes. A slot past the last is ignored. */
  select(slot: number, screen: Screen): DisplayStep {
    if (slot < 0 || slot >= screen.onScreen().length) return DisplayStep.of(this)
    const interacting = slot === this.selectedOn(screen) ? this.interacting : undefined
    return DisplayStep.of(new Display({ ...this, selected: slot, interacting }))
  }

  /**
   * Drops a card into the selected slot and picks it: a free game is assigned, a benched one swapped in, and a game
   * on screen is not droppable. Then selects the next empty slot, so the next drop fills it, or keeps the selection
   * when none is left.
   */
  drop(card: StripCard, screen: Screen): DisplayStep {
    const slot = this.selectedOn(screen)
    if (!card.pickable()) return DisplayStep.of(this)
    const { place } = card
    const picked = new Display({ ...this, pick: card.id })
    const { display, commands } = picked.select(screen.nextEmptySlot(slot) ?? slot, screen)
    const placed: ScreenCommand = Place.$is("Bench")(place)
      ? { _tag: "Swap", a: place.tile, b: slot }
      : { _tag: "Assign", tile: slot, game: card.id }
    return DisplayStep.of(display, [placed, ...commands])
  }

  toggleSlate(): Display {
    return new Display({ ...this, slateOpen: !this.slateOpen })
  }

  /** Whether this overlay is the one open. */
  shows(overlay: "Keys" | "Palette"): boolean {
    return Overlay.$is(overlay)(this.overlay)
  }

  /** Opens an overlay, closing any other: at most one is open. */
  open(overlay: "Keys" | "Palette"): Display {
    return new Display({ ...this, overlay: Overlay[overlay]() })
  }

  close(): Display {
    return new Display({ ...this, overlay: Overlay.None() })
  }
}

/** A Display after an input, and the Screen commands the input sends. */
export class DisplayStep extends Data.Class<{
  readonly display: Display
  readonly commands: ReadonlyArray<ScreenCommand>
}> {
  /** `display`, sending `commands`: none unless given. */
  static of(display: Display, commands: ReadonlyArray<ScreenCommand> = []): DisplayStep {
    return new DisplayStep({ display, commands })
  }
}

/** What a person did on a Display: a hotkey, a click, a drop, a command, or an overlay opened or closed. */
export type DisplayInput = Data.TaggedEnum<{
  Pressed: { readonly hotkey: Hotkey }
  Selected: { readonly slot: number }
  VideoPressed: { readonly game: GameId }
  Dropped: { readonly card: StripCard }
  Commanded: { readonly command: ScreenCommand }
  Opened: { readonly overlay: "Keys" | "Palette" }
  Closed: object
  SlateToggled: object
}>
export const DisplayInput = Data.taggedEnum<DisplayInput>()
```

Run: `pnpm vitest run apps/web/src/display/Display.test.ts` — Expected: PASS (old and new tests).

- [ ] **Step 3: Failing tests for `DisplayState`**

`apps/web/src/display/DisplayState.test.ts`:

```ts
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Effect, Queue, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import * as TestWeb from "../TestWeb.ts"
import { DisplayInput } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"

describe("DisplayState", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should keep the next Display an input gives", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const display = yield* Effect.gen(function* () {
        yield* Atom.set(DisplayState.display, DisplayInput.SlateToggled())
        return yield* Atom.get(DisplayState.display)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isFalse(display.slateOpen)
    })
  )

  it.effect("should apply an input's commands to the Screen", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const screen = yield* Effect.gen(function* () {
        yield* Atom.set(DisplayState.display, DisplayInput.Commanded({ command: { _tag: "SetLayout", layout: "Single" } }))
        return yield* TestWeb.until(DisplayScreen.screen, (screen) => screen.layout === "Single")
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(screen.layout, "Single")
    })
  )

  it.effect("should follow the shell's full screen", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell({ fullScreen: Stream.make(true) })

      const on = yield* TestWeb.until(DisplayState.fullScreen, (on) => on).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(on)
    })
  )

  it.effect("should ask the shell for the opposite of full screen when toggled", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell({ fullScreen: Stream.make(true) })

      const call = yield* Effect.gen(function* () {
        yield* TestWeb.until(DisplayState.fullScreen, (on) => on)
        yield* Atom.set(DisplayState.toggleFullScreen, undefined)
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SetFullScreen", on: false })
    })
  )

  it.effect("should toggle full screen for the FullScreen hotkey", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell({ hotkeys: Stream.make({ _tag: "FullScreen" }) })

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.inputs)
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SetFullScreen", on: true })
    })
  )

  it.effect("should press every other hotkey on the Display", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell({ hotkeys: Stream.make({ _tag: "ToggleSlate" }) })

      const display = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.inputs)
        return yield* TestWeb.until(DisplayState.display, (display) => !display.slateOpen)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isFalse(display.slateOpen)
    })
  )

  it.effect("should select the slot of a video the shell says was pressed", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.withTiles(["live", "soon"]))
      const { registry } = yield* TestWeb.withShell({ tilePressed: Stream.make(GameId.make("soon")) })

      const display = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.inputs)
        return yield* TestWeb.until(DisplayState.display, (display) => display.selected === 1)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(display.selected, 1)
    })
  )
})
```

Run: `pnpm vitest run apps/web/src/display/DisplayState.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 4: `DisplayState.ts`**

```ts
import { Hotkey } from "@sportal/api/Hotkey"
import { Effect, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { Shell } from "../shell/Shell.ts"
import { StripCard } from "../slate/StripCard.ts"
import { runtime } from "../WebRuntime.ts"
import { Display, DisplayInput } from "./Display.ts"

/**
 * This Display's local state. An input written to it is applied against the Screen and the slate strip: the next
 * Display is kept, and the step's screen commands go to the Screen.
 */
export const display: Atom.Writable<Display, DisplayInput> = Atom.writable(
  (get) => get(kept),
  (ctx, input: DisplayInput) => {
    const step = ctx.get(kept).apply(input, ctx.get(DisplayScreen.screen), ctx.get(cards))
    ctx.set(kept, step.display)
    step.commands.forEach((command) => ctx.set(DisplayScreen.screen, command))
  }
).pipe(Atom.keepAlive)

/** The slate strip's cards: this Screen's bench, then the live slate. */
export const cards: Atom.Atom<ReadonlyArray<StripCard>> = Atom.make((get) =>
  StripCard.of(get(DisplayScreen.screen), get(LiveStream.live).slate)
)

/** Whether this Display's window is full screen: in the shell the window, in a browser the page. */
export const fullScreen: Atom.Atom<boolean> = runtime
  .atom(
    Stream.unwrap(
      Effect.gen(function* () {
        const shell = yield* Shell
        return shell.fullScreen
      })
    )
  )
  .pipe(
    Atom.map(AsyncResult.getOrElse(() => false)),
    Atom.keepAlive
  )

/** Puts this Display's window in full screen, or out of it. */
export const toggleFullScreen = runtime.fn((_: void, get) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    // Read through the registry, not as a dependency: a dependency would run the toggle again when it lands.
    const on = get.registry.get(fullScreen)

    yield* shell.setFullScreen(!on)
  })
)

/**
 * The hotkeys and video presses the Shell reports, as this Display's inputs; the `FullScreen` hotkey toggles full
 * screen. Mounted once, by the Display.
 */
export const inputs = runtime.atom((get) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const keys = Stream.map(shell.hotkeys, (hotkey) => DisplayInput.Pressed({ hotkey }))
    const videos = Stream.map(shell.tilePressed, (game) => DisplayInput.VideoPressed({ game }))

    yield* Stream.merge(keys, videos).pipe(
      Stream.runForEach((input) =>
        Effect.sync(() => {
          if (DisplayInput.$is("Pressed")(input) && Hotkey.guards.FullScreen(input.hotkey))
            get.set(toggleFullScreen, undefined)
          else get.set(display, input)
        })
      )
    )
  })
)

/** Whether this Display can open the YouTube TV sign-in: only in the shell. */
export const signIn: Atom.Atom<boolean> = runtime
  .atom(
    Effect.gen(function* () {
      const shell = yield* Shell
      return Option.isSome(shell.openSignIn)
    })
  )
  .pipe(Atom.map(AsyncResult.getOrElse(() => false)))

/** Opens the YouTube TV sign-in, when there is one. */
export const openSignIn = runtime.fn((_: void) =>
  Effect.gen(function* () {
    const shell = yield* Shell

    yield* Option.getOrElse(shell.openSignIn, () => Effect.void)
  })
)

const kept = Atom.make(Display.initial).pipe(Atom.keepAlive)
```

If `get.set(toggleFullScreen, undefined)` does not typecheck (the write type of a `runtime.fn` is
`void | Reset | Interrupt`), check `AtomResultFn` in `Atom.d.ts` and pass the value it accepts for a void argument.

Run: `pnpm vitest run apps/web/src/display/DisplayState.test.ts` — Expected: PASS.

- [ ] **Step 5: Views write inputs**

Delete `apps/web/src/display/FullScreen.ts` and `apps/web/src/display/Hotkeys.ts`.

`apps/web/src/display/DisplayView.tsx`:

```tsx
import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Toaster } from "@/design/sonner"
import * as GuideRelay from "../hub/GuideRelay.ts"
import { useScreenRejectionToasts } from "../screen/Rejections.ts"
import { ScreenView } from "../screen/ScreenView.tsx"
import { SlateView } from "../slate/SlateView.tsx"
import { CommandPalette } from "./CommandPalette.tsx"
import { DisplayInput } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"
import { KeysDialog } from "./KeysDialog.tsx"
import { OverlayHost } from "./OverlayHost.tsx"
import { TopBar } from "./TopBar.tsx"

export function DisplayView() {
  const display = useAtomValue(DisplayState.display)
  const input = useAtomSet(DisplayState.display)
  const fullScreen = useAtomValue(DisplayState.fullScreen)
  const closeOverlay = (open: boolean) => {
    if (!open) input(DisplayInput.Closed())
  }
  useAtomMount(DisplayState.inputs)
  useAtomMount(GuideRelay.relay)
  useScreenRejectionToasts()

  return (
    <OverlayHost>
      <div className={`grid h-screen ${fullScreen ? "grid-rows-[1fr]" : "grid-rows-[auto_1fr_auto]"}`}>
        {fullScreen ? null : <TopBar />}
        <ScreenView />
        {fullScreen || !display.slateOpen ? null : <SlateView />}
      </div>
      <KeysDialog open={display.shows("Keys")} onOpenChange={closeOverlay} />
      <CommandPalette open={display.shows("Palette")} onOpenChange={closeOverlay} />
      {/* Top center, inside the 44px top bar strip, so a toast never covers a video: a 5px offset, a compact
          one-line toast, and one toast at a time so none stacks below the bar. */}
      <Toaster
        position="top-center"
        offset={{ top: 5 }}
        mobileOffset={{ top: 5 }}
        visibleToasts={1}
        toastOptions={{ style: { paddingBlock: 6, paddingInline: 12 } }}
      />
    </OverlayHost>
  )
}
```

`apps/web/src/display/TopBar.tsx` — no props; reads atoms:

```tsx
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { Expand, Keyboard, List, LogIn, Minimize2, Shrink, SquareDashed } from "lucide-react"
import { Button } from "@/design/button"
import * as LiveStream from "../hub/LiveStream.ts"
import { LayoutPicker } from "../layout/LayoutPicker.tsx"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { BrandMark, ConnectionPill } from "./Brand.tsx"
import { DisplayInput } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"

/** The strip across the top of a Display: the slate, layout, solo, full screen, and whether the Hub is live. */
export function TopBar() {
  const display = useAtomValue(DisplayState.display)
  const input = useAtomSet(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const cards = useAtomValue(DisplayState.cards)
  const { connection, slate } = useAtomValue(LiveStream.live)
  const fullScreen = useAtomValue(DisplayState.fullScreen)
  const toggleFullScreen = useAtomSet(DisplayState.toggleFullScreen)
  const signIn = useAtomValue(DisplayState.signIn)
  const openSignIn = useAtomSet(DisplayState.openSignIn)
  const soloToggles = display.press({ _tag: "ToggleSolo" }, screen, cards).commands.length > 0
  const live = slate.games.filter(({ snapshot }) => snapshot.progress() === "live").length

  return (
    <header className="flex h-11 items-center gap-4 border-b bg-card/60 px-3">
      <BrandMark />
      <span className="h-5 w-px bg-border" />
      <Button
        variant="ghost"
        size="sm"
        aria-keyshortcuts="S"
        aria-pressed={display.slateOpen}
        className={`label-caps text-xs ${display.slateOpen ? "bg-accent" : ""}`}
        onClick={() => input(DisplayInput.SlateToggled())}
      >
        <List />
        Slate
        {live > 0 && (
          <span className="flex items-center gap-1 font-mono text-live">
            <span className="size-1.5 rounded-full bg-live" />
            {live}
          </span>
        )}
        <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">S</kbd>
      </Button>
      <span className="h-5 w-px bg-border" />

      <LayoutPicker current={screen.layout} />

      <Button
        variant="ghost"
        size="sm"
        className="label-caps text-xs"
        aria-keyshortcuts="F"
        disabled={!soloToggles}
        onClick={() => input(DisplayInput.Pressed({ hotkey: { _tag: "ToggleSolo" } }))}
      >
        {Option.isNone(screen.solo) ? <SquareDashed /> : <Shrink />}
        {Option.isNone(screen.solo) ? "Solo" : "Unsolo"}
        <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">F</kbd>
      </Button>

      <div className="ml-auto flex items-center gap-3">
        {signIn && (
          <Button
            variant="ghost"
            size="sm"
            className="label-caps text-xs text-muted-foreground"
            onClick={() => openSignIn(undefined)}
          >
            <LogIn />
            YouTube TV
          </Button>
        )}
        <ConnectionPill connection={connection} />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Keys"
          aria-keyshortcuts="?"
          title="Keys · ?"
          className="text-muted-foreground"
          onClick={() => input(DisplayInput.Opened({ overlay: "Keys" }))}
        >
          <Keyboard />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Full screen"
          aria-keyshortcuts="F11"
          title="Full screen · F11"
          onClick={() => toggleFullScreen(undefined)}
        >
          {fullScreen ? <Minimize2 /> : <Expand />}
        </Button>
      </div>
    </header>
  )
}
```

`apps/web/src/display/CommandPalette.tsx` — props shrink to `open`/`onOpenChange`; it reads atoms. The top of the
component becomes:

```tsx
export function CommandPalette(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const input = useAtomSet(DisplayState.display)
  const toggleFullScreen = useAtomSet(DisplayState.toggleFullScreen)
  const display = useAtomValue(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const { slate } = useAtomValue(LiveStream.live)
  const selected = display.selectedOn(screen)
  const run = (command: ScreenCommand) => {
    input(DisplayInput.Commanded({ command }))
    props.onOpenChange(false)
  }
  const snapshots = slate.games.map(({ snapshot }) => snapshot)
  const occupied = screen.onScreen().flatMap((tile, slot) => {
    if (Tile.guards.Empty(tile)) return []
    const name = Option.match(slate.gameOf(tile.game), {
      onNone: () => `Tile ${slot + 1}`,
      onSome: ({ snapshot }) => snapshot.scoreline()
    })
    return [{ slot, name }]
  })
```

In the JSX: `props.selected` → `selected`, `props.screen` → `screen`; the Full screen item's `onSelect` calls
`toggleFullScreen(undefined)` then `props.onOpenChange(false)`; the Keys item's `onSelect` is
`() => input(DisplayInput.Opened({ overlay: "Keys" }))`. The Watch item keeps
`run({ _tag: "Assign", tile: selected, game: game.id })` (no behaviour change; see the spec's follow-ups). Imports:
`useAtomSet, useAtomValue` from `@effect/atom-react`; `* as LiveStream` from `../hub/LiveStream.ts`;
`* as DisplayScreen` from `../screen/DisplayScreen.ts`; `{ DisplayInput }` from `./Display.ts`;
`* as DisplayState` from `./DisplayState.ts`; drop the `Game`, `GameId`, `Screen`, and `Slate` type imports that are
now unused.

`apps/web/src/slate/SlateView.tsx` — no props:

```tsx
export function SlateView() {
  const display = useAtomValue(DisplayState.display)
  const input = useAtomSet(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const cards = useAtomValue(DisplayState.cards)
  const pick = display.pick
  const rowRef = useRef<HTMLOListElement | null>(null)
```

and in the JSX: `props.cards` → `cards`, `props.display.selectedOn(props.screen)` → `display.selectedOn(screen)`;
drop the `dropped` const; the card is

```tsx
                  <Card
                    card={card}
                    picked={pick === card.id}
                    onDrop={() => input(DisplayInput.Dropped({ card }))}
                  />
```

and `Card` takes `{ card: StripCard; picked: boolean; onDrop: () => void }` with `disabled={!props.card.pickable()}`.
Drop the restating comment "The pick stays in view as it steps along."; keep the others. Imports: the atom hooks,
`DisplayInput` from `../display/Display.ts`, `* as DisplayState` from `../display/DisplayState.ts`,
`* as DisplayScreen` from `../screen/DisplayScreen.ts`; drop `Display`, `DisplayStep`, `Screen` type imports.

`apps/web/src/layout/LayoutPicker.tsx`: `const input = useAtomSet(DisplayState.display)` in place of the screen
dispatch; `onValueChange` sends `input(DisplayInput.Commanded({ command: { _tag: "SetLayout", layout } }))`.

`apps/web/src/screen/TileChrome.tsx`: replace the screen dispatch with `const input = useAtomSet(DisplayState.display)`;
drop the `onSelect` prop; the select button's `onClick` is `() => input(DisplayInput.Selected({ slot }))`; the drop
handler sends `input(DisplayInput.Commanded({ command: { _tag: "Swap", a: from, b: slot } }))`; each action button's
`onClick` sends `input(DisplayInput.Commanded({ command: action.command }))`.

`apps/web/src/screen/ScreenView.tsx` — props go; it reads atoms and keeps its placement sync until Task 9:
- Props removed; at the top of the component:

```tsx
  const screen = useAtomValue(DisplayScreen.screen)
  const display = useAtomValue(DisplayState.display)
  const input = useAtomSet(DisplayState.display)
  const { slate } = useAtomValue(LiveStream.live)
  const selected = display.selectedOn(screen)
  const interacting = display.interactingOn(screen)
```

- `props.screen` → `screen`, `props.slate` → `slate`, `props.selected` → `selected`, `props.interacting` →
  `interacting`.
- Delete the `onTilePressed` effect (the `inputs` atom sends `VideoPressed`).
- `<TileChrome …>` loses `onSelect`.
- Dividers' `onDrop` sends `input(DisplayInput.Commanded({ command: { _tag: "SetSplit", split } }))` after
  `setDragged(undefined)` (unchanged order for now; Task 9 reorders it).

- [ ] **Step 6: Check and commit**

Run: `pnpm check` — Expected: PASS.

```bash
git add -A
git commit -m "feat: the Display is an atom of inputs; hotkeys and full screen come from the Shell

Views read atoms and write DisplayInputs; no view writes the screen atom. FullScreen.ts and
Hotkeys.ts go. Display.test.ts keeps every test; adds Display#apply.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Tile placements as atoms

**Files:**
- Modify: `apps/web/src/screen/TileRects.ts`, `apps/web/src/screen/TileRects.test.ts`
- Create: `apps/web/src/screen/TilePlacements.ts`, `apps/web/src/screen/TilePlacements.test.ts`
- Modify: `apps/web/src/screen/ScreenView.tsx`, `apps/web/src/screen/Dividers.tsx`, `apps/web/src/screen/TileChrome.tsx`,
  `apps/web/src/display/OverlayHost.tsx`, `apps/web/src/display/DisplayView.tsx`

**Interfaces:**
- Consumes: `DisplayState.display` (Task 8), `Shell.syncTiles` (Task 7).
- Produces: `TileRects` as a namespace module (`import * as TileRects`), its rectangles typed `TileBounds`;
  `TilePlacements.area: Atom.Writable<TileBounds>`, `TilePlacements.dragged: Atom.Writable<Option<Split>>`,
  `TilePlacements.shown: Atom<Screen>`, `TilePlacements.rects: Atom<ReadonlyArray<TileBounds>>`,
  `TilePlacements.placements: Atom<ReadonlyArray<TilePlacement>>`, `TilePlacements.screenTransition`,
  `TilePlacements.sync` (mounted).

- [ ] **Step 1: `TileRects.ts` speaks `TileBounds`**

In `apps/web/src/screen/TileRects.ts`, `import type { TileBounds, TilePlacement } from "@sportal/api/ShellBridge"`
and write every `{ x: number; y: number; width: number; height: number }` as `TileBounds`:
`tileRects(…): ReadonlyArray<TileBounds>`, `placements(screen, rects: ReadonlyArray<TileBounds>, …)`,
`coveredGames(overlays: ReadonlyArray<TileBounds>, videos: ReadonlyArray<{ game: GameId; bounds: TileBounds }>)`,
`videoBounds(rect: TileBounds)`, `overlaps(a: TileBounds, b: TileBounds)`, `inset(rect: TileBounds)`. Importers switch
to the namespace: `import * as TileRects from "./TileRects.ts"` (TileRects.test.ts, ScreenView.tsx, Dividers.tsx,
TileChrome.tsx, OverlayHost.tsx), writing `TileRects.tileRects`, `TileRects.placements`, `TileRects.coveredGames`,
`TileRects.gap`, `TileRects.tileHeader`. Test names and assertions are unchanged.

- [ ] **Step 2: Failing tests for `TilePlacements.sync`**

`apps/web/src/screen/TilePlacements.test.ts`:

```ts
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Option, Queue } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import { DisplayInput } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import * as TestWeb from "../TestWeb.ts"
import * as TilePlacements from "./TilePlacements.ts"

describe("TilePlacements.sync", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should tell the shell nothing until the area has a size, then its placements", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(TilePlacements.sync)
        yield* Atom.set(TilePlacements.area, sized)
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(call._tag, "SyncTiles")
      assert.deepStrictEqual(call._tag === "SyncTiles" && call.placements.map(({ game }) => game), [TestWeb.bama])
    })
  )

  it.effect("should move the views along the transition when the arrangement changes", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama, TestWeb.irish]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(TilePlacements.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Queue.take(calls)
        yield* Atom.set(DisplayState.display, DisplayInput.Commanded({ command: { _tag: "Swap", a: 0, b: 1 } }))
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(
        call._tag === "SyncTiles" && call.transition,
        Option.some(TilePlacements.screenTransition)
      )
    })
  )

  it.effect("should move the views at once on a resize", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(TilePlacements.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Queue.take(calls)
        yield* Atom.set(TilePlacements.area, { ...sized, width: 1200 })
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call._tag === "SyncTiles" && call.transition, Option.none())
    })
  )

  it.effect("should move the views at once while a divider is dragged", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(TilePlacements.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Queue.take(calls)
        yield* Atom.set(TilePlacements.dragged, Option.some({ x: 0.3, y: 0.5 }))
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call._tag === "SyncTiles" && call.transition, Option.none())
    })
  )

  it.effect("should tell the shell nothing when the placements are unchanged", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(TilePlacements.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Queue.take(calls)
        yield* Atom.set(TilePlacements.area, { ...sized })
        yield* Atom.set(TilePlacements.area, { ...sized, width: 1200 })
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(
        call._tag === "SyncTiles" && call.placements[0]?.bounds.width,
        // Quad at 1200 wide: half the width less the gap.
        594
      )
    })
  )
})

const sized = { x: 0, y: 44, width: 1600, height: 900 }
```

Run: `pnpm vitest run apps/web/src/screen/TilePlacements.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: `TilePlacements.ts`**

```ts
import { type ScreenTransition, type TileBounds, TilePlacement } from "@sportal/api/ShellBridge"
import { Effect, Option, Schema, Stream } from "effect"
import { Atom } from "effect/reactivity"
import * as DisplayState from "../display/DisplayState.ts"
import { Shell } from "../shell/Shell.ts"
import { runtime } from "../WebRuntime.ts"
import * as DisplayScreen from "./DisplayScreen.ts"
import { type Screen, type Split, Tile } from "./Screen.ts"
import * as TileRects from "./TileRects.ts"

/** The Screen area's size and its place in the window, as the Screen view last measured it. */
export const area: Atom.Writable<TileBounds> = Atom.make<TileBounds>({ x: 0, y: 0, width: 0, height: 0 }).pipe(
  Atom.keepAlive
)

/** The split a divider is being dragged to, until its drop commits it. */
export const dragged: Atom.Writable<Option.Option<Split>> = Atom.make<Option.Option<Split>>(Option.none()).pipe(
  Atom.keepAlive
)

/** The Screen as shown: the dragged split in place of its own. */
export const shown: Atom.Atom<Screen> = Atom.make((get) => {
  const screen = get(DisplayScreen.screen)
  return Option.match(get(dragged), { onNone: () => screen, onSome: (split) => screen.withSplit(split) })
})

/** Each on-screen tile's rectangle in the Screen area, as shown. */
export const rects: Atom.Atom<ReadonlyArray<TileBounds>> = Atom.make((get) => TileRects.tileRects(get(shown), get(area)))

/** What the shell must show for each stream tile with a size, as shown. */
export const placements: Atom.Atom<ReadonlyArray<TilePlacement>> = Atom.make((get) => {
  const screen = get(DisplayScreen.screen)
  const interacting = get(DisplayState.display).interactingOn(screen)
  return TileRects.placements(get(shown), get(rects), get(area), interacting)
})

/** How tiles move when the Screen's arrangement changes; the shell moves the video along the same curve. */
export const screenTransition: ScreenTransition = { durationMs: 280, easing: [0.2, 0, 0, 1] }

/**
 * Tells the shell each changed set of placements, so a re-render never cuts a transition short. A change of
 * arrangement moves the views along the Screen transition; a resize or a drag moves them at once. Nothing is told
 * while the area has no size. Mounted once, by the Display.
 */
export const sync = runtime.atom((get) =>
  Effect.gen(function* () {
    const shell = yield* Shell

    yield* get.stream(pending).pipe(
      Stream.filter(({ sized }) => sized),
      Stream.changesWith((a, b) => samePlacements(a.placements, b.placements)),
      Stream.mapAccum(
        () => Option.none<Screen>(),
        (last, next) => {
          const moved = Option.exists(last, (screen) => !sameArrangement(screen, next.screen)) && !next.dragging
          const transition = moved ? Option.some(screenTransition) : Option.none<ScreenTransition>()
          return [Option.some(next.screen), [{ placements: next.placements, transition }]] as const
        }
      ),
      Stream.runForEach(({ placements, transition }) => shell.syncTiles(placements, transition))
    )
  })
)

/** What a sync reads: the placements, the Screen they arrange (without a dragged split), and whether one is dragged. */
const pending = Atom.make((get) => ({
  placements: get(placements),
  screen: get(DisplayScreen.screen),
  dragging: Option.isSome(get(dragged)),
  sized: get(area).width > 0
}))

/** Whether two Screens put tiles in the same places: the layout, its split, solo, and the game in each slot. */
function sameArrangement(a: Screen, b: Screen): boolean {
  const split = a.splits[a.layout]
  const other = b.splits[b.layout]
  const games = gamesIn(a)
  const others = gamesIn(b)
  return (
    a.layout === b.layout &&
    split.x === other.x &&
    split.y === other.y &&
    Option.getOrUndefined(a.solo) === Option.getOrUndefined(b.solo) &&
    games.length === others.length &&
    games.every((game, slot) => game === others[slot])
  )
}

function gamesIn(screen: Screen) {
  return screen.onScreen().map((tile) => (Tile.guards.Empty(tile) ? undefined : tile.game))
}

const samePlacements = Schema.toEquivalence(Schema.Array(TilePlacement))
```

Run: `pnpm vitest run apps/web/src/screen/TilePlacements.test.ts` — Expected: PASS.

- [ ] **Step 4: ScreenView measures and renders; Dividers drag through atoms**

Replace `apps/web/src/screen/ScreenView.tsx`:

```tsx
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { useCallback } from "react"
import * as DisplayState from "../display/DisplayState.ts"
import { useVideoAreas } from "../display/OverlayHost.tsx"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "./DisplayScreen.ts"
import { Dividers } from "./Dividers.tsx"
import { Tile } from "./Screen.ts"
import { TileBody } from "./TileBody.tsx"
import { TileChrome } from "./TileChrome.tsx"
import * as TilePlacements from "./TilePlacements.ts"

/**
 * The Screen: each on-screen tile positioned from the layout, with the shell's provider views laid over their
 * wells at the same pixels. When tiles move, the chrome and the video move together along one transition.
 */
export function ScreenView() {
  const screen = useAtomValue(DisplayScreen.screen)
  const shown = useAtomValue(TilePlacements.shown)
  const rects = useAtomValue(TilePlacements.rects)
  const placements = useAtomValue(TilePlacements.placements)
  const dragging = Option.isSome(useAtomValue(TilePlacements.dragged))
  const display = useAtomValue(DisplayState.display)
  const { slate } = useAtomValue(LiveStream.live)
  const selected = display.selectedOn(screen)
  const areaRef = useArea()
  useVideoAreas(placements)

  return (
    <main ref={areaRef} className="relative min-h-0 overflow-hidden bg-background">
      {shown.onScreen().map((tile, index) => {
        const rect = rects[index]
        if (rect === undefined) return null
        const game = Tile.guards.Empty(tile) ? undefined : Option.getOrUndefined(slate.gameOf(tile.game))
        const hidden = rect.width === 0

        return (
          <section
            key={Tile.guards.Empty(tile) ? `slot-${index}` : tile.game}
            aria-hidden={hidden}
            className={`absolute flex flex-col overflow-hidden rounded-sm border ${
              selected === index ? "border-foreground/60" : "border-border"
            } ${hidden ? "pointer-events-none opacity-0" : ""}`}
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              transition: dragging ? undefined : cssTransition
            }}
          >
            <TileChrome
              screen={screen}
              slot={index}
              tile={tile}
              game={game?.snapshot}
              selected={selected === index}
            />
            <div className="flex min-h-0 flex-1 items-center justify-center bg-well">
              <TileBody tile={tile} game={game} />
            </div>
          </section>
        )
      })}
      {Option.isNone(shown.solo) && <Dividers layout={shown.layout} split={shown.splits[shown.layout]} />}
    </main>
  )
}

const cssTransition = ["left", "top", "width", "height", "opacity"]
  .map(
    (property) =>
      `${property} ${TilePlacements.screenTransition.durationMs}ms cubic-bezier(${TilePlacements.screenTransition.easing.join(",")})`
  )
  .join(", ")

/** A ref for the Screen area's element: its size and place in the window go to `TilePlacements.area` as they change. */
function useArea() {
  const setArea = useAtomSet(TilePlacements.area)
  return useCallback(
    (element: HTMLElement | null) => {
      if (element === null) return undefined
      const measure = () => {
        const { x, y, width, height } = element.getBoundingClientRect()
        setArea((last) =>
          last.x === x && last.y === y && last.width === width && last.height === height
            ? last
            : { x, y, width, height }
        )
      }
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      window.addEventListener("resize", measure)
      return () => {
        observer.disconnect()
        window.removeEventListener("resize", measure)
      }
    },
    [setArea]
  )
}
```

(`useVideoAreas` stays until Task 10 removes OverlayHost.)

Replace `apps/web/src/screen/Dividers.tsx`'s signature and handlers:

```tsx
export function Dividers(props: { layout: LayoutName; split: Split }) {
  const area = useAtomValue(TilePlacements.area)
  const setDragged = useAtomSet(TilePlacements.dragged)
  const input = useAtomSet(DisplayState.display)
  const dragging = useRef<Split | undefined>(undefined)

  return Layout.dividers(props.layout).map((axis) => {
    const at = props.split[axis] * (axis === "x" ? area.width : area.height)
```

```tsx
        onPointerMove={(event) => {
          if (dragging.current === undefined) return
          const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
          if (bounds === undefined) return
          const fraction =
            axis === "x"
              ? (event.clientX - bounds.x) / bounds.width
              : (event.clientY - bounds.y) / bounds.height
          const split = Layout.clamp({ ...dragging.current, [axis]: fraction })
          dragging.current = split
          setDragged(Option.some(split))
        }}
        onPointerUp={() => {
          const split = dragging.current
          dragging.current = undefined
          if (split === undefined) return
          // Committed before the drag is cleared, so the shown split never falls back to the old one in between.
          input(DisplayInput.Commanded({ command: { _tag: "SetSplit", split } }))
          setDragged(Option.none())
        }}
```

Update its doc comment: "Drag handles in the gaps between tiles, one per divider the layout uses. While dragging, the
split is shown through `TilePlacements.dragged`; on release it is committed to the Screen." Imports: atom hooks,
`Option` from `effect`, `DisplayInput` from `../display/Display.ts`, `* as DisplayState` from
`../display/DisplayState.ts`, `* as TilePlacements` from `./TilePlacements.ts`, `* as TileRects` from `./TileRects.ts`
(for `TileRects.gap`).

`apps/web/src/display/DisplayView.tsx`: import `* as TilePlacements from "../screen/TilePlacements.ts"` and mount
`useAtomMount(TilePlacements.sync)` beside the others.

- [ ] **Step 5: Check and commit**

Run: `pnpm check` — Expected: PASS.

```bash
git add -A
git commit -m "feat: tile placements are atoms; one sync tells the shell what changed

TileRects is pure geometry in TileBounds; TilePlacements holds the area, the dragged split, the
placements and their sync. ScreenView measures and renders. TileRects.test.ts: every test kept.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Covering as atoms; OverlayHost goes

**Files:**
- Create: `apps/web/src/display/Covering.ts`, `apps/web/src/display/Covering.test.ts`, `apps/web/src/display/OverlayRef.ts`
- Delete: `apps/web/src/display/OverlayHost.tsx`
- Modify: `apps/web/src/design/dialog.tsx`, `apps/web/src/display/DisplayView.tsx`, `apps/web/src/screen/ScreenView.tsx`

**Interfaces:**
- Consumes: `TilePlacements.placements` (Task 9), `TileRects.coveredGames`, `Shell.setHidden`.
- Produces: `Covering.overlays: Atom.Writable<ReadonlyMap<string, TileBounds>>`, `Covering.sync` (mounted);
  `useOverlayRef(): (element: HTMLElement | null) => (() => void) | undefined`.

- [ ] **Step 1: Failing tests**

`apps/web/src/display/Covering.test.ts`:

```ts
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Queue } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import * as TilePlacements from "../screen/TilePlacements.ts"
import * as TestWeb from "../TestWeb.ts"
import * as Covering from "./Covering.ts"

describe("Covering.sync", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should hide the videos an open overlay covers", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama, TestWeb.irish]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(Covering.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Atom.set(Covering.overlays, new Map([["palette", overMain]]))
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SetHidden", games: [TestWeb.bama] })
    })
  )

  it.effect("should show the videos again once the overlay closes", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama, TestWeb.irish]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(Covering.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Atom.set(Covering.overlays, new Map([["palette", overMain]]))
        yield* Queue.take(calls)
        yield* Atom.set(Covering.overlays, new Map())
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SetHidden", games: [] })
    })
  )

  it.effect("should tell the shell nothing while what is hidden is unchanged", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.fill([TestWeb.bama, TestWeb.irish]))
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(Covering.sync)
        yield* Atom.set(TilePlacements.area, sized)
        yield* Atom.set(Covering.overlays, new Map([["palette", overMain]]))
        yield* Queue.take(calls)
        yield* Atom.set(Covering.overlays, new Map([["palette", { ...overMain, width: 201 }]]))
        yield* Atom.set(Covering.overlays, new Map())
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SetHidden", games: [] })
    })
  )
})

const sized = { x: 0, y: 0, width: 1600, height: 900 }

/** A palette over the main tile's video only (the main tile's video is below its 28px header, left of x 800). */
const overMain = { x: 100, y: 100, width: 200, height: 200 }
```

Run: `pnpm vitest run apps/web/src/display/Covering.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: `Covering.ts`**

```ts
import type { TileBounds } from "@sportal/api/ShellBridge"
import type { GameId } from "@sportal/domain/Game"
import { Effect, Stream } from "effect"
import { Atom } from "effect/reactivity"
import * as TilePlacements from "../screen/TilePlacements.ts"
import * as TileRects from "../screen/TileRects.ts"
import { Shell } from "../shell/Shell.ts"
import { runtime } from "../WebRuntime.ts"

/** Each open overlay's rectangle in the window, by the overlay. */
export const overlays: Atom.Writable<ReadonlyMap<string, TileBounds>> = Atom.make<ReadonlyMap<string, TileBounds>>(
  new Map()
).pipe(Atom.keepAlive)

/**
 * Where overlays meet native video. Provider views draw above the web UI, so an overlay over a video would be hidden
 * behind it: the shell hides exactly the videos an open overlay covers, until it closes. Nothing is told until
 * something is covered. Mounted once, by the Display.
 */
export const sync = runtime.atom((get) =>
  Effect.gen(function* () {
    const shell = yield* Shell

    yield* get.stream(hidden).pipe(
      Stream.mapAccum(
        (): ReadonlyArray<GameId> => [],
        (last, next) => (sameGames(last, next) ? [last, []] : [next, [next]])
      ),
      Stream.runForEach(shell.setHidden)
    )
  })
)

const hidden = Atom.make((get) => TileRects.coveredGames([...get(overlays).values()], get(TilePlacements.placements)))

function sameGames(a: ReadonlyArray<GameId>, b: ReadonlyArray<GameId>): boolean {
  return a.length === b.length && a.every((game, index) => game === b[index])
}
```

If `Stream.mapAccum`'s callback must return `readonly [state, ReadonlyArray<out>]` with `as const`, add it — the
signature in `Stream.d.ts` (line ~10209) is the reference.

- [ ] **Step 3: `OverlayRef.ts`**

```ts
import { useAtomSet } from "@effect/atom-react"
import { useCallback, useId } from "react"
import * as Covering from "./Covering.ts"

/**
 * A ref for an overlay's content, which mounts only while the overlay is open: while the element is mounted, the
 * videos it covers hide. React runs the returned cleanup when the element unmounts.
 */
export function useOverlayRef() {
  const key = useId()
  const setOverlays = useAtomSet(Covering.overlays)
  return useCallback(
    (element: HTMLElement | null) => {
      if (element === null) return undefined
      const measure = () => {
        const { x, y, width, height } = element.getBoundingClientRect()
        setOverlays((all) => new Map(all).set(key, { x, y, width, height }))
      }
      // An overlay grows into place with an animation, which a resize observer does not see.
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      element.addEventListener("animationend", measure)
      measure()
      return () => {
        observer.disconnect()
        element.removeEventListener("animationend", measure)
        setOverlays((all) => {
          const rest = new Map(all)
          rest.delete(key)
          return rest
        })
      }
    },
    [key, setOverlays]
  )
}
```

- [ ] **Step 4: Wire it; delete OverlayHost**

- `apps/web/src/design/dialog.tsx`: `import { useOverlayRef } from "@/display/OverlayRef"`; in `DialogContent`,
  `const covering = useOverlayRef()` (keep the `// Sportal:` comment and `ref={covering}`).
- `apps/web/src/display/DisplayView.tsx`: drop the `OverlayHost` import and wrapper (the root becomes a fragment
  `<>…</>`); import `* as Covering from "./Covering.ts"` and add `useAtomMount(Covering.sync)`.
- `apps/web/src/screen/ScreenView.tsx`: drop `useVideoAreas`, its import, and the `placements` read it used.
- `git rm apps/web/src/display/OverlayHost.tsx`.

- [ ] **Step 5: Check and commit**

Run: `pnpm vitest run apps/web/src/display/Covering.test.ts` — Expected: PASS.
Run: `pnpm check` — Expected: PASS.

```bash
git add -A
git commit -m "feat: overlay covering is atoms; OverlayHost and its context go

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Glossary

**Files:**
- Modify: `CONTEXT.md`

- [ ] **Step 1: CONTEXT.md**

Add rows to the main table (beside the Display rows), in the file's voice:

```markdown
| **Display input** | What a person did on a Display: a hotkey, a click on a tile or a video, a slate card dropped, a screen command, or an overlay opened or closed; `DisplayInput` in `apps/web/src/display/Display.ts`. Written to the Display's atom (`DisplayState.display`), which applies it and sends its screen commands to the Screen. | action, event |
| **Slot** | A place in a layout: a rectangle as fractions of the Screen area; `Slot` in `apps/web/src/layout/Layout.ts`. | rect, cell |
| **Shell** | The web UI's edge to its window and the shell bridge: page and stream hotkeys, full screen, presses on a video, the guide the shell reads, and the calls that place and hide videos; `Shell` in `apps/web/src/shell/Shell.ts`, the one reader of `window.sportalShell`. | bridge, native |
| **Field drawing** | Which plays a tile's field has drawn: settled after a play, or animating one with the newest few queued; `FieldDrawing` in `apps/web/src/game/FieldDrawing.ts`, moved by `FieldEvent`s (plays arrived, a play drawn). | animation state |
| **Field event** | What a field's drawing hears: plays arrived from the Hub, or a play finished drawing; `FieldEvent` beside `FieldDrawing`. | |
```

Update existing rows:
- **Hub client**: "…`HubClient` in code. It runs in the web UI's one runtime (`WebRuntime.ts`), beside the Shell."
- **Tile bounds**: "A rectangle in whole CSS pixels: a tile's within the Screen area, or a tile view's within the
  window; `TileBounds` in code."
- **Display**: append "Its local state is the `DisplayState.display` atom."
- **Strip card**: unchanged unless it names `StripCards.ts` (it does not today).

- [ ] **Step 2: Check and commit**

Run: `pnpm check` — Expected: PASS.

```bash
git add -A
git commit -m "docs: glossary for Display input, Slot, Shell, Field drawing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Final check and the user's eye-check

- [ ] **Step 1: No stragglers**

```bash
grep -rn "sportalShell" apps/web/src --include=*.ts --include=*.tsx | grep -v "shell/Shell.ts"
grep -rn "useAtomSet(DisplayScreen.screen)\|runFork\|ManagedRuntime\|JSON.stringify" apps/web/src --include=*.ts --include=*.tsx | grep -v "\.test\.ts\|TestWeb.ts"
```

Expected: no output from either.

- [ ] **Step 2: `pnpm check`**

Expected: PASS.

- [ ] **Step 3: Hand the user the eye-check**

Agent-launched Electron misreports on this machine; ask the user to run `pnpm dev` and confirm:
1. Hotkeys work on the page and while a video has focus (S, F, I, [ ], Enter, Ctrl+K, ?, 1–6, Shift+digit, Alt+digit).
2. Typing in the command palette's field does not trigger hotkeys; Ctrl+K still closes it.
3. Clicking a video selects its tile.
4. A layout change or a swap animates; a window resize and a divider drag move the videos at once; releasing a drag
   does not jump.
5. The palette and the keys dialog hide the videos under them and bring them back on close.
6. Full screen (F11 and the button) in the shell and in a plain browser.
7. Restart the Hub: the guide is read again once it is back (the Hub log shows a guide read).
8. Reload: the Screen is as it was.
9. The YouTube TV button shows in the shell and not in a plain browser.
