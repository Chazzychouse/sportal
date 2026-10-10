# Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Display's autopilot promotes the best moment into the main tile and moves the sound with it, then puts back what you chose; your commands always win.

**Architecture:** A pure fold, `Autopilot`, in `apps/web/src/autopilot/`, stepped by an atom on each live update and at its own deadlines; its commands go to `DisplayScreen.screen` like any other. Commands you send through `DisplayState.display` are handed to the fold as manual input. A top-bar toggle and the `A` hotkey turn it on and off. No Hub or domain changes.

**Tech Stack:** TypeScript 7 (tsgo), Effect 4 (`Schema.Class`, `Option`, `DateTime`, `Duration`, `Order`, `Stream.switchMap`), `effect/reactivity` atoms, React, `@effect/vitest`, biome (line width 110).

Spec: `docs/specs/2026-10-10-autopilot-design.md`.

## Global Constraints

- Away-worthy: `ScoringThreat` or `CrunchTime`. A `Break` (even with `during`) and `BigPlay` are not.
- Order of interest, most first: `ScoringThreat`, `CrunchTime`, `BigPlay`, `Live`; then the higher score; then the lower tile index.
- Home stopped: its moment is `Break` or `Final`, or it is on no tile. Then any live moment (`Live`, `BigPlay`, `ScoringThreat`, `CrunchTime`) other than home is a target ("no commercials").
- `Autopilot.dwell` = 30 s; `Autopilot.suspension` = 3 min.
- An away game is replaced only by a target whose moment comes strictly first; a break or final cuts its dwell short.
- Suspends main: `Promote`, `Solo`, `Swap` with tile 0 as `a` or `b`, `Assign` or `Clear` of tile 0. Suspends sound: `FocusAudio`, `Solo`. Nothing else suspends.
- While the Screen is soloed, or the autopilot is off, it sends nothing.
- Off by default; kept in the browser under `sportal/autopilot`; hotkey `A` (`KeyA`), `ToggleAutopilot`.
- Turning it off leaves the Screen as it is.
- Tests: `it("should …")`, one behaviour per test, arrange / act / assert separated by blank lines.
- Comments: doc comments on exports and major declarations only; an inline comment only for a genuinely unclear why.
- `pnpm check` (biome, typecheck, depcruise + knip, tests) passes at the end of every task, save knip reporting an export or member a later task of this plan consumes; Task 3 ends fully green.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Files

- Create `apps/web/src/autopilot/Autopilot.ts`: the pure fold.
- Create `apps/web/src/autopilot/Autopilot.test.ts`.
- Create `apps/web/src/autopilot/AutopilotState.ts`: the kept atom and the driver.
- Create `apps/web/src/autopilot/AutopilotState.test.ts`.
- Create `apps/web/src/autopilot/AutopilotToggle.tsx` and `AutopilotToggle.test.ts`: the top-bar toggle.
- Modify `apps/web/src/TestWeb.ts`: `classified`, `redZone`, and classifications in `slateMessage`.
- Modify `packages/api/src/Hotkey.ts` and `Hotkey.test.ts`: `ToggleAutopilot` on `A`.
- Modify `apps/web/src/display/Display.ts` (+ test): `ToggleAutopilot` does nothing on the Display.
- Modify `apps/web/src/display/DisplayState.ts` (+ test): manual commands to the autopilot; the hotkey toggles it.
- Modify `apps/web/src/display/DisplayView.tsx`: mount the driver.
- Modify `apps/web/src/display/TopBar.tsx`: the toggle.
- Modify `docs/adr/0015-each-display-owns-its-screen.md`, `CONTEXT.md`.

---

### Task 1: The Autopilot fold

**Files:**
- Create: `apps/web/src/autopilot/Autopilot.ts`
- Create: `apps/web/src/autopilot/Autopilot.test.ts`
- Modify: `apps/web/src/TestWeb.ts`

**Interfaces:**
- Consumes: `Screen`, `ScreenCommand`, `Tile` from `apps/web/src/screen/Screen.ts`; `SlateChanged` from `@sportal/api/LiveMessage`; `Classification`, `Moment`, `GameId` from `@sportal/domain`.
- Produces:
  - `class Autopilot` (a `Schema.Class`, `"sportal/Autopilot"`) with fields `on`, `home: { main, audio }`, `away: { main, audio }`, `suspended: { main, audio }`.
  - `Autopilot.off`, `Autopilot.dwell`, `Autopilot.suspension`.
  - `toggle(screen: Screen): Autopilot`
  - `manual(command: ScreenCommand, after: Screen, now: DateTime.Utc): Autopilot`
  - `step(screen: Screen, classifications: SlateChanged["classifications"], now: DateTime.Utc): readonly [Autopilot, ReadonlyArray<ScreenCommand>]`
  - `nextDeadline(now: DateTime.Utc): Option.Option<DateTime.Utc>`
  - `status(now: DateTime.Utc): AutopilotStatus`
  - `type Part = "main" | "audio"`; `AutopilotStatus` = `Off | Idle | Away { part, game } | Yours { part, until }` (`Data.taggedEnum`).
  - `TestWeb.classified(moment: Moment, score?: number): Classification`, `TestWeb.redZone: Moment`.

- [ ] **Step 1: Add the test builders to `apps/web/src/TestWeb.ts`**

Add the imports `import { Classification } from "@sportal/domain/Classification"`, `import type { Moment } from "@sportal/domain/Moment"` and add `team` to the existing `@sportal/domain/TestGame` import. Then, below `soloed`:

```ts
/** `moment` classified at 2026-10-10 20:00 UTC with `score`, all of it from closeness. */
export function classified(moment: Moment, score = 50): Classification {
  return new Classification({
    moment,
    score,
    since: DateTime.makeUnsafe("2026-10-10T20:00:00Z"),
    breakdown: { prior: 0, closeness: score, swing: 0, upset: 0, momentBonus: 0 }
  })
}

/** The home team eight yards from scoring. */
export const redZone: Moment = { _tag: "ScoringThreat", team: team("HOME").id, yardsToGo: 8 }
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/autopilot/Autopilot.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { DateTime, Duration, Option, Record, Result } from "effect"
import type { Screen, ScreenCommand } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import { Autopilot, AutopilotStatus } from "./Autopilot.ts"

const home = GameId.make("home")
const other = GameId.make("other")
const third = GameId.make("third")
const fourth = GameId.make("fourth")
const benched = GameId.make("benched")

const redZone = TestWeb.redZone
const crunch: Moment = { _tag: "CrunchTime", margin: 3, secondsLeft: 100 }
const live: Moment = { _tag: "Live" }
const timeout: Moment = {
  _tag: "Break",
  reason: "timeout",
  expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z")
}

const start = DateTime.makeUnsafe("2026-10-10T20:00:00Z")

function at(seconds: number) {
  return DateTime.addDuration(start, Duration.seconds(seconds))
}

/** A Quad holding `games` in order, past the fourth benched, the sound on the main tile. */
function screenOf(games: ReadonlyArray<GameId>): Screen {
  return Result.getOrThrow(TestWeb.withTiles(games).apply({ _tag: "FocusAudio", tile: 0 }, TestWeb.onFox))
}

/** Each game's classification: in its moment, with its score (50 unless given). */
function classified(entries: ReadonlyArray<readonly [GameId, Moment, number?]>) {
  return Record.fromEntries(
    entries.map(([game, moment, score]) => [game, TestWeb.classified(moment, score)] as const)
  )
}

/** `screen` after `commands`, as the Display applies them. */
function after(screen: Screen, commands: ReadonlyArray<ScreenCommand>): Screen {
  return commands.reduce((current, command) => Result.getOrThrow(current.apply(command, TestWeb.onFox)), screen)
}

function gamesIn(screen: Screen) {
  return screen.tiles.map((tile) => (tile._tag === "Empty" ? undefined : tile.game))
}

const quad = screenOf([home, other, third, fourth])
const on = Autopilot.off.toggle(quad)

/** The autopilot away on `other` since the start, in `moment`, and the Screen after it went. */
function awayOnOther(moment: Moment = redZone) {
  const [pilot, commands] = on.step(quad, classified([[home, live], [other, moment]]), start)
  return { pilot, screen: after(quad, commands) }
}

describe("Autopilot.step", () => {
  it("should send nothing while off", () => {
    const [, commands] = Autopilot.off.step(quad, classified([[home, live], [other, redZone]]), start)

    assert.deepStrictEqual(commands, [])
  })

  it("should send nothing while the Screen is soloed", () => {
    const soloed = after(quad, [{ _tag: "Solo", tile: 1 }])

    const [, commands] = on.step(soloed, classified([[home, live], [other, redZone]]), start)

    assert.deepStrictEqual(commands, [])
  })

  it("should promote a red zone on another tile while home is live", () => {
    const [, commands] = on.step(quad, classified([[home, live], [other, redZone]]), start)

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should stay home while home is in the red zone itself", () => {
    const [, commands] = on.step(quad, classified([[home, redZone, 10], [other, redZone, 90]]), start)

    assert.deepStrictEqual(commands, [])
  })

  it("should stay home while home is live and no other game is in a red zone or crunch time", () => {
    const [, commands] = on.step(quad, classified([[home, live], [other, live]]), start)

    assert.deepStrictEqual(commands, [])
  })

  it("should promote a benched game in the red zone", () => {
    const screen = screenOf([home, other, third, fourth, benched])

    const [, commands] = Autopilot.off.toggle(screen).step(screen, classified([[home, live], [benched, redZone]]), start)

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 4 }])
  })

  it("should leave home on a break for a game in plain live play", () => {
    const [, commands] = on.step(quad, classified([[home, timeout], [other, live]]), start)

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should pick the higher score of two red zones", () => {
    const [, commands] = on.step(
      quad,
      classified([[home, live], [other, redZone, 40], [third, redZone, 80]]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 2 }])
  })

  it("should pick a red zone over crunch time, whatever their scores", () => {
    const [, commands] = on.step(
      quad,
      classified([[home, live], [other, crunch, 90], [third, redZone, 10]]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 2 }])
  })

  it("should hold the away game through its dwell though its red zone is over", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(screen, classified([[home, live], [other, live]]), at(10))

    assert.deepStrictEqual(commands, [])
  })

  it("should go home within the dwell when the away game goes to a break", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(screen, classified([[home, live], [other, timeout]]), at(10))

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should go home once the dwell is out and the red zone is over", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(screen, classified([[home, live], [other, live]]), at(31))

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should put every tile back where it was when it goes home", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(screen, classified([[home, live], [other, live]]), at(31))

    assert.deepStrictEqual(gamesIn(after(screen, commands)), gamesIn(quad))
  })

  it("should put the sound back on home's sound game when it goes home", () => {
    const heard = after(quad, [{ _tag: "FocusAudio", tile: 2 }])
    const [pilot, went] = Autopilot.off.toggle(heard).step(heard, classified([[home, live], [other, redZone]]), start)
    const away = after(heard, went)

    const [, commands] = pilot.step(away, classified([[home, live], [other, live]]), at(31))

    assert.deepStrictEqual(commands, [
      { _tag: "Promote", tile: 1 },
      { _tag: "FocusAudio", tile: 2 }
    ])
  })

  it("should not hand a red zone off to another red zone", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(
      screen,
      classified([[home, live], [other, redZone, 50], [third, redZone, 99]]),
      at(40)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should not replace a red zone with crunch time", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(screen, classified([[home, live], [other, redZone], [third, crunch]]), at(40))

    assert.deepStrictEqual(commands, [])
  })

  it("should not replace an away game within its dwell, even for a red zone", () => {
    const { pilot, screen } = awayOnOther(crunch)

    const [, commands] = pilot.step(screen, classified([[home, live], [other, crunch], [third, redZone]]), at(10))

    assert.deepStrictEqual(commands, [])
  })

  it("should replace crunch time with a red zone once the dwell is out", () => {
    const { pilot, screen } = awayOnOther(crunch)

    const [, commands] = pilot.step(screen, classified([[home, live], [other, crunch], [third, redZone]]), at(31))

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 2 }])
  })
})

describe("Autopilot.manual", () => {
  const promoted = after(quad, [{ _tag: "Promote", tile: 2 }])
  const yours = on.manual({ _tag: "Promote", tile: 2 }, promoted, start)

  it("should make the game you promote home", () => {
    const main = yours.home.main

    assert.deepStrictEqual(main, Option.some(third))
  })

  it("should move only the sound while the main tile is yours", () => {
    const [, commands] = yours.step(promoted, classified([[third, live], [other, redZone]]), at(10))

    assert.deepStrictEqual(commands, [{ _tag: "FocusAudio", tile: 1 }])
  })

  it("should follow with the main tile again once your suspension is out", () => {
    const [, commands] = yours.step(promoted, classified([[third, live], [other, redZone]]), at(181))

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should keep the sound where you put it when it promotes", () => {
    const heard = after(quad, [{ _tag: "FocusAudio", tile: 2 }])
    const pilot = on.manual({ _tag: "FocusAudio", tile: 2 }, heard, start)

    const [, commands] = pilot.step(heard, classified([[home, live], [other, redZone], [third, live]]), at(10))

    assert.deepStrictEqual(commands, [
      { _tag: "Promote", tile: 1 },
      { _tag: "FocusAudio", tile: 2 }
    ])
  })

  it("should keep home while away when your command does not suspend", () => {
    const { pilot, screen } = awayOnOther()
    const laidOut = after(screen, [{ _tag: "SetLayout", layout: "Pair" }])

    const next = pilot.manual({ _tag: "SetLayout", layout: "Pair" }, laidOut, at(5))

    assert.deepStrictEqual(next.home.main, Option.some(home))
  })
})

describe("Autopilot.toggle", () => {
  it("should take home from the Screen when turned on", () => {
    const pilot = Autopilot.off.toggle(quad)

    assert.deepStrictEqual(pilot.home, { main: Option.some(home), audio: Option.some(home) })
  })

  it("should forget the away game when turned off", () => {
    const { pilot, screen } = awayOnOther()

    const off = pilot.toggle(screen)

    assert.isTrue(Option.isNone(off.away.main))
  })
})

describe("Autopilot.nextDeadline", () => {
  it("should give the end of the away game's dwell", () => {
    const { pilot } = awayOnOther()

    const deadline = pilot.nextDeadline(at(1))

    assert.deepStrictEqual(deadline, Option.some(at(30)))
  })

  it("should give the end of your suspension", () => {
    const pilot = on.manual({ _tag: "Promote", tile: 2 }, after(quad, [{ _tag: "Promote", tile: 2 }]), start)

    const deadline = pilot.nextDeadline(at(1))

    assert.deepStrictEqual(deadline, Option.some(at(180)))
  })
})

describe("Autopilot.status", () => {
  it("should say the main tile is yours until your suspension ends", () => {
    const pilot = on.manual({ _tag: "Promote", tile: 2 }, after(quad, [{ _tag: "Promote", tile: 2 }]), start)

    const status = pilot.status(at(1))

    assert.deepStrictEqual(status, AutopilotStatus.Yours({ part: "main", until: at(180) }))
  })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm vitest run apps/web/src/autopilot/Autopilot.test.ts`
Expected: FAIL, `Cannot find module './Autopilot.ts'`.

- [ ] **Step 4: Write `apps/web/src/autopilot/Autopilot.ts`**

```ts
import type { SlateChanged } from "@sportal/api/LiveMessage"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { Array as Arr, Data, DateTime, Duration, Option, Order, Schema } from "effect"
import { Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"

/** The two things the autopilot steers: the main tile and the sound. */
export type Part = "main" | "audio"

/** What the autopilot is doing, for its toggle to say: off, idle, away on a game, or a part yours until a time. */
export type AutopilotStatus = Data.TaggedEnum<{
  Off: object
  Idle: object
  Away: { readonly part: Part; readonly game: GameId }
  Yours: { readonly part: Part; readonly until: DateTime.Utc }
}>
export const AutopilotStatus = Data.taggedEnum<AutopilotStatus>()

const Away = Schema.Struct({ game: GameId, since: Schema.DateTimeUtcFromString })
type Away = typeof Away.Type

/**
 * A Display's autopilot. While on, it promotes the best moment into the main tile and moves the sound with it, then
 * puts back what you chose (home) when the moment is over. Each command you send sets home and suspends the part it
 * touched for `suspension`. Pure.
 */
export class Autopilot extends Schema.Class<Autopilot>("sportal/Autopilot")({
  on: Schema.Boolean,
  /** What you chose: the main tile's game and the game whose sound is on. */
  home: Schema.Struct({
    main: Schema.OptionFromOptionalKey(GameId),
    audio: Schema.OptionFromOptionalKey(GameId)
  }),
  /** The game the autopilot moved each part to, and since when. */
  away: Schema.Struct({ main: Schema.OptionFromOptionalKey(Away), audio: Schema.OptionFromOptionalKey(Away) }),
  /** Until when each part is yours. */
  suspended: Schema.Struct({
    main: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
    audio: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString)
  })
}) {
  static readonly off: Autopilot = new Autopilot({
    on: false,
    home: { main: Option.none(), audio: Option.none() },
    away: { main: Option.none(), audio: Option.none() },
    suspended: { main: Option.none(), audio: Option.none() }
  })

  /** How long an away game holds its part, unless it stops. */
  static readonly dwell = Duration.seconds(30)

  /** How long a command you send keeps the autopilot off the part it touched. */
  static readonly suspension = Duration.minutes(3)

  /** On, home taken from `screen`; or off, everything forgotten. The Screen is left as it is. */
  toggle(screen: Screen): Autopilot {
    return this.on ? Autopilot.off : new Autopilot({ ...Autopilot.off, on: true, home: homeOf(screen) })
  }

  /**
   * After `command`, which you sent, left the Screen as `after`: the parts it touches are yours for `suspension` and
   * no longer away, and home is what `after` shows for each part not away.
   */
  manual(command: ScreenCommand, after: Screen, now: DateTime.Utc): Autopilot {
    if (!this.on) return this
    const touched = suspends(command)
    const until = Option.some(DateTime.addDuration(now, Autopilot.suspension))
    const away = {
      main: touched.includes("main") ? Option.none() : this.away.main,
      audio: touched.includes("audio") ? Option.none() : this.away.audio
    }
    const shown = homeOf(after)
    return new Autopilot({
      on: true,
      home: {
        main: Option.isNone(away.main) ? shown.main : this.home.main,
        audio: Option.isNone(away.main) && Option.isNone(away.audio) ? shown.audio : this.home.audio
      },
      away,
      suspended: {
        main: touched.includes("main") ? until : this.suspended.main,
        audio: touched.includes("audio") ? until : this.suspended.audio
      }
    })
  }

  /**
   * One step at `now` on `screen` with each game's classification: the next autopilot and the commands to send, in
   * order. The main tile is steered unless it is yours, else the sound unless it is yours. Off or soloed, nothing.
   */
  step(
    screen: Screen,
    classifications: SlateChanged["classifications"],
    now: DateTime.Utc
  ): readonly [Autopilot, ReadonlyArray<ScreenCommand>] {
    if (!this.on || Option.isSome(screen.solo)) return [this, []]
    const suspended = {
      main: Option.filter(this.suspended.main, (until) => DateTime.isLessThan(now, until)),
      audio: Option.filter(this.suspended.audio, (until) => DateTime.isLessThan(now, until))
    }
    const standing: Standing = {
      moment: (game) => classifications[game]?.moment,
      score: (game) => classifications[game]?.score ?? 0
    }
    const soundBack = (promoted: number | undefined) => audioReturn(screen, this.home.audio, promoted)

    if (Option.isNone(suspended.main)) {
      const homeGame = Option.getOrUndefined(this.home.main)
      const homeTile = screen.tiles.findIndex((tile) => homeGame !== undefined && gameIn(tile) === homeGame)
      const back: ReadonlyArray<ScreenCommand> =
        homeTile === -1 ? [] : [{ _tag: "Promote", tile: homeTile }, ...soundBack(homeTile)]
      const [main, commands] = follow(
        {
          tiles: occupiedIn(screen.tiles),
          home: this.home.main,
          current: Option.fromUndefinedOr(gameIn(screen.tiles[0])),
          away: this.away.main,
          go: (tile) => [{ _tag: "Promote", tile }, ...(Option.isSome(suspended.audio) ? soundBack(tile) : [])],
          back
        },
        standing,
        now
      )
      const sent = commands.length === 0 && Option.isSome(this.away.audio) ? soundBack(undefined) : commands
      return [new Autopilot({ ...this, suspended, away: { main, audio: Option.none() } }), sent]
    }

    if (Option.isNone(suspended.audio)) {
      const [audio, commands] = follow(
        {
          tiles: occupiedIn(screen.onScreen()),
          home: this.home.audio,
          current: screen.audioFocus,
          away: this.away.audio,
          go: (tile) => [{ _tag: "FocusAudio", tile }],
          back: soundBack(undefined)
        },
        standing,
        now
      )
      return [new Autopilot({ ...this, suspended, away: { main: Option.none(), audio } }), commands]
    }

    return [new Autopilot({ ...this, suspended, away: { main: Option.none(), audio: Option.none() } }), []]
  }

  /** When the next step may change something with no new slate: an away game's dwell ending, or a suspension. */
  nextDeadline(now: DateTime.Utc): Option.Option<DateTime.Utc> {
    const dwellEnd = (away: Option.Option<Away>) =>
      Option.toArray(Option.map(away, ({ since }) => DateTime.addDuration(since, Autopilot.dwell)))
    const times = [
      ...dwellEnd(this.away.main),
      ...dwellEnd(this.away.audio),
      ...Option.toArray(this.suspended.main),
      ...Option.toArray(this.suspended.audio)
    ]
    return Arr.head(times.filter((time) => DateTime.isGreaterThan(time, now)).toSorted(DateTime.Order))
  }

  /** What it is doing at `now`: the main tile before the sound, a part yours before a part away. */
  status(now: DateTime.Utc): AutopilotStatus {
    if (!this.on) return AutopilotStatus.Off()
    for (const part of ["main", "audio"] as const) {
      const until = Option.filter(this.suspended[part], (time) => DateTime.isLessThan(now, time))
      if (Option.isSome(until)) return AutopilotStatus.Yours({ part, until: until.value })
      const away = this.away[part]
      if (Option.isSome(away)) return AutopilotStatus.Away({ part, game: away.value.game })
    }
    return AutopilotStatus.Idle()
  }
}

/** Each game's moment and score, as the live classifications give them. */
interface Standing {
  readonly moment: (game: GameId) => Moment | undefined
  readonly score: (game: GameId) => number
}

/** One part, to steer: where it may go, home, where it is, where the autopilot moved it, and how to move it. */
interface Steering {
  readonly tiles: ReadonlyArray<{ readonly tile: number; readonly game: GameId }>
  readonly home: Option.Option<GameId>
  readonly current: Option.Option<GameId>
  readonly away: Option.Option<Away>
  readonly go: (tile: number) => ReadonlyArray<ScreenCommand>
  readonly back: ReadonlyArray<ScreenCommand>
}

/**
 * Where one part goes at `now`: the game it is then away on, if any, and the commands that take it there. An away
 * game holds through its dwell unless it stops, then until it is no longer wanted or a target comes strictly first.
 */
function follow(
  steering: Steering,
  standing: Standing,
  now: DateTime.Utc
): readonly [Option.Option<Away>, ReadonlyArray<ScreenCommand>] {
  const { tiles, current, go, back } = steering
  const { moment } = standing
  const home = Option.getOrUndefined(steering.home)
  const homeOnTile = home !== undefined && tiles.some(({ game }) => game === home)
  const homeMoment = homeOnTile ? moment(home) : undefined
  // A home game with no classification yet counts as live: only a break, a final or no tile is stopped.
  const homeStopped = !homeOnTile || (homeMoment !== undefined && stopped(homeMoment))
  const wanted = (game: GameId) => {
    const its = moment(game)
    return its !== undefined && (homeStopped ? interest(its) < Infinity : awayWorthy(its))
  }
  const homeHolds = !homeStopped && homeMoment !== undefined && awayWorthy(homeMoment)
  const target = homeHolds
    ? undefined
    : Option.getOrUndefined(
        Arr.head(tiles.filter(({ game }) => game !== home && wanted(game)).toSorted(byInterest(standing)))
      )

  const away = Option.filter(steering.away, ({ game }) => Option.contains(current, game))
  if (Option.isSome(away)) {
    const { game, since } = away.value
    const its = moment(game)
    const dwelling = DateTime.isLessThan(now, DateTime.addDuration(since, Autopilot.dwell))
    if (!stopped(its) && dwelling) return [away, []]
    const outranked = target !== undefined && interest(moment(target.game)) < interest(its)
    if (!stopped(its) && wanted(game) && !outranked) return [away, []]
  }

  if (target === undefined) return [Option.none(), Option.isSome(away) ? back : []]
  const going = Option.some({ game: target.game, since: now })
  return [going, Option.contains(current, target.game) ? [] : go(target.tile)]
}

/** Most worth chasing first: a red zone, crunch time, a big play, plain live play. Anything else is not chased. */
const interestRank: { readonly [Tag in Moment["_tag"]]?: number } = {
  ScoringThreat: 0,
  CrunchTime: 1,
  BigPlay: 2,
  Live: 3
}

function interest(moment: Moment | undefined): number {
  return moment === undefined ? Infinity : (interestRank[moment._tag] ?? Infinity)
}

function awayWorthy(moment: Moment): boolean {
  return moment._tag === "ScoringThreat" || moment._tag === "CrunchTime"
}

/** Whether a game has stopped: on a break, over, or with no classification to say. */
function stopped(moment: Moment | undefined): boolean {
  return moment === undefined || moment._tag === "Break" || moment._tag === "Final"
}

/** The best first: the most worth chasing, then the higher score, then the lower tile. */
function byInterest(standing: Standing): Order.Order<{ readonly tile: number; readonly game: GameId }> {
  return Order.combine(
    Order.mapInput(Order.Number, ({ game }) => interest(standing.moment(game))),
    Order.combine(
      Order.mapInput(Order.Number, ({ game }) => -standing.score(game)),
      Order.mapInput(Order.Number, ({ tile }) => tile)
    )
  )
}

/** The parts a command you send makes yours. */
function suspends(command: ScreenCommand): ReadonlyArray<Part> {
  switch (command._tag) {
    case "Promote":
      return ["main"]
    case "Solo":
      return ["main", "audio"]
    case "Swap":
      return command.a === 0 || command.b === 0 ? ["main"] : []
    case "Assign":
    case "Clear":
      return command.tile === 0 ? ["main"] : []
    case "FocusAudio":
      return ["audio"]
    default:
      return []
  }
}

/**
 * The command that puts the sound back on `homeAudio` once the tile `promoted` is promoted (undefined: no promote).
 * None when the sound would already be on it, or it would not be on screen.
 */
function audioReturn(
  screen: Screen,
  homeAudio: Option.Option<GameId>,
  promoted: number | undefined
): ReadonlyArray<ScreenCommand> {
  const audio = Option.getOrUndefined(homeAudio)
  const heard =
    promoted === undefined ? Option.getOrUndefined(screen.audioFocus) : gameIn(screen.tiles[promoted])
  if (audio === undefined || audio === heard) return []
  const index = screen.tiles.findIndex((tile) => gameIn(tile) === audio)
  const slot =
    promoted === undefined || index === -1 ? index : index === 0 ? promoted : index === promoted ? 0 : index
  return slot === -1 || slot >= Screen.slotCount(screen.layout) ? [] : [{ _tag: "FocusAudio", tile: slot }]
}

function homeOf(screen: Screen): Autopilot["home"] {
  return { main: Option.fromUndefinedOr(gameIn(screen.tiles[0])), audio: screen.audioFocus }
}

function occupiedIn(tiles: ReadonlyArray<Tile>) {
  return tiles.flatMap((tile, index) => (Tile.guards.Empty(tile) ? [] : [{ tile: index, game: tile.game }]))
}

function gameIn(tile: Tile | undefined): GameId | undefined {
  return tile === undefined || Tile.guards.Empty(tile) ? undefined : tile.game
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm vitest run apps/web/src/autopilot/Autopilot.test.ts`
Expected: PASS, 28 tests. If the typechecker rejects a literal command array (a `_tag` widened to `string`), annotate the array as `ReadonlyArray<ScreenCommand>` at that spot rather than casting.

- [ ] **Step 6: Run the whole check**

Run: `pnpm biome check --write apps/web/src && pnpm check`
Expected: PASS, except that knip (in `pnpm structure`) may report `Autopilot`'s members or `AutopilotStatus` unused in production: Tasks 2 and 3 consume them. Any other finding must be fixed. Quote knip's output in the report.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/autopilot apps/web/src/TestWeb.ts
git commit -m "feat(web): the autopilot, a fold that chases the best moment and goes home after

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The autopilot runs on the Display

**Files:**
- Create: `apps/web/src/autopilot/AutopilotState.ts`
- Create: `apps/web/src/autopilot/AutopilotState.test.ts`
- Modify: `apps/web/src/TestWeb.ts` (`slateMessage` takes classifications)
- Modify: `packages/api/src/Hotkey.ts`, `packages/api/src/Hotkey.test.ts`
- Modify: `apps/web/src/display/Display.ts`, `apps/web/src/display/Display.test.ts`
- Modify: `apps/web/src/display/DisplayState.ts`, `apps/web/src/display/DisplayState.test.ts`
- Modify: `apps/web/src/display/DisplayView.tsx`

**Interfaces:**
- Consumes: `Autopilot` (Task 1): `toggle(screen)`, `manual(command, after, now)`, `step(screen, classifications, now)`, `nextDeadline(now)`, `Autopilot.off`; `TestWeb.classified`, `TestWeb.redZone`.
- Produces:
  - `AutopilotState.autopilot: Atom.Writable<Autopilot, AutopilotInput>`
  - `AutopilotInput` = `Toggled | Commanded { command: ScreenCommand; screen: Screen } | Ticked` (`Data.taggedEnum`)
  - `AutopilotState.pilot`: the driver atom, mounted by the Display.
  - `Hotkey` case `ToggleAutopilot: {}`, read from `KeyA`.

- [ ] **Step 1: Let `TestWeb.slateMessage` carry classifications**

In `apps/web/src/TestWeb.ts`, replace `slateMessage` with:

```ts
/**
 * A slate message's `data`, as the Hub sends it: the slate of `entries`' games, each one's availability, and the
 * classification of each that has one.
 */
export function slateMessage(
  entries: ReadonlyArray<{
    game: Game
    availability: ReadonlyArray<ChannelAvailability>
    classification?: Classification
  }>
) {
  const slate = new Slate({ games: entries.map(({ game }) => game) })
  const availability = Record.fromEntries(
    entries.map(({ game, availability }) => [game.snapshot.id, availability] as const)
  )
  const classifications = Record.fromEntries(
    entries.flatMap(({ game, classification }) =>
      classification === undefined ? [] : [[game.snapshot.id, classification] as const]
    )
  )
  return encodeLiveMessage({ _tag: "SlateChanged", slate, availability, classifications })
}
```

- [ ] **Step 2: Write the failing hotkey tests**

In `packages/api/src/Hotkey.test.ts`, add to the `it.each` table of letters:

```ts
    { code: "KeyA", hotkey: { _tag: "ToggleAutopilot" } },
```

and to the `wire` array:

```ts
  { _tag: "ToggleAutopilot" },
```

In `apps/web/src/display/Display.test.ts`, beside the FullScreen test (around line 466), add:

```ts
  it("should return the same display with ToggleAutopilot and send nothing", () => {
    const { display, commands } = press(Display.initial, { _tag: "ToggleAutopilot" }, TestWeb.withTiles([]))

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })
```

(Match the FullScreen test's assertions exactly; if it asserts differently, mirror it.)

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run packages/api/src/Hotkey.test.ts apps/web/src/display/Display.test.ts`
Expected: FAIL: `KeyA` reads as `undefined`; `ToggleAutopilot` is not a `Hotkey`.

- [ ] **Step 4: Add the hotkey**

In `packages/api/src/Hotkey.ts`:
- Add the case after `NextLayout: {},`:

```ts
    /** Turn this Display's autopilot on or off. */
    ToggleAutopilot: {},
```

- In `of`, after the `KeyL` case:

```ts
        case "KeyA":
          return { _tag: "ToggleAutopilot" }
```

- In `keys`, after the `NextLayout` binding:

```ts
      {
        group: "Screen",
        keys: ["A"],
        does: "Turn the autopilot on or off",
        press: { code: "KeyA", from: "stream" },
        hotkey: { _tag: "ToggleAutopilot" }
      },
```

In `apps/web/src/display/Display.ts`, in `press`, after `FullScreen: () => DisplayStep.of(this)`:

```ts
      ToggleAutopilot: () => DisplayStep.of(this)
```

and change the `press` doc comment to:

```ts
  /**
   * What a hotkey does. `FullScreen` and `ToggleAutopilot` do nothing here: the first is the shell's or browser's,
   * the second the autopilot's.
   */
```

- [ ] **Step 5: Run them to see them pass**

Run: `pnpm vitest run packages/api/src/Hotkey.test.ts apps/web/src/display/Display.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing autopilot-state tests**

Create `apps/web/src/autopilot/AutopilotState.test.ts`:

```ts
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Game, GameId } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import type { Screen } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import { AutopilotInput } from "./AutopilotState.ts"
import * as AutopilotState from "./AutopilotState.ts"

const home = GameId.make("home")
const other = GameId.make("other")
const homeGame = Game.of(snapshot({ id: home, status: "live" }))
const otherGame = Game.of(snapshot({ id: other, status: "live" }))

/** A slate of the two games, both on FOX: home in plain live play, `other` classified as given. */
function slate(otherClassification = TestWeb.classified({ _tag: "Live" })) {
  return TestWeb.slateMessage([
    { game: homeGame, availability: TestWeb.onFox(), classification: TestWeb.classified({ _tag: "Live" }) },
    { game: otherGame, availability: TestWeb.onFox(), classification: otherClassification }
  ])
}

/** Home in the main tile and `other` beside it, once the live stream has brought `message`. */
const arranged = (message: unknown) =>
  Effect.gen(function* () {
    const source = yield* TestWeb.opened
    source.onmessage?.({ data: message })
    yield* TestWeb.until(LiveStream.live, (live) => live.slate.games.length > 0)
    yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 0, game: home })
    yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 1, game: other })
    return source
  })

function mainGame(screen: Screen) {
  const tile = screen.tiles[0]
  return tile === undefined || tile._tag === "Empty" ? undefined : tile.game
}

describe("AutopilotState", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should promote a red zone on another tile as soon as it is turned on", () =>
    Effect.gen(function* () {
      yield* arranged(slate(TestWeb.classified(TestWeb.redZone)))

      yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())

      const screen = yield* Atom.get(DisplayScreen.screen)
      assert.strictEqual(mainGame(screen), other)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should promote a red zone a slate brings while it is on", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const screen = yield* Effect.gen(function* () {
        const source = yield* arranged(slate())
        yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())
        yield* Atom.mount(AutopilotState.pilot)

        source.onmessage?.({ data: slate(TestWeb.classified(TestWeb.redZone)) })
        return yield* TestWeb.until(DisplayScreen.screen, (screen) => mainGame(screen) === other)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(mainGame(screen), other)
    })
  )

  it.effect("should keep the autopilot in this browser", () =>
    Effect.gen(function* () {
      yield* arranged(slate())
      yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())

      const kept = localStorage.getItem("sportal/autopilot")

      assert.include(kept ?? "", '"on":true')
    }).pipe(Effect.provide(AtomRegistry.layer))
  )
})
```

In `apps/web/src/display/DisplayState.test.ts` add the imports `import { Option } from "effect"` (merge with the existing `effect` import) and `import { AutopilotInput } from "../autopilot/AutopilotState.ts"` / `import * as AutopilotState from "../autopilot/AutopilotState.ts"`, then add:

```ts
  it.effect("should make the main tile yours when you promote a tile with the autopilot on", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.withTiles(["live", "soon"]))
      const { registry } = yield* TestWeb.withShell()

      const pilot = yield* Effect.gen(function* () {
        yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())
        yield* Atom.set(DisplayState.display, DisplayInput.Commanded({ command: { _tag: "Promote", tile: 1 } }))
        return yield* Atom.get(AutopilotState.autopilot)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(Option.isSome(pilot.suspended.main))
    })
  )

  it.effect("should turn the autopilot on for the ToggleAutopilot hotkey", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell({ hotkeys: Stream.make({ _tag: "ToggleAutopilot" }) })

      const pilot = yield* Effect.gen(function* () {
        yield* Atom.mount(DisplayState.inputs)
        return yield* TestWeb.until(AutopilotState.autopilot, (pilot) => pilot.on)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(pilot.on)
    })
  )
```

- [ ] **Step 7: Run them to see them fail**

Run: `pnpm vitest run apps/web/src/autopilot apps/web/src/display/DisplayState.test.ts`
Expected: FAIL, `Cannot find module './AutopilotState.ts'`.

- [ ] **Step 8: Write `apps/web/src/autopilot/AutopilotState.ts`**

```ts
import { Data, DateTime, Effect, Option, Stream } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import type { Screen, ScreenCommand } from "../screen/Screen.ts"
import { logDefect, runtime } from "../WebRuntime.ts"
import { Autopilot } from "./Autopilot.ts"

/** What moves the autopilot: turned on or off, a command you sent and the Screen after it, or time passing. */
export type AutopilotInput = Data.TaggedEnum<{
  Toggled: object
  Commanded: { readonly command: ScreenCommand; readonly screen: Screen }
  Ticked: object
}>
export const AutopilotInput = Data.taggedEnum<AutopilotInput>()

/**
 * This Display's autopilot, kept in this browser. A command you sent is recorded; turning it on or off, or a tick,
 * steps it against the Screen and the live classifications, and its commands go to the Screen.
 */
export const autopilot: Atom.Writable<Autopilot, AutopilotInput> = Atom.writable(
  (get) => get(kept),
  (ctx, input: AutopilotInput) => {
    const now = DateTime.nowUnsafe()
    const current = ctx.get(kept)
    if (AutopilotInput.$is("Commanded")(input)) {
      ctx.set(kept, current.manual(input.command, input.screen, now))
      return
    }
    const screen = ctx.get(DisplayScreen.screen)
    const moved = AutopilotInput.$is("Toggled")(input) ? current.toggle(screen) : current
    const [next, commands] = moved.step(screen, ctx.get(LiveStream.live).classifications, now)
    Atom.batch(() => {
      ctx.set(kept, next)
      for (const command of commands) ctx.set(DisplayScreen.screen, command)
    })
  }
).pipe(Atom.keepAlive)

/** Steps the autopilot on each live update and at its next deadline. Mounted once, by the Display. */
export const pilot = runtime.atom((get) =>
  Effect.gen(function* () {
    const deadlines = get
      .stream(autopilot)
      .pipe(Stream.switchMap((current) => Stream.fromEffect(untilDeadline(current))))

    yield* Stream.merge(get.stream(LiveStream.live), deadlines).pipe(
      Stream.runForEach(() => Effect.sync(() => get.set(autopilot, AutopilotInput.Ticked())))
    )
  }).pipe(logDefect("The autopilot"))
)

/** Waits until `current`'s next deadline; forever, when it has none. */
function untilDeadline(current: Autopilot): Effect.Effect<void> {
  return Effect.gen(function* () {
    const now = yield* DateTime.now
    yield* Option.match(current.nextDeadline(now), {
      onNone: () => Effect.never,
      onSome: (at) => Effect.sleep(DateTime.distance(now, at))
    })
  })
}

const kept = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: "sportal/autopilot",
  schema: Autopilot,
  defaultValue: () => Autopilot.off
}).pipe(Atom.keepAlive)
```

- [ ] **Step 9: Wire it into the Display**

In `apps/web/src/display/DisplayState.ts`, import `import * as AutopilotState from "../autopilot/AutopilotState.ts"` and `import { AutopilotInput } from "../autopilot/AutopilotState.ts"`. Replace the `display` writer's batch with:

```ts
    Atom.batch(() => {
      ctx.set(kept, step.display)
      for (const command of step.commands) {
        ctx.set(DisplayScreen.screen, command)
        ctx.set(
          AutopilotState.autopilot,
          AutopilotInput.Commanded({ command, screen: ctx.get(DisplayScreen.screen) })
        )
      }
    })
```

and extend its doc comment's last sentence to: "the next Display is kept, and the step's screen commands go to the Screen and, as yours, to the autopilot."

In `inputs`, replace the `Effect.sync` body with:

```ts
        Effect.sync(() => {
          if (DisplayInput.$is("Pressed")(input) && Hotkey.guards.FullScreen(input.hotkey))
            get.set(toggleFullScreen, undefined)
          else if (DisplayInput.$is("Pressed")(input) && Hotkey.guards.ToggleAutopilot(input.hotkey))
            get.set(AutopilotState.autopilot, AutopilotInput.Toggled())
          else get.set(display, input)
        })
```

and its doc comment to: "The hotkeys and video presses the Shell reports, as this Display's inputs; the `FullScreen` hotkey toggles full screen and `ToggleAutopilot` the autopilot. Mounted once, by the Display."

In `apps/web/src/display/DisplayView.tsx`, import `import * as AutopilotState from "../autopilot/AutopilotState.ts"` and add after `useAtomMount(Covering.sync)`:

```ts
  useAtomMount(AutopilotState.pilot)
```

- [ ] **Step 10: Run the tests to see them pass**

Run: `pnpm vitest run apps/web/src/autopilot apps/web/src/display`
Expected: PASS.

- [ ] **Step 11: Run the whole check**

Run: `pnpm biome check --write apps/web/src packages/api/src && pnpm check`
Expected: PASS, except that knip may still report `Autopilot.status` / `AutopilotStatus` unused in production (Task 3 consumes them). If depcruise rejects `display → autopilot`, report it; `autopilot` must not import from `display` (only `display` imports `autopilot`).

- [ ] **Step 12: Commit**

```bash
git add apps/web/src packages/api/src
git commit -m "feat(web): the autopilot steers the Display's Screen, A turns it on, and your commands win

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The toggle, and the docs

**Files:**
- Create: `apps/web/src/autopilot/AutopilotToggle.tsx`
- Create: `apps/web/src/autopilot/AutopilotToggle.test.ts`
- Modify: `apps/web/src/display/TopBar.tsx`
- Modify: `docs/adr/0015-each-display-owns-its-screen.md`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `Autopilot.status(now)`, `AutopilotStatus` (Task 1); `AutopilotState.autopilot`, `AutopilotInput.Toggled` (Task 2); `LiveStream.live` (`slate`, `classifications`); `Slate.gameOf(id): Option<Game>`.
- Produces: `AutopilotToggle(props: { autopilot: Autopilot; slate: Slate; classifications: SlateChanged["classifications"]; now: DateTime.Utc; onToggle: () => void })`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/autopilot/AutopilotToggle.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Game, GameId } from "@sportal/domain/Game"
import { Slate } from "@sportal/domain/Slate"
import { liveSnapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Duration, Option, Record } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as TestWeb from "../TestWeb.ts"
import { Autopilot } from "./Autopilot.ts"
import { AutopilotToggle } from "./AutopilotToggle.tsx"

const now = DateTime.makeUnsafe("2026-10-10T20:00:00Z")
const dal = GameId.make("dal")
const slate = new Slate({
  games: [
    Game.of(
      liveSnapshot({ id: dal, home: { team: team("DAL"), score: 0 }, away: { team: team("PHI"), score: 0 } })
    )
  ]
})

function titleOf(autopilot: Autopilot, classifications = {}) {
  const markup = renderToStaticMarkup(
    createElement(AutopilotToggle, { autopilot, slate, classifications, now, onToggle: () => {} })
  )
  return /title="([^"]*)"/.exec(markup)?.[1]
}

describe("AutopilotToggle", () => {
  it("should say it is off", () => {
    const title = titleOf(Autopilot.off)

    assert.strictEqual(title, "Autopilot off · A")
  })

  it("should name the game it is away on and why", () => {
    const away = new Autopilot({
      ...Autopilot.off,
      on: true,
      away: { main: Option.some({ game: dal, since: now }), audio: Option.none() }
    })

    const title = titleOf(away, Record.fromEntries([[dal, TestWeb.classified(TestWeb.redZone)] as const]))

    assert.strictEqual(title, "Autopilot on: away on PHI @ DAL — red zone · A")
  })

  it("should say for how long the main tile is yours", () => {
    const yours = new Autopilot({
      ...Autopilot.off,
      on: true,
      suspended: { main: Option.some(DateTime.addDuration(now, Duration.seconds(161))), audio: Option.none() }
    })

    const title = titleOf(yours)

    assert.strictEqual(title, "Autopilot on: main tile yours for 2:41 · A")
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/web/src/autopilot/AutopilotToggle.test.ts`
Expected: FAIL, `Cannot find module './AutopilotToggle.tsx'`.

- [ ] **Step 3: Write `apps/web/src/autopilot/AutopilotToggle.tsx`**

```tsx
import type { SlateChanged } from "@sportal/api/LiveMessage"
import type { GameId } from "@sportal/domain/Game"
import type { Slate } from "@sportal/domain/Slate"
import { DateTime, Duration, Option } from "effect"
import { Radar } from "lucide-react"
import { Button } from "@/design/button"
import { type Autopilot, AutopilotStatus } from "./Autopilot.ts"

/** The top bar's autopilot switch: on or off, with what it is doing as its tooltip. */
export function AutopilotToggle(props: {
  autopilot: Autopilot
  slate: Slate
  classifications: SlateChanged["classifications"]
  now: DateTime.Utc
  onToggle: () => void
}) {
  const { autopilot, slate, classifications, now } = props
  const nameOf = (game: GameId) =>
    Option.match(slate.gameOf(game), {
      onNone: () => "a game",
      onSome: ({ snapshot }) => `${snapshot.away.team.abbreviation} @ ${snapshot.home.team.abbreviation}`
    })
  const doing = AutopilotStatus.$match(autopilot.status(now), {
    Off: () => "Autopilot off",
    Idle: () => "Autopilot on: following, nothing to chase",
    Away: ({ game }) => `Autopilot on: away on ${nameOf(game)} — ${whyAway(classifications[game]?.moment._tag)}`,
    Yours: ({ part, until }) =>
      `Autopilot on: ${part === "main" ? "main tile" : "sound"} yours for ${countdown(DateTime.distance(now, until))}`
  })

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-keyshortcuts="A"
      aria-pressed={autopilot.on}
      title={`${doing} · A`}
      className={`label-caps text-xs ${autopilot.on ? "bg-accent" : ""}`}
      onClick={props.onToggle}
    >
      <Radar />
      Auto
      <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">A</kbd>
    </Button>
  )
}

function whyAway(moment: string | undefined): string {
  return moment === "ScoringThreat" ? "red zone" : moment === "CrunchTime" ? "crunch time" : "home is on a break"
}

/** A duration as minutes and seconds, `2:41`, rounded up. */
function countdown(left: Duration.Duration): string {
  const seconds = Math.ceil(Duration.toSeconds(left))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
```

- [ ] **Step 4: Put it in the top bar**

In `apps/web/src/display/TopBar.tsx`:
- import `import { DateTime } from "effect"` (merge with the existing `Option` import), `import * as AutopilotState from "../autopilot/AutopilotState.ts"`, `import { AutopilotInput } from "../autopilot/AutopilotState.ts"`, `import { AutopilotToggle } from "../autopilot/AutopilotToggle.tsx"`;
- read `const autopilot = useAtomValue(AutopilotState.autopilot)` and `const steer = useAtomSet(AutopilotState.autopilot)`, and take `classifications` too from `useAtomValue(LiveStream.live)`;
- after the Solo `<Button>`, add:

```tsx
      <AutopilotToggle
        autopilot={autopilot}
        slate={slate}
        classifications={classifications}
        now={DateTime.nowUnsafe()}
        onToggle={() => steer(AutopilotInput.Toggled())}
      />
```

- change the component's doc comment to: "The strip across the top of a Display: the slate, layout, solo, the autopilot, full screen, and whether the Hub is live."

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm vitest run apps/web/src/autopilot`
Expected: PASS.

- [ ] **Step 6: The docs**

In `docs/adr/0015-each-display-owns-its-screen.md`, append to the Consequences paragraph that begins "Two sources for one game": a new sentence at its end:

```
The autopilot (2026-10-10) reads the classifications on the slate as that ranking; there is no separate one yet.
```

In `CONTEXT.md`, add rows to the glossary table, next to the Classifier/Moment rows, in the table's format (`| **Term** | Meaning | Not |`):

```
| **Autopilot** | A Display's follower of the classifications: promotes the best moment into the main tile and moves the sound with it, then goes home. Off by default; your commands win. | director, auto-switcher |
| **Home** | What you chose: the main tile's game and the game whose sound is on, taken after each command you send. | default, base |
| **Away** | A game the autopilot moved the main tile or sound to, held at least 30 s unless it stops. | jump, cut |
| **Suspension** | The 3 min a command you send keeps the autopilot off the main tile or the sound it touched. | pause, lock |
```

- [ ] **Step 7: Run the whole check**

Run: `pnpm biome check --write apps/web/src CONTEXT.md docs && pnpm check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src docs/adr CONTEXT.md
git commit -m "feat(web): an autopilot toggle in the top bar that says what it is doing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
