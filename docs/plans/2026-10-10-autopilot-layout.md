# Autopilot Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While it is on, the autopilot fits the layout to the games worth showing (one game a Single, two a Pair, …), never past the layout you chose.

**Architecture:** A new pure module, `apps/web/src/autopilot/Fit.ts`, gives the `Swap`s and `SetLayout` that fit a Screen under a ceiling. The `Autopilot` fold gains a home layout (the ceiling) and a third part, `layout`, with its own suspension; `step` fits first and chases on the fitted Screen. The pilot's deadline also follows the Screen and the live state, so a finished game's hold running out steps it. No Hub or domain changes.

**Tech Stack:** TypeScript 7 (tsgo), Effect 4 (`Schema.Class`, `Option`, `DateTime`, `Duration`, `Data.taggedEnum`, `Stream.zipLatestAll`, `Stream.switchMap`), `effect/reactivity` atoms, React, `@effect/vitest`, biome (line width 110).

Spec: `docs/specs/2026-10-10-autopilot-layout-design.md`.

## Global Constraints

- Ladders, smallest first: `Single` → `Single`; `Pair` → `Single`, `Pair`; `Quad` → `Single`, `Pair`, `Quad`; `MainThree` → `Single`, `Pair`, `MainThree`; `MainFive` → `Single`, `Pair`, `MainThree`, `MainFive`.
- Worth showing: an occupied tile's game whose moment is anything but `Upcoming` and `Final` (a `Break` counts); a `Final` game for 2 min (`finalHold`) from its classification's `since`; a game with no classification.
- The games to show: the main tile (slot 0), which always counts as one, plus every other occupied tile's game worth showing. Target layout: the smallest on the ceiling's ladder with that many slots; the ceiling itself when no tile at all holds a game worth showing.
- Slot 0 never moves by fitting. Games worth showing beyond the target's slots are swapped, in tile order, into its slots from 1 that hold no game worth showing, lowest first; on-screen games worth showing are never reshuffled.
- The fit's commands: the `Swap`s, then the `SetLayout` (only when the layout changes).
- Each step, unless off or soloed: fit first (unless the layout is suspended or there is no home layout), then the main tile's and the sound's rules on the Screen after the fit; commands are the fit's then the chase's.
- Suspends main: `Promote`, `Solo`, `Swap` with tile 0 as `a` or `b`, `Assign` or `Clear` of tile 0. Suspends sound: `FocusAudio`, `Solo`. Suspends layout: `SetLayout`, `Swap` of two tiles neither 0, `Assign` or `Clear` of a tile other than 0. `SetSplit`, `Unsolo` and anything else suspend nothing. `Autopilot.suspension` = 3 min for each part.
- `SetLayout` you send sets the home layout; turning it on takes the home layout from the Screen. An autopilot kept before this change decodes with no home layout and fits nothing until toggled.
- Status order: main yours, main away, sound yours, sound away, layout yours, fitted (the Screen's layout is not the home layout), idle. Wording: `Autopilot on: layout yours for 2:41`, `Autopilot on: fitted to 2 tiles` (`1 tile` for one).
- Tests: `it("should …")`, one behaviour per test, arrange / act / assert separated by blank lines.
- Comments: doc comments on exports and major declarations only; an inline comment only for a genuinely unclear why.
- `pnpm check` (biome, typecheck, depcruise + knip, tests) passes at the end of every task, save knip `--production` reporting `fit` and `nextFit` unused after Task 1 (Task 2 consumes them); Task 2 ends fully green.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Files

- Create `apps/web/src/autopilot/Fit.ts`, `apps/web/src/autopilot/Fit.test.ts` (Task 1).
- Modify `apps/web/src/autopilot/Autopilot.ts`, `Autopilot.test.ts`, `AutopilotState.ts`, `AutopilotState.test.ts`, `AutopilotToggle.tsx`, `AutopilotToggle.test.ts`, `apps/web/src/display/TopBar.tsx`, `CONTEXT.md` (Task 2).

Work in the worktree `/home/chazzy/development/projects/sportal-autopilot-layout` (branch `autopilot-layout`). Run tests with `pnpm vitest run <path>` from the worktree root.

---

### Task 1: `Fit`, the pure layout fit

**Files:**
- Create: `apps/web/src/autopilot/Fit.ts`
- Test: `apps/web/src/autopilot/Fit.test.ts`

**Interfaces:**
- Consumes: `Screen`, `LayoutName`, `ScreenCommand`, `Tile` from `apps/web/src/screen/Screen.ts`; `SlateChanged` from `@sportal/api/LiveMessage`; `Classification` from `@sportal/domain/Classification`.
- Produces:
  - `fit(screen: Screen, ceiling: LayoutName, classifications: SlateChanged["classifications"], now: DateTime.Utc): ReadonlyArray<ScreenCommand>`
  - `nextFit(screen: Screen, classifications: SlateChanged["classifications"], now: DateTime.Utc): Option.Option<DateTime.Utc>`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/autopilot/Fit.test.ts`. `TestWeb.classified(moment)` gives a classification `since` 2026-10-10 20:00 UTC, so a `Final` game's hold runs out at 20:02.

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { DateTime, Duration, Option, Record, Result } from "effect"
import type { LayoutName, Screen, ScreenCommand } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import { fit, nextFit } from "./Fit.ts"

const [a, b, c, d, e, f] = ["a", "b", "c", "d", "e", "f"].map((id) => GameId.make(id)) as [
  GameId,
  GameId,
  GameId,
  GameId,
  GameId,
  GameId
]

const live: Moment = { _tag: "Live" }
const final: Moment = { _tag: "Final" }
const upcoming: Moment = { _tag: "Upcoming" }

const start = DateTime.makeUnsafe("2026-10-10T20:00:00Z")

function at(seconds: number) {
  return DateTime.addDuration(start, Duration.seconds(seconds))
}

/** Every hold of a game over at the start has run out. */
const later = at(180)

/** `games` on tiles in order, in `layout`. */
function screenOf(games: ReadonlyArray<GameId | undefined>, layout: LayoutName = "Quad"): Screen {
  return Result.getOrThrow(TestWeb.withTiles(games).apply({ _tag: "SetLayout", layout }, TestWeb.onFox))
}

function classified(entries: ReadonlyArray<readonly [GameId, Moment]>) {
  return Record.fromEntries(entries.map(([game, moment]) => [game, TestWeb.classified(moment)] as const))
}

/** `screen` after `commands`, as the Display applies them. */
function after(screen: Screen, commands: ReadonlyArray<ScreenCommand>): Screen {
  return commands.reduce(
    (current, command) => Result.getOrThrow(current.apply(command, TestWeb.onFox)),
    screen
  )
}

function onScreen(screen: Screen) {
  return screen.onScreen().map((tile) => (tile._tag === "Empty" ? undefined : tile.game))
}

describe("fit", () => {
  it("should shrink to a Single when only the main tile's game is in progress", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, final],
        [c, final],
        [d, final]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Single" }])
  })

  it("should shrink to a Pair when two games are in progress", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, live],
        [c, final],
        [d, final]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Pair" }])
  })

  it("should keep a game that is over on screen until its hold runs out", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, final],
        [c, final],
        [d, final]
      ]),
      at(60)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should not count a game that has not started", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, upcoming],
        [c, upcoming],
        [d, upcoming]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Single" }])
  })

  it("should count a game with no classification", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [c, final],
        [d, final]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Pair" }])
  })

  it("should grow back to the ceiling as games start", () => {
    const screen = screenOf([a, b, c, d], "Single")

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, live],
        [c, live],
        [d, live]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Quad" }])
  })

  it("should never grow past the ceiling", () => {
    const screen = screenOf([a, b, c, d, e], "Pair")

    const commands = fit(
      screen,
      "Pair",
      classified([
        [a, live],
        [b, live],
        [c, live],
        [d, live],
        [e, live]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should go back to the ceiling when no game is worth showing", () => {
    const screen = screenOf([a, b], "Single")

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, final],
        [b, final]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Quad" }])
  })

  it("should shrink a MainFive through its own ladder to a MainThree", () => {
    const screen = screenOf([a, b, c, d, e, f], "MainFive")

    const commands = fit(
      screen,
      "MainFive",
      classified([
        [a, live],
        [b, live],
        [c, live],
        [d, final],
        [e, final],
        [f, final]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "MainThree" }])
  })

  it("should leave a game that is over in the main tile", () => {
    const screen = screenOf([a, b, c, d])

    const fitted = after(
      screen,
      fit(
        screen,
        "Quad",
        classified([
          [a, final],
          [b, live],
          [c, final],
          [d, final]
        ]),
        later
      )
    )

    assert.deepStrictEqual(onScreen(fitted), [a, b])
  })

  it("should move a game in progress into a kept slot before it shrinks", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, final],
        [c, final],
        [d, live]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [
      { _tag: "Swap", a: 1, b: 3 },
      { _tag: "SetLayout", layout: "Pair" }
    ])
  })

  it("should fill a slot holding a game that is over with a benched game in progress", () => {
    const screen = screenOf([a, b, c, d, e])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, live],
        [c, final],
        [d, live],
        [e, live]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "Swap", a: 2, b: 4 }])
  })

  it("should not reshuffle when more games are in progress than the ceiling has slots", () => {
    const screen = screenOf([a, b, c, d, e, f])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, live],
        [c, live],
        [d, live],
        [e, live],
        [f, live]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [])
  })
})

describe("nextFit", () => {
  it("should give the end of the hold of a game that is over", () => {
    const screen = screenOf([a, b])

    const next = nextFit(
      screen,
      classified([
        [a, live],
        [b, final]
      ]),
      at(30)
    )

    assert.deepStrictEqual(next, Option.some(at(120)))
  })

  it("should give nothing once every hold has run out", () => {
    const screen = screenOf([a, b])

    const next = nextFit(
      screen,
      classified([
        [a, live],
        [b, final]
      ]),
      later
    )

    assert.deepStrictEqual(next, Option.none())
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/web/src/autopilot/Fit.test.ts`
Expected: FAIL, `./Fit.ts` cannot be resolved.

- [ ] **Step 3: Write `Fit.ts`**

```ts
import type { SlateChanged } from "@sportal/api/LiveMessage"
import type { Classification } from "@sportal/domain/Classification"
import { Array as Arr, DateTime, Duration, type Option } from "effect"
import { type LayoutName, Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"

/**
 * The commands that fit `screen` to the games worth showing, never past `ceiling`: the `Swap`s that bring games worth
 * showing from beyond the layout's slots into its slots from 1 that hold none, then the `SetLayout`. None when it
 * fits. Slot 0 is the main tile's and never moves. Pure.
 */
export function fit(
  screen: Screen,
  ceiling: LayoutName,
  classifications: SlateChanged["classifications"],
  now: DateTime.Utc
): ReadonlyArray<ScreenCommand> {
  const showing = (tile: Tile | undefined) =>
    tile !== undefined && !Tile.guards.Empty(tile) && worthShowing(classifications[tile.game], now)
  const others = screen.tiles.slice(1).filter(showing).length
  const layout = showing(screen.tiles[0]) || others > 0 ? smallest(ceiling, 1 + others) : ceiling
  const slots = Screen.slotCount(layout)
  const open = Array.from({ length: slots - 1 }, (_, index) => index + 1).filter(
    (slot) => !showing(screen.tiles[slot])
  )
  const waiting = screen.tiles.flatMap((tile, index) => (index >= slots && showing(tile) ? [index] : []))
  const swaps = Arr.zip(open, waiting).map(([a, b]): ScreenCommand => ({ _tag: "Swap", a, b }))
  return layout === screen.layout ? swaps : [...swaps, { _tag: "SetLayout", layout }]
}

/** When the earliest hold of a game over on a tile of `screen` runs out, of those still running at `now`. */
export function nextFit(
  screen: Screen,
  classifications: SlateChanged["classifications"],
  now: DateTime.Utc
): Option.Option<DateTime.Utc> {
  const ends = screen.tiles.flatMap((tile) => {
    const classification = Tile.guards.Empty(tile) ? undefined : classifications[tile.game]
    return classification?.moment._tag === "Final" ? [holdEnd(classification)] : []
  })
  return Arr.head(ends.filter((end) => DateTime.isGreaterThan(end, now)).toSorted(DateTime.Order))
}

/** How long a game that is over stays worth showing, so you see the end. */
const finalHold = Duration.minutes(2)

/** The layouts each home layout shrinks through, smallest first. */
const ladders: Record<LayoutName, ReadonlyArray<LayoutName>> = {
  Single: ["Single"],
  Pair: ["Single", "Pair"],
  Quad: ["Single", "Pair", "Quad"],
  MainThree: ["Single", "Pair", "MainThree"],
  MainFive: ["Single", "Pair", "MainThree", "MainFive"]
}

/** Whether a game is in progress, or over less than `finalHold` ago. A game with no classification is. */
function worthShowing(classification: Classification | undefined, now: DateTime.Utc): boolean {
  if (classification === undefined) return true
  switch (classification.moment._tag) {
    case "Upcoming":
      return false
    case "Final":
      return DateTime.isLessThan(now, holdEnd(classification))
    default:
      return true
  }
}

function holdEnd({ since }: Classification): DateTime.Utc {
  return DateTime.addDuration(since, finalHold)
}

/** The smallest layout on `ceiling`'s ladder with a slot for each of `games`. */
function smallest(ceiling: LayoutName, games: number): LayoutName {
  return ladders[ceiling].find((layout) => Screen.slotCount(layout) >= games) ?? ceiling
}
```

The `Swap`s come before the `SetLayout` on purpose: each `Swap`'s tiles exist on the Screen as it is, and the sound, which follows its game by id, is not moved off a game that a shrink would first push to the bench.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/web/src/autopilot/Fit.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Check**

Run: `pnpm check`
Expected: green, save knip `--production` reporting `fit` and `nextFit` in `apps/web/src/autopilot/Fit.ts` as unused exports (Task 2 consumes them). Fix anything else biome or tsgo report.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/autopilot/Fit.ts apps/web/src/autopilot/Fit.test.ts
git commit -m "feat(web): a pure fit of the layout to the games worth showing, under a ceiling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The autopilot fits the layout

**Files:**
- Modify: `apps/web/src/autopilot/Autopilot.ts`
- Modify: `apps/web/src/autopilot/AutopilotState.ts`
- Modify: `apps/web/src/autopilot/AutopilotToggle.tsx`
- Modify: `apps/web/src/display/TopBar.tsx`
- Modify: `CONTEXT.md`
- Test: `apps/web/src/autopilot/Autopilot.test.ts`, `AutopilotState.test.ts`, `AutopilotToggle.test.ts`

**Interfaces:**
- Consumes: `fit`, `nextFit` from `./Fit.ts` (Task 1, signatures above).
- Produces:
  - `Autopilot.home.layout: Option<LayoutName>`, `Autopilot.suspended.layout: Option<DateTime.Utc>`
  - `Autopilot.nextDeadline(now: DateTime.Utc, screen: Screen, classifications: SlateChanged["classifications"]): Option<DateTime.Utc>`
  - `Autopilot.status(now: DateTime.Utc, screen: Screen): AutopilotStatus`, with `AutopilotStatus.Fitted({ slots: number })` and `Yours.part` that may be `"layout"`
  - `AutopilotToggle` takes a `screen: Screen` prop

- [ ] **Step 1: Update the existing tests for the new shape**

In `apps/web/src/autopilot/Autopilot.test.ts`:

- Every `assert.deepStrictEqual(pilot.suspended, { main: …, audio: … })` gains `layout: Option.none()` (four of them, in `describe("Autopilot.manual")`).
- The toggle test's expected home gains the layout:

```ts
    assert.deepStrictEqual(pilot.home, {
      main: Option.some(home),
      audio: Option.some(home),
      layout: Option.some("Quad")
    })
```

- Replace the test "should make nothing yours when you swap two tiles other than tile 0" with:

```ts
  it("should make the layout yours when you swap two tiles other than tile 0", () => {
    const swapped = after(quad, [{ _tag: "Swap", a: 1, b: 2 }])

    const pilot = on.manual({ _tag: "Swap", a: 1, b: 2 }, swapped, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.none(),
      layout: Option.some(at(180))
    })
  })
```

- Every `pilot.nextDeadline(x)` / `yours.nextDeadline(x)` / `on.nextDeadline(x)` becomes `….nextDeadline(x, quad, {})`.
- `pilot.status(at(1))` becomes `pilot.status(at(1), quad)`.

In `apps/web/src/autopilot/AutopilotToggle.test.ts`, the two `suspended: { main: …, audio: … }` literals gain `layout: Option.none()`, and `titleOf` takes and passes a Screen:

```ts
function titleOf(autopilot: Autopilot, classifications = {}, screen: Screen = Screen.initial) {
  const markup = renderToStaticMarkup(
    createElement(AutopilotToggle, { autopilot, slate, classifications, screen, onToggle: () => {} })
  )
  return /title="([^"]*)"/.exec(markup)?.[1]
}
```

with `import { Screen } from "../screen/Screen.ts"`.

- [ ] **Step 2: Write the failing tests**

Add to `apps/web/src/autopilot/Autopilot.test.ts`, with `const final: Moment = { _tag: "Final" }` beside the other moments at the top:

In `describe("Autopilot.step")`:

```ts
  it("should fit the layout before it promotes, and promote on the fitted Screen", () => {
    const [, commands] = on.step(
      quad,
      classified([
        [home, live],
        [other, redZone],
        [third, final],
        [fourth, final]
      ]),
      at(180)
    )

    assert.deepStrictEqual(commands, [
      { _tag: "SetLayout", layout: "Pair" },
      { _tag: "Promote", tile: 1 }
    ])
  })

  it("should not fit the layout while it is yours", () => {
    const pilot = on.manual({ _tag: "SetLayout", layout: "Quad" }, quad, start)

    const [, commands] = pilot.step(
      quad,
      classified([
        [home, live],
        [other, final],
        [third, final],
        [fourth, final]
      ]),
      at(150)
    )

    assert.deepStrictEqual(commands, [])
  })
```

In `describe("Autopilot.manual")`:

```ts
  it("should make the layout yours when you assign a tile other than tile 0", () => {
    const assigned = after(quad, [{ _tag: "Assign", tile: 2, game: benched }])

    const pilot = on.manual({ _tag: "Assign", tile: 2, game: benched }, assigned, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.none(),
      layout: Option.some(at(180))
    })
  })

  it("should make the layout you set home's", () => {
    const paired = after(quad, [{ _tag: "SetLayout", layout: "Pair" }])

    const pilot = on.manual({ _tag: "SetLayout", layout: "Pair" }, paired, start)

    assert.deepStrictEqual(pilot.home.layout, Option.some("Pair"))
  })

  it("should make the layout yours when you set it", () => {
    const paired = after(quad, [{ _tag: "SetLayout", layout: "Pair" }])

    const pilot = on.manual({ _tag: "SetLayout", layout: "Pair" }, paired, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.none(),
      layout: Option.some(at(180))
    })
  })
```

In `describe("Autopilot.nextDeadline")`:

```ts
  it("should give the end of the hold of a game over on a tile", () => {
    const deadline = on.nextDeadline(at(1), quad, classified([[third, final]]))

    assert.deepStrictEqual(deadline, Option.some(at(120)))
  })
```

In `describe("Autopilot.status")`:

```ts
  it("should say the layout is yours until your suspension ends", () => {
    const paired = after(quad, [{ _tag: "SetLayout", layout: "Pair" }])
    const pilot = on.manual({ _tag: "SetLayout", layout: "Pair" }, paired, start)

    const status = pilot.status(at(1), paired)

    assert.deepStrictEqual(status, AutopilotStatus.Yours({ part: "layout", until: at(180) }))
  })

  it("should say it fitted the layout while the Screen's layout is not home's", () => {
    const paired = after(quad, [{ _tag: "SetLayout", layout: "Pair" }])

    const status = on.status(start, paired)

    assert.deepStrictEqual(status, AutopilotStatus.Fitted({ slots: 2 }))
  })
```

Add to `apps/web/src/autopilot/AutopilotToggle.test.ts`:

```ts
  it("should say for how long the layout is yours", () => {
    const yours = new Autopilot({
      ...Autopilot.off,
      on: true,
      suspended: {
        main: Option.none(),
        audio: Option.none(),
        layout: Option.some(DateTime.addDuration(now, Duration.seconds(161)))
      }
    })

    const title = titleOf(yours)

    assert.strictEqual(title, "Autopilot on: layout yours for 2:41 · A")
  })

  it("should say how many tiles it fitted the layout to", () => {
    const fitted = new Autopilot({
      ...Autopilot.off,
      on: true,
      home: { main: Option.none(), audio: Option.none(), layout: Option.some("Quad") }
    })

    const title = titleOf(fitted, {}, new Screen({ ...Screen.initial, layout: "Pair" }))

    assert.strictEqual(title, "Autopilot on: fitted to 2 tiles · A")
  })
```

Add to `apps/web/src/autopilot/AutopilotState.test.ts`, inside `describe("AutopilotState")`:

```ts
  it.effect("should shrink the layout once a finished game's hold runs out, with no new slate", () =>
    Effect.gen(function* () {
      const start = DateTime.makeUnsafe("2026-10-10T20:00:00Z")
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(DateTime.toDate(start))
      yield* TestClock.setTime(DateTime.toEpochMillis(start))
      const clock = yield* Clock.Clock
      const registry = TestWeb.registryOf(
        Layer.mergeAll(
          Shell.layerTest({ record: () => Effect.void }),
          HubClient.layerTest(() => Effect.void),
          Layer.succeed(Clock.Clock, clock)
        )
      )

      const screen = yield* Effect.gen(function* () {
        yield* arranged(slate(TestWeb.classified({ _tag: "Final" })))
        yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())
        yield* Atom.mount(AutopilotState.pilot)
        yield* passing(Duration.minutes(2))
        return yield* TestWeb.until(DisplayScreen.screen, (screen) => screen.layout === "Single")
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(screen.layout, "Single")
    })
  )
```

(`TestWeb.classified` is `since` 20:00, so the finished game's hold ends at 20:02. Turning it on fits the Quad to a Pair; the hold's end is the only thing that can make it a Single.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run apps/web/src/autopilot`
Expected: FAIL. The new tests fail (no layout fields, no `Fitted`, no fitting); tsgo is not run by vitest, so the reshaped calls fail at runtime only where behaviour differs.

- [ ] **Step 4: Change `Autopilot.ts`**

Imports:

```ts
import { LayoutName, Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"
import { fit, nextFit } from "./Fit.ts"
```

Parts and status, replacing `type Part` and `AutopilotStatus`:

```ts
/** The two things the autopilot chases with: the main tile and the sound. */
type Steered = "main" | "audio"

/** What a command you send can make yours: the main tile, the sound or the layout. */
type Part = Steered | "layout"

/**
 * What the autopilot is doing, for its toggle to say: off, idle, away on a game, a part yours until a time, or the
 * layout fitted to fewer slots than home's.
 */
export type AutopilotStatus = Data.TaggedEnum<{
  Off: object
  Idle: object
  Away: { readonly part: Steered; readonly game: GameId }
  Yours: { readonly part: Part; readonly until: DateTime.Utc }
  Fitted: { readonly slots: number }
}>
```

The class doc gains: "It also fits the layout to the games worth showing, never past home's." The fields:

```ts
  /** What you chose: the main tile's game, the game whose sound is on, and the layout, which is the ceiling. */
  home: Schema.Struct({
    main: Schema.OptionFromOptionalKey(GameId),
    audio: Schema.OptionFromOptionalKey(GameId),
    layout: Schema.OptionFromOptionalKey(LayoutName)
  }),
  …
  /** Until when each part is yours. */
  suspended: Schema.Struct({
    main: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
    audio: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
    layout: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString)
  })
```

`off` gains `layout: Option.none()` in `home` and in `suspended`.

`manual`: its doc gains "A `SetLayout` makes its layout home's." Its `home` and `suspended`:

```ts
      home: {
        main: Option.isNone(away.main) ? shown.main : this.home.main,
        audio:
          touched.includes("audio") || (Option.isNone(away.main) && Option.isNone(away.audio))
            ? shown.audio
            : this.home.audio,
        layout: command._tag === "SetLayout" ? Option.some(command.layout) : this.home.layout
      },
      away,
      suspended: {
        main: touched.includes("main") ? until : this.suspended.main,
        audio: touched.includes("audio") ? until : this.suspended.audio,
        layout: touched.includes("layout") ? until : this.suspended.layout
      }
```

`step` fits, then chases; the body it had moves into a module function `chase`:

```ts
  /**
   * One step at `now` on `screen` with each game's classification: the next autopilot and the commands to send, in
   * order. It fits the layout unless the layout is yours, then, on the fitted Screen, steers the main tile unless it
   * is yours, else the sound unless it is yours. Off or soloed, nothing. When nothing changed, the autopilot is this
   * one.
   */
  step(
    screen: Screen,
    classifications: SlateChanged["classifications"],
    now: DateTime.Utc
  ): readonly [Autopilot, ReadonlyArray<ScreenCommand>] {
    if (!this.on || Option.isSome(screen.solo)) return [this, []]
    const suspended = {
      main: running(this.suspended.main, now),
      audio: running(this.suspended.audio, now),
      layout: running(this.suspended.layout, now)
    }
    const ceiling = Option.isNone(suspended.layout) ? Option.getOrUndefined(this.home.layout) : undefined
    const fitted = ceiling === undefined ? [] : fit(screen, ceiling, classifications, now)
    const [next, chased] = chase(this, afterAll(screen, fitted), suspended, classifications, now)
    return [unchangedOr(this, next), [...fitted, ...chased]]
  }
```

Module functions, after `follow`:

```ts
/**
 * The chase on `screen`: the main tile unless it is yours, else the sound unless it is yours. The next autopilot, with
 * `suspended` as its suspensions, and the commands to send.
 */
function chase(
  pilot: Autopilot,
  screen: Screen,
  suspended: Autopilot["suspended"],
  classifications: SlateChanged["classifications"],
  now: DateTime.Utc
): readonly [Autopilot, ReadonlyArray<ScreenCommand>] {
  const standing: Standing = {
    moment: (game) => classifications[game]?.moment,
    score: (game) => classifications[game]?.score ?? 0
  }

  if (Option.isNone(suspended.main)) {
    const [main, move] = follow(
      {
        tiles: occupiedIn(screen.tiles),
        home: pilot.home.main,
        current: Option.fromUndefinedOr(gameIn(screen.tiles[0])),
        away: pilot.away.main
      },
      standing,
      now
    )
    const commands = mainCommands(screen, pilot, move, Option.isSome(suspended.audio))
    return [new Autopilot({ ...pilot, suspended, away: { main, audio: Option.none() } }), commands]
  }

  if (Option.isNone(suspended.audio)) {
    const [audio, move] = follow(
      {
        tiles: occupiedIn(screen.onScreen()),
        home: pilot.home.audio,
        current: screen.audioFocus,
        away: pilot.away.audio
      },
      standing,
      now
    )
    const commands = Move.$match(move, {
      Stay: () => [],
      Home: () => soundTo(screen, pilot.home.audio),
      Go: ({ game }) => soundTo(screen, Option.some(game))
    })
    return [new Autopilot({ ...pilot, suspended, away: { main: Option.none(), audio } }), commands]
  }

  return [new Autopilot({ ...pilot, suspended, away: { main: Option.none(), audio: Option.none() } }), []]
}

/** A suspension, while it still runs at `now`. */
function running(until: Option.Option<DateTime.Utc>, now: DateTime.Utc): Option.Option<DateTime.Utc> {
  return Option.filter(until, (time) => DateTime.isLessThan(now, time))
}
```

`nextDeadline`:

```ts
  /**
   * When the next step may change something with no new slate: an away game's dwell ending, a suspension ending, or
   * the hold of a game over on a tile of `screen` running out.
   */
  nextDeadline(
    now: DateTime.Utc,
    screen: Screen,
    classifications: SlateChanged["classifications"]
  ): Option.Option<DateTime.Utc> {
    const dwellEnd = (away: Option.Option<Away>) =>
      Option.toArray(Option.map(away, ({ since }) => DateTime.addDuration(since, Autopilot.dwell)))
    const times = [
      ...dwellEnd(this.away.main),
      ...dwellEnd(this.away.audio),
      ...Option.toArray(this.suspended.main),
      ...Option.toArray(this.suspended.audio),
      ...Option.toArray(this.suspended.layout),
      ...(Option.isSome(this.home.layout) ? Option.toArray(nextFit(screen, classifications, now)) : [])
    ]
    return Arr.head(times.filter((time) => DateTime.isGreaterThan(time, now)).toSorted(DateTime.Order))
  }
```

`status`:

```ts
  /**
   * What it is doing at `now` on `screen`: the main tile before the sound, a part yours before a part away, then the
   * layout yours, then fitted.
   */
  status(now: DateTime.Utc, screen: Screen): AutopilotStatus {
    if (!this.on) return AutopilotStatus.Off()
    for (const part of ["main", "audio"] as const) {
      const until = running(this.suspended[part], now)
      if (Option.isSome(until)) return AutopilotStatus.Yours({ part, until: until.value })
      const away = this.away[part]
      if (Option.isSome(away)) return AutopilotStatus.Away({ part, game: away.value.game })
    }
    const layoutUntil = running(this.suspended.layout, now)
    if (Option.isSome(layoutUntil)) return AutopilotStatus.Yours({ part: "layout", until: layoutUntil.value })
    if (Option.exists(this.home.layout, (layout) => layout !== screen.layout))
      return AutopilotStatus.Fitted({ slots: Screen.slotCount(screen.layout) })
    return AutopilotStatus.Idle()
  }
```

`suspends`:

```ts
    case "Swap":
      return command.a === 0 || command.b === 0 ? ["main"] : ["layout"]
    case "Assign":
    case "Clear":
      return command.tile === 0 ? ["main"] : ["layout"]
    case "FocusAudio":
      return ["audio"]
    case "SetLayout":
      return ["layout"]
    default:
      return []
```

`homeOf`:

```ts
function homeOf(screen: Screen): Autopilot["home"] {
  return {
    main: Option.fromUndefinedOr(gameIn(screen.tiles[0])),
    audio: screen.audioFocus,
    layout: Option.some(screen.layout)
  }
}
```

`afterAll`'s doc becomes: "`screen` after the autopilot's own commands, none of which asks a game's availability."

`Screen` is now a value import (for `Screen.slotCount`); keep `type` on `ScreenCommand` only.

- [ ] **Step 5: Change `AutopilotState.ts`**

The pilot's deadline follows the autopilot, the Screen and the live state:

```ts
/** Steps the autopilot on each live update and at its next deadline. Mounted once, by the Display. */
export const pilot = runtime.atom((get) =>
  Effect.gen(function* () {
    const deadlines = Stream.zipLatestAll(
      get.stream(autopilot),
      get.stream(DisplayScreen.screen),
      get.stream(LiveStream.live)
    ).pipe(
      Stream.switchMap(([current, screen, live]) =>
        Stream.fromEffect(untilDeadline(current, screen, live.classifications))
      )
    )

    yield* Stream.merge(get.stream(LiveStream.live), deadlines).pipe(
      Stream.runForEach(() => Effect.sync(() => get.set(autopilot, AutopilotInput.Ticked())))
    )
  }).pipe(logDefect("The autopilot"))
)

/** Waits until `current`'s next deadline on `screen`; forever, when it has none. */
function untilDeadline(
  current: Autopilot,
  screen: Screen,
  classifications: SlateChanged["classifications"]
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const now = yield* DateTime.now
    yield* Option.match(current.nextDeadline(now, screen, classifications), {
      onNone: () => Effect.never,
      onSome: (at) => Effect.sleep(DateTime.distance(now, at))
    })
  })
}
```

with `import type { SlateChanged } from "@sportal/api/LiveMessage"`.

- [ ] **Step 6: Change `AutopilotToggle.tsx` and `TopBar.tsx`**

`AutopilotToggle` takes `screen: Screen` (`import type { Screen } from "../screen/Screen.ts"`) and words the new status:

```ts
  const doing = AutopilotStatus.$match(autopilot.status(now, screen), {
    Off: () => "Autopilot off",
    Idle: () => "Autopilot on: following, nothing to chase",
    Away: …as now…,
    Yours: ({ part, until }) =>
      `Autopilot on: ${partName(part)} yours for ${countdown(DateTime.distance(now, until))}`,
    Fitted: ({ slots }) => `Autopilot on: fitted to ${slots} ${slots === 1 ? "tile" : "tiles"}`
  })
```

```ts
function partName(part: "main" | "audio" | "layout"): string {
  return part === "main" ? "main tile" : part === "audio" ? "sound" : "layout"
}
```

In `TopBar.tsx`, pass the Screen it already has: `<AutopilotToggle autopilot={autopilot} slate={slate} classifications={classifications} screen={screen} onToggle={…} />`.

- [ ] **Step 7: Update `CONTEXT.md`**

After the **Suspension** row, and with Suspension now naming the layout:

```markdown
| **Suspension** | The 3 min a command you send keeps the autopilot off the main tile, the sound or the layout it touched. | pause, lock |
| **Ceiling** | The layout you chose, the autopilot's home layout: it fits the layout down from it as games end and back up to it as they start, never past. | max layout |
| **Fit** | The autopilot's choice of layout and tile order: the smallest layout on the ceiling's ladder with a slot for the main tile and each other game in progress or just over. | auto-layout |
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run apps/web/src/autopilot`
Expected: PASS, every test in the four autopilot files.

- [ ] **Step 9: Check**

Run: `pnpm check`
Expected: fully green (biome, tsgo, depcruise, knip, knip `--production`, vitest).

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/autopilot apps/web/src/display/TopBar.tsx CONTEXT.md
git commit -m "feat(web): the autopilot fits the layout to the games worth showing, under the layout you chose

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
