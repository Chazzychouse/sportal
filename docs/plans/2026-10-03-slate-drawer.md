# Slate Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the always-on slate sidebar with a drawer summoned over the Stage, whose rows align in fixed columns and are grouped by status, with games already on the Stage or Bench marked.

**Architecture:** The domain gains `GameSnapshot.progress()` (upcoming, live, over), and `watchOrder` is rebuilt on it so sections and order agree. A new `ToggleSlate` hotkey (`S`) joins the shared hotkey table. The web UI adds shadcn's `sheet` primitive (registered with the overlay host like `dialog`), turns `slate/SlateView.tsx` into the drawer with the bench folded in, deletes `stage/Bench.tsx`, and gives the Stage the full window.

**Tech Stack:** TypeScript, Effect 4 (`Schema.Class`, `Order`), React 19, Radix via shadcn (`radix-ui`), Tailwind 4, Vitest via `@effect/vitest`.

Spec: `docs/specs/2026-10-03-slate-drawer-design.md`.

## Global Constraints

- Read `AGENTS.md` first. Main export first in each file; private helpers below, as hoisted `function` declarations; no options-bag or props type aliases; no `any`, no non-null assertions, no enums, no default exports.
- `apps/web/src/design/` holds only shadcn primitives under the CLI's file names.
- No mirror types and no `GameRow`-style names. The row is a private component in `SlateView.tsx`.
- Domain logic is written test-first. Tests sit beside the file as `Name.test.ts`.
- `pnpm check` must pass before every commit (the commit hook runs lint; the push hook runs `pnpm check`).
- Do not launch Electron to judge rendering; the user runs the shell (agent-launched Electron misreports rendering on this machine).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: `GameSnapshot.progress()` and `watchOrder` built on it

**Files:**
- Modify: `packages/domain/src/Game.ts:42-53`
- Test: `packages/domain/src/Game.test.ts`

**Interfaces:**
- Produces: `GameSnapshot#progress(): "upcoming" | "live" | "over"`. `live` and `halftime` are live; `scheduled` and `delayed` are upcoming; `final`, `postponed`, `canceled` are over. `GameSnapshot.watchOrder` unchanged in behaviour.

- [ ] **Step 1: Write the failing test**

Add to `packages/domain/src/Game.test.ts`, between the `isLive` and `watchOrder` describes:

```ts
describe("GameSnapshot.progress", () => {
  it.each([
    ["scheduled", "upcoming"],
    ["delayed", "upcoming"],
    ["live", "live"],
    ["halftime", "live"],
    ["final", "over"],
    ["postponed", "over"],
    ["canceled", "over"]
  ] as const)("is %s → %s", (status, progress) => {
    assert.strictEqual(snapshot({ status }).progress(), progress)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/domain/src/Game.test.ts`
Expected: FAIL — `progress is not a function` (and a type error in the editor).

- [ ] **Step 3: Implement**

In `packages/domain/src/Game.ts`, replace the `watchOrder` static and add `progress` after `isLive`:

```ts
  /** Live games first, then upcoming by kickoff, then everything that is over. */
  static readonly watchOrder: Order.Order<GameSnapshot> = Order.combine(
    Order.mapInput(Order.Number, (game: GameSnapshot) => progressRank[game.progress()]),
    Order.mapInput(DateTime.Order, (game: GameSnapshot) => game.kickoff)
  )

  isLive(): boolean {
    return this.status === "live" || this.status === "halftime"
  }

  /** Where the game is in its day: not started (or delayed), being played, or done with (final, postponed, canceled). */
  progress(): "upcoming" | "live" | "over" {
    if (this.isLive()) return "live"
    return this.status === "scheduled" || this.status === "delayed" ? "upcoming" : "over"
  }
}

const progressRank = { live: 0, upcoming: 1, over: 2 } as const
```

`progressRank` sits below the class: the static's arrow only reads it when the order runs, not when the class is defined.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/domain/src/Game.test.ts`
Expected: PASS, including the existing `watchOrder` test unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/Game.ts packages/domain/src/Game.test.ts
git commit -m "feat(domain): a game's progress, and watch order built on it"
```

---

### Task 2: `ToggleSlate` hotkey on `S`

**Files:**
- Modify: `packages/api/src/Hotkey.ts`
- Test: `packages/api/src/Hotkey.test.ts`

**Interfaces:**
- Produces: `Hotkey` union member `{ _tag: "ToggleSlate" }`, read from `KeyS` without Ctrl or Cmd. Task 4 handles it in `App.tsx`. The desktop shell forwards it with no change (it calls `Hotkey.of`).

- [ ] **Step 1: Write the failing test**

In `packages/api/src/Hotkey.test.ts`, in "reads the letter and function keys", after the `KeyL` line:

```ts
    assert.deepStrictEqual(key("KeyS"), { _tag: "ToggleSlate" })
```

and in "leaves every other key…", add:

```ts
    assert.isUndefined(key("KeyS", { control: true }))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/api/src/Hotkey.test.ts`
Expected: FAIL — `expected undefined to deeply equal { _tag: 'ToggleSlate' }`.

- [ ] **Step 3: Implement**

In `packages/api/src/Hotkey.ts`, add to the union after `NextLayout`:

```ts
    Schema.TaggedStruct("ToggleSlate", {}),
```

and to the `switch`, after the `KeyL` case:

```ts
        case "KeyS":
          return { _tag: "ToggleSlate" }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/api/src/Hotkey.test.ts && pnpm typecheck`
Expected: PASS. `App.tsx`'s hotkey `switch` has no exhaustiveness check, so the new member does not break it; Task 4 handles it.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/Hotkey.ts packages/api/src/Hotkey.test.ts
git commit -m "feat(api): S toggles the slate"
```

---

### Task 3: shadcn `sheet` that hides the videos it covers

**Files:**
- Create: `apps/web/src/design/sheet.tsx` (via the shadcn CLI)

**Interfaces:**
- Produces: `Sheet`, `SheetContent` (props: Radix `Dialog.Content` props plus `side?: "top" | "right" | "bottom" | "left"` and `showCloseButton?: boolean`), `SheetTitle`, `SheetDescription`, as the CLI generates them. `SheetContent` registers with `useCovering`.

- [ ] **Step 1: Add the primitive**

Run from `apps/web`: `pnpm dlx shadcn@latest add sheet`
Expected: `src/design/sheet.tsx` created; no other file changed (`git status` shows only that file). If the CLI tries to overwrite an existing primitive, answer no.

- [ ] **Step 2: Register the covering, as `dialog.tsx` does**

In `apps/web/src/design/sheet.tsx`, add the imports:

```ts
import { useRef } from "react"
import { useCovering } from "@/OverlayHost"
```

At the top of the `SheetContent` body, before `return`:

```ts
  // Sportal: the sheet hides the provider videos it covers while it is open.
  const covering = useRef<HTMLDivElement>(null)
  useCovering(covering)
```

and pass `ref={covering}` to `SheetPrimitive.Content`. If the generated `SheetContent` has no `showCloseButton` prop, add it exactly as `dialog.tsx` does: destructure `showCloseButton = true`, add `& { showCloseButton?: boolean }` to the props type, and wrap the generated `SheetPrimitive.Close` block in `{showCloseButton && (…)}`.

- [ ] **Step 3: Check**

Run: `pnpm check`
Expected: PASS (knip ignores unused exports in `src/design/`). If biome reformats the generated file, run `pnpm format` and re-run.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/design/sheet.tsx
git commit -m "feat(web): shadcn sheet that hides the videos it covers"
```

---

### Task 4: The slate drawer, wired into the frame

**Files:**
- Modify: `apps/web/src/slate/SlateView.tsx` (rewrite)
- Delete: `apps/web/src/stage/Bench.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/frame/TopBar.tsx`

**Interfaces:**
- Consumes: `GameSnapshot#progress()` (Task 1), `{ _tag: "ToggleSlate" }` (Task 2), `Sheet`, `SheetContent`, `SheetTitle`, `SheetDescription` (Task 3), `Stage#slotOf`, `Layout.slotCount`, `tileDrag` from `stage/TileChrome.tsx`, `statusText` from `slate/StatusText.ts`, `dispatch` from `hub/HubClient.ts`.
- Produces: `SlateView(props: { open: boolean; onOpenChange: (open: boolean) => void; stage: Stage; slate: ReadonlyArray<GameSnapshot>; selected: number; fullScreen: boolean })`. `TopBar` gains prop `slate: { open: boolean; live: number; toggle: () => void }`. The toggle button carries `data-slate-toggle`.

This task is UI; there is no unit test for it. It is verified by `pnpm check` and by the user running the shell (Step 6).

- [ ] **Step 1: Rewrite `apps/web/src/slate/SlateView.tsx`**

```tsx
import { GameSnapshot } from "@sportal/domain/Game"
import { Layout } from "@sportal/domain/Layout"
import type { Stage } from "@sportal/domain/Stage"
import { ChevronRight } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/design/sheet"
import { dispatch } from "../hub/HubClient.ts"
import { tileDrag } from "../stage/TileChrome.tsx"
import { statusText } from "./StatusText.ts"

/**
 * The slate as a drawer over the Stage's left edge: the bench, then live, upcoming, and final games. Picking a
 * game puts it in the selected tile and closes the drawer. Non-modal, so a bench game can be dragged onto a tile.
 */
export function SlateView(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  stage: Stage
  slate: ReadonlyArray<GameSnapshot>
  selected: number
  fullScreen: boolean
}) {
  const [finalsOpen, setFinalsOpen] = useState(false)
  const first = Layout.slotCount(props.stage.layout)
  const benched = props.stage.tiles.flatMap((tile, index) =>
    index < first || tile._tag === "Empty" ? [] : [{ index, id: tile.game }]
  )
  const placeOf = (game: GameSnapshot) => {
    const slot = props.stage.slotOf(game.id)
    if (slot !== undefined) return `T${slot + 1}`
    return benched.some(({ id }) => id === game.id) ? "Bench" : undefined
  }
  const ordered = [...props.slate].sort(GameSnapshot.watchOrder)
  const inProgress = (progress: ReturnType<GameSnapshot["progress"]>) =>
    ordered.filter((game) => game.progress() === progress)
  const finals = inProgress("over")
  const close = () => props.onOpenChange(false)
  const row = (game: GameSnapshot) => {
    const place = placeOf(game)
    return (
      <li key={game.id}>
        <Matchup
          game={game}
          place={place}
          onClick={
            place === undefined
              ? () => {
                  dispatch({ _tag: "Assign", tile: props.selected, game: game.id })
                  close()
                }
              : undefined
          }
        />
      </li>
    )
  }

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange} modal={false}>
      <SheetContent
        side="left"
        showCloseButton={false}
        // The top bar's Slate button toggles the drawer itself; a press on it is not a click outside.
        onInteractOutside={(event) => {
          if (event.target instanceof Element && event.target.closest("[data-slate-toggle]") !== null)
            event.preventDefault()
        }}
        className={`gap-0 bg-card p-0 sm:max-w-none ${props.fullScreen ? "" : "top-11 h-[calc(100%-2.75rem)]"} w-96`}
      >
        <header className="flex items-baseline justify-between border-b px-3 pt-2.5 pb-1.5">
          <SheetTitle className="label-caps text-[11px] text-muted-foreground">
            Slate <span className="font-mono">{props.slate.length}</span>
          </SheetTitle>
          <SheetDescription className="label-caps text-[11px] text-muted-foreground">
            to tile <span className="font-mono text-foreground">{props.selected + 1}</span>
          </SheetDescription>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {benched.length > 0 && (
            <Section title="Bench" count={benched.length}>
              {benched.map(({ index, id }) => {
                const game = props.slate.find((g) => g.id === id)
                return (
                  <li key={index}>
                    {game === undefined ? (
                      <span className="block px-3 py-1.5 font-mono text-xs text-muted-foreground">
                        Off the slate
                      </span>
                    ) : (
                      <Matchup
                        game={game}
                        place="Bench"
                        dragTile={index}
                        onClick={() => {
                          dispatch({ _tag: "Swap", a: index, b: props.selected })
                          close()
                        }}
                      />
                    )}
                  </li>
                )
              })}
            </Section>
          )}
          <Section title="Live" count={inProgress("live").length}>
            {inProgress("live").map(row)}
          </Section>
          <Section title="Upcoming" count={inProgress("upcoming").length}>
            {inProgress("upcoming").map(row)}
          </Section>
          {finals.length > 0 && (
            <section className="border-t">
              <button
                type="button"
                onClick={() => setFinalsOpen((open) => !open)}
                aria-expanded={finalsOpen}
                className="label-caps flex w-full items-center gap-1 px-3 pt-2.5 pb-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
              >
                <ChevronRight className={`size-3 transition-transform ${finalsOpen ? "rotate-90" : ""}`} />
                Final <span className="font-mono">{finals.length}</span>
              </button>
              {finalsOpen && <ul className="pb-1.5">{finals.map(row)}</ul>}
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Section(props: { title: string; count: number; children: ReactNode }) {
  if (props.count === 0) return null
  return (
    <section className="border-t first:border-t-0">
      <h2 className="label-caps px-3 pt-2.5 pb-1 text-[11px] text-muted-foreground">
        {props.title} <span className="font-mono">{props.count}</span>
      </h2>
      <ul className="pb-1.5">{props.children}</ul>
    </section>
  )
}

/**
 * One game in fixed columns — rank, team, score, status, place — so nothing shifts as names, scores, and
 * clocks change length. A game already on the Stage or the Bench shows where, and is not pickable.
 */
function Matchup(props: { game: GameSnapshot; place: string | undefined; onClick?: () => void; dragTile?: number }) {
  const { game } = props
  const scored = game.isLive() || game.status === "final"
  const networks = game.broadcasts.map(({ network }) => network).join(" · ")
  return (
    <button
      type="button"
      disabled={props.onClick === undefined}
      onClick={props.onClick}
      draggable={props.dragTile !== undefined}
      onDragStart={(event) => event.dataTransfer.setData(tileDrag, String(props.dragTile))}
      className="grid w-full grid-cols-[2ch_5ch_3ch_minmax(0,1fr)_3.25rem] items-baseline gap-x-2 px-3 py-1.5 text-left font-mono text-[13px] tabular-nums transition-colors enabled:hover:bg-accent disabled:cursor-default"
    >
      <Side side={game.away} other={game.home} scored={scored} row="row-start-1" />
      <span
        className={`label-caps col-start-4 row-start-1 truncate text-right text-[11px] ${game.isLive() ? "text-live" : "text-muted-foreground"}`}
      >
        {statusText(game)}
      </span>
      <span className="col-start-5 row-span-2 row-start-1 self-center justify-self-end">
        {props.place !== undefined && (
          <span
            className={`label-caps rounded-sm border px-1 py-px text-[10px] ${props.place === "Bench" ? "text-muted-foreground" : "border-on-air/50 text-on-air"}`}
          >
            {props.place}
          </span>
        )}
      </span>
      <Side side={game.home} other={game.away} scored={scored} row="row-start-2" />
      <span
        className="col-start-4 row-start-2 truncate text-right font-sans text-[11px] text-muted-foreground"
        title={networks}
      >
        {networks}
      </span>
    </button>
  )
}

/** One team's cells: rank, abbreviation, and score. Once scores mean something, the trailing side is muted. */
function Side(props: {
  side: GameSnapshot["home"]
  other: GameSnapshot["home"]
  scored: boolean
  row: "row-start-1" | "row-start-2"
}) {
  const trailing = props.scored && props.side.score < props.other.score
  return (
    <>
      <span className={`col-start-1 ${props.row} text-right text-[10px] text-muted-foreground`}>
        {props.side.ranking}
      </span>
      <span className={`col-start-2 ${props.row} font-semibold ${trailing ? "text-muted-foreground" : ""}`}>
        {props.side.team.abbreviation}
      </span>
      <span className={`col-start-3 ${props.row} text-right ${trailing ? "text-muted-foreground" : ""}`}>
        {props.scored ? props.side.score : null}
      </span>
    </>
  )
}
```

Notes for the implementer:
- `Matchup` and `Side` are private, below their user, in first-use order (AGENTS.md "Inside a file").
- Tailwind 4 must see full class names: `row-start-1` / `row-start-2` are passed whole, never built from a number.
- If biome rejects the `onInteractOutside` single-line `if` without braces, add braces.

- [ ] **Step 2: Delete the old bench**

Run: `git rm apps/web/src/stage/Bench.tsx`

- [ ] **Step 3: Wire `App.tsx`**

In `apps/web/src/App.tsx`:

Remove `import { Bench } from "./stage/Bench.tsx"`.

After `const [palette, setPalette] = useState(false)` add:

```ts
  const [slateOpen, setSlateOpen] = useState(false)
```

In the hotkey `switch`, replace the `Unsolo` case and add `ToggleSlate`:

```ts
      case "Unsolo":
        // Esc closes the open slate first, whether pressed here or in a stream view.
        if (slateOpen) return setSlateOpen(false)
        return live.stage.solo === undefined ? undefined : dispatch({ _tag: "Unsolo" })
      case "ToggleSlate":
        return setSlateOpen((open) => !open)
```

Replace the layout `div` block (the TopBar through `StageView`) with:

```tsx
      <div className={`grid h-screen ${fullScreen.on ? "grid-rows-[1fr]" : "grid-rows-[auto_1fr]"}`}>
        {fullScreen.on ? null : (
          <TopBar
            stage={live.stage}
            connected={live.connected}
            selected={selected}
            fullScreen={fullScreen}
            slate={{
              open: slateOpen,
              live: live.slate.filter((game) => game.isLive()).length,
              toggle: () => setSlateOpen((open) => !open)
            }}
          />
        )}
        <StageView
          stage={live.stage}
          slate={live.slate}
          connected={live.connected}
          selected={selected}
          onSelect={setSelected}
        />
      </div>
      <SlateView
        open={slateOpen}
        onOpenChange={setSlateOpen}
        stage={live.stage}
        slate={live.slate}
        selected={selected}
        fullScreen={fullScreen.on}
      />
```

Replace the Toaster and its comment with:

```tsx
      {/* Top center, over the top bar: a toast never covers a video. */}
      <Toaster position="top-center" />
```

- [ ] **Step 4: Add the Slate button to `TopBar.tsx`**

Add `List` to the `lucide-react` import. Add to the props:

```ts
  slate: { open: boolean; live: number; toggle: () => void }
```

Update the doc comment to: `/** The strip across the top of a Display: the slate, layout, solo, full screen, and whether the Hub is live. */`

Insert between the divider `<span className="h-5 w-px bg-border" />` and the `ToggleGroup`:

```tsx
      <Button
        variant="ghost"
        size="sm"
        data-slate-toggle
        aria-pressed={props.slate.open}
        className={`label-caps text-xs ${props.slate.open ? "bg-accent" : ""}`}
        onClick={props.slate.toggle}
      >
        <List />
        Slate
        {props.slate.live > 0 && (
          <span className="flex items-center gap-1 font-mono text-live">
            <span className="size-1.5 rounded-full bg-live" />
            {props.slate.live}
          </span>
        )}
        <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">S</kbd>
      </Button>
      <span className="h-5 w-px bg-border" />
```

- [ ] **Step 5: Check**

Run: `pnpm check`
Expected: PASS. Watch for: knip flagging nothing new; depcruise allowing `slate/` → `stage/TileChrome.tsx` (it already allowed `stage/Bench.tsx` → `slate/StatusText.ts`, both inside `apps/web`). Fix any biome formatting with `pnpm format`.

- [ ] **Step 6: Commit, then hand to the user to verify in the shell**

```bash
git add -A apps/web/src
git commit -m "feat(web): the slate as a drawer over the Stage, rows in fixed columns, grouped by status"
```

Ask the user to run `pnpm dev` and check, reporting back:
1. The Stage fills the window width; no sidebar.
2. `S` (and the top bar button) opens and closes the drawer; only videos under it hide.
3. Rows align: abbreviations, scores, and statuses form straight columns across Live, Upcoming, and Final.
4. Games on the Stage show `T1`…; benched games show `Bench`; neither is clickable in Live/Upcoming.
5. Clicking a game assigns it to the selected tile and closes the drawer.
6. A bench game drags onto a visible tile.
7. With a stream view focused (click into a video), `S` opens the drawer and `Esc` closes it without unsoloing.
8. A rejected command's toast appears at top center, not behind a video.
