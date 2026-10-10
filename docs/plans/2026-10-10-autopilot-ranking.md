# Autopilot Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The autopilot drops home: the main tile shows the best game by one ranking, held for a dwell; every decision goes to Grafana; timeline tests replay scripted game days.

**Architecture:** The classifier first stops a big play hiding the break after it (`Break.after`). In the web app, a pure `Ranking` module ranks moments; the `Autopilot` fold is rewritten around it (fit, then the main tile by rank and dwell, then the sound) and returns a `Decision` per step. `AutopilotState` keeps the latest decision in an atom and logs each new one; the web runtime ships logs over OTLP to the Hub, which relays them to the collector.

**Tech Stack:** TypeScript 7 (tsgo), Effect 4 (`Schema.Class`, `Data.taggedEnum`, `Option`, `DateTime`, `Duration`, `Order`, `Stream`, `effect/observability` `OtlpLogger`, `effect/http` `HttpRouter`), `effect/reactivity` atoms, React, `@effect/vitest`, biome (line width 110).

Spec: `docs/specs/2026-10-10-autopilot-ranking-design.md`.

## Global Constraints

- Ranks, best first: `redZone` (`ScoringThreat`), `crunchTime` (`CrunchTime`), `bigPlay` (`BigPlay`), `live` (`Live`, or no classification), `break` (`Break`), `notLive` (`Upcoming`, `Final`). The first four are live. Within a rank: higher score first, then the lower tile.
- The main tile's game gives way to the best game when it has stopped (break, not live, or an empty main tile), or when the best game's rank is strictly higher and the main game has held the tile `Autopilot.dwell` = 30 s. Never within a rank. With no live game on any tile, nothing moves.
- The dwell clock starts whenever the autopilot sees a main game it did not see at its last step, whoever put it there.
- The sound follows the main tile; while the sound is yours, a promote of the autopilot's is followed by a `FocusAudio` back to the game you had on, while it is on screen.
- `Autopilot.suspension` = 3 min per part. Suspends main: `Promote`, `Solo`, `Swap` with tile 0, `Assign`/`Clear` of tile 0. Suspends sound: `FocusAudio`, `Solo`. Suspends layout: `SetLayout`, `Swap` of two tiles neither 0, `Assign`/`Clear` of another tile. Nothing else suspends. `SetLayout` you send sets the ceiling; turning it on takes the ceiling from the Screen.
- Fitting is as merged (`apps/web/src/autopilot/Fit.ts`, unchanged), runs first each step, under the ceiling.
- Off: nothing. Soloed: frozen, nothing.
- Kept under `sportal/autopilot`; a value kept before this change decodes with no `main` and no `ceiling`.
- The decision log: one `Effect.logInfo` per new decision, its message `Autopilot: ` + the decision in words; a decision with the same words as the last one logged is not logged again.
- Web logs go over OTLP to the Hub at `POST /api/telemetry/logs`, service name `sportal-web`; the Hub relays the body to `${SPORTAL_OTLP_URL}/v1/logs`, or answers `204` and drops it without one.
- Tests: `it("should …")`, one behaviour per test, arrange / act / assert separated by blank lines.
- Comments: doc comments on exports and major declarations only; an inline comment only for a genuinely unclear why.
- `pnpm check` (biome, tsgo, depcruise, knip, knip `--production`, vitest) passes at the end of every task; never edit tool config (knip.json, biome.json, depcruise) to silence it.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Work in `/home/chazzy/development/projects/sportal-autopilot-ranking` (branch `autopilot-ranking`). Run focused tests with `pnpm vitest run <path>` from there.

---

### Task 1: A break carries the big play before it

**Files:**
- Modify: `packages/domain/src/Moment.ts`, `packages/domain/src/Classifier.ts`, `apps/web/src/game/MomentBadge.tsx`
- Test: `packages/domain/src/Classifier.test.ts`

**Interfaces:**
- Produces: `Moment` case `Break` gains `after?: { play: PlayId, kind: BigPlayKind }`.

- [ ] **Step 1: Change the tests**

In `packages/domain/src/Classifier.test.ts` (it has `id`, `at`, `later(seconds)`, `playId(sequence)`, `slateOf`, `played`, `reasonOf` at the bottom; import `Interception` from `./Play.ts` and `playFields` is already imported from `./TestGame.ts`):

Replace the test "should put a touchdown's big play before the break after the score" with:

```ts
  it("should call a touchdown a break after the score", () => {
    const touchdown = play({ yards: 2, touchdown: true, scoring: true })

    const [, classified] = Classifier.empty.step(
      slateOf(liveSnapshot({ id }), [touchdown]),
      [played(touchdown)],
      at
    )

    assert.strictEqual(reasonOf(classified), "afterScore")
  })

  it("should carry a touchdown on the break after the score", () => {
    const touchdown = play({ yards: 2, touchdown: true, scoring: true })

    const [, classified] = Classifier.empty.step(
      slateOf(liveSnapshot({ id }), [touchdown]),
      [played(touchdown)],
      at
    )

    const moment = classified.get(id)?.moment
    assert.strictEqual(moment?._tag === "Break" ? moment.after?.kind : undefined, "touchdown")
  })

  it("should call a turnover a break for the change of possession", () => {
    const pick = new Interception({ ...playFields, team: playFields.start.team, yards: 0, return: "returned" })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [pick]), [played(pick)], at)

    assert.strictEqual(reasonOf(classified), "possessionChange")
  })

  it("should not wait to go from a big play to a break", () => {
    const big = completion({ yards: 40 })
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [big]), [played(big)], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [big, timeout({ id: playId(2), sequence: 2 })]), [], later(5))

    assert.strictEqual(reasonOf(classified), "timeout")
  })

  it("should let the big play go from a break when it runs out, keeping the break's since", () => {
    const touchdown = play({ yards: 2, touchdown: true, scoring: true })
    const [first] = Classifier.empty.step(
      slateOf(liveSnapshot({ id }), [touchdown]),
      [played(touchdown)],
      at
    )

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [touchdown]), [], later(61))

    const moment = classified.get(id)?.moment
    assert.isTrue(
      moment?._tag === "Break" &&
        moment.after === undefined &&
        DateTime.Equivalence(classified.get(id)?.since ?? later(61), at)
    )
  })
```

The existing "should call a game a big play when a play it did not have is one" (a 40-yard completion, no stop) stays: a long gain mid-drive is still `BigPlay`. Run the whole file afterwards: any other test that expected `BigPlay` where a break reason now holds must be changed to expect the `Break` (with `after`), and named for it; report each one you change.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/domain/src/Classifier.test.ts`
Expected: FAIL on the new tests (a touchdown is still `BigPlay`; `after` does not exist).

- [ ] **Step 3: `Moment.ts`**

```ts
  /** A live game stopped, when it is likely back, what was at stake when it stopped, and the big play just before. */
  Break: {
    reason: reasons,
    expectedEnd: Schema.DateTimeUtcFromString,
    during: Schema.optional(Stakes),
    after: Schema.optional(Schema.Struct({ play: PlayId, kind: BigPlayKind }))
  },
```

- [ ] **Step 4: `Classifier.ts`**

`momentOf` checks for a break before a big play:

```ts
/** The highest moment that holds of `game` at `now`, which stalls at `stallAt` without a new play. */
function momentOf(
  game: Game,
  bigPlay: Followed["bigPlay"],
  stallAt: DateTime.Utc,
  now: DateTime.Utc
): Moment {
  const { snapshot } = game
  const progress = snapshot.progress()
  if (progress === "upcoming") return { _tag: "Upcoming" }
  if (progress === "over") return { _tag: "Final" }

  const stakes = stakesOf(snapshot)
  const reason = breakReason(game, DateTime.isGreaterThanOrEqualTo(now, stallAt))
  if (reason === undefined) {
    if (bigPlay !== undefined) return { _tag: "BigPlay", play: bigPlay.play, kind: bigPlay.kind }
    return stakes ?? { _tag: "Live" }
  }
  const expectedEnd = DateTime.addDuration(now, BreakReason.typicalLength(reason, snapshot.league))
  return {
    _tag: "Break",
    reason,
    expectedEnd,
    ...(stakes === undefined ? {} : { during: stakes }),
    ...(bigPlay === undefined ? {} : { after: { play: bigPlay.play, kind: bigPlay.kind } })
  }
}
```

`settled`: entering a break never waits. Its doc's "Leaving a break or going not live never waits" becomes "Entering or leaving a break, or going not live, never waits", and:

```ts
  const free =
    candidate._tag === "Upcoming" ||
    candidate._tag === "Final" ||
    candidate._tag === "Break" ||
    moment._tag === "Break"
```

The same-reason branch already keeps `since` and `expectedEnd` and takes the candidate's other fields, so `after` drops when the big play runs out.

- [ ] **Step 5: `MomentBadge.tsx`**

A break with `after` shows the big play's mark before `BRK`:

```tsx
    Break: ({ during, after }) => (
      <span className="label-caps inline-flex items-center gap-0.5 text-[9px] text-muted-foreground">
        {after === undefined ? null : <Zap aria-label="Big play" className="size-3 text-on-air" />}
        {during === undefined ? "BRK" : `BRK · ${during._tag === "ScoringThreat" ? "RZ" : "CT"}`}
      </span>
    ),
```

If `MomentBadge` has a test file asserting the break's markup, add one test: "should mark a break after a big play" asserting the `Big play` label is present.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/domain apps/web/src/game`
Expected: PASS.

- [ ] **Step 7: Check and commit**

Run: `pnpm check` — fully green.

```bash
git add packages/domain apps/web/src/game
git commit -m "fix(domain): a break wins over the big play before it, and carries it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The ranking autopilot

**Files:**
- Create: `apps/web/src/autopilot/Ranking.ts`, `apps/web/src/autopilot/Ranking.test.ts`, `apps/web/src/autopilot/Decision.ts`
- Rewrite: `apps/web/src/autopilot/Autopilot.ts`, `apps/web/src/autopilot/Autopilot.test.ts`
- Modify: `apps/web/src/autopilot/AutopilotState.ts`, `AutopilotState.test.ts`, `AutopilotToggle.tsx`, `AutopilotToggle.test.ts`, `apps/web/src/display/DisplayState.ts`, `apps/web/src/TestWeb.ts`, `CONTEXT.md`, `docs/specs/2026-10-10-autopilot-design.md`, `docs/specs/2026-10-10-autopilot-ranking-design.md`

**Interfaces:**
- Consumes: `fit`, `nextFit` from `./Fit.ts`; `Moment` (with `Break.after`, Task 1).
- Produces:
  - `Ranking.ts`: `type Rank`, `rankOf(moment: Moment | undefined): Rank`, `isLive(rank): boolean`, `outranks(a: Rank, b: Rank): boolean`, `byRank(classifications): Order.Order<{ tile: number; game: GameId }>`, `label(rank): string`.
  - `Decision.ts`: `Decision` (`Off | Frozen | Stepped { ranking, layout, main, sound }`), `LayoutDecision`, `MainDecision`, `StayReason`, `SoundDecision`, `Ranked`.
  - `Autopilot`: fields `on`, `main: Option<{ game, since }>`, `ceiling: Option<LayoutName>`, `suspended: { main, audio, layout }`; `toggle(screen)`; `manual(command, now)`; `step(screen, classifications, now): Step` with `Step = { next, commands, decision }`; `nextDeadline(now, screen, classifications)`; `status(now, screen, classifications): AutopilotStatus` (`Off | Yours { part, until } | NothingLive { fitted } | Following { game, rank, fitted }`, `fitted: Option<number>`); `type Part`.
  - `AutopilotInput.Commanded({ command })` (no `screen` any more).
  - `TestWeb.classified(moment, score = 50, since = 2026-10-10T20:00Z)`.

- [ ] **Step 1: `Ranking.ts` and its tests**

`apps/web/src/autopilot/Ranking.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { DateTime, Record } from "effect"
import * as TestWeb from "../TestWeb.ts"
import { byRank, isLive, outranks, rankOf } from "./Ranking.ts"

const timeout: Moment = { _tag: "Break", reason: "timeout", expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z") }

describe("rankOf", () => {
  it("should rank a red zone first", () => {
    assert.strictEqual(rankOf(TestWeb.redZone), "redZone")
  })

  it("should rank a game with no classification as live", () => {
    assert.strictEqual(rankOf(undefined), "live")
  })

  it("should rank a break below every live rank", () => {
    assert.isFalse(isLive(rankOf(timeout)))
  })

  it("should rank a final game not live", () => {
    assert.strictEqual(rankOf({ _tag: "Final" }), "notLive")
  })
})

describe("outranks", () => {
  it("should hold of crunch time over a big play", () => {
    assert.isTrue(outranks("crunchTime", "bigPlay"))
  })

  it("should not hold within a rank", () => {
    assert.isFalse(outranks("redZone", "redZone"))
  })
})

describe("byRank", () => {
  it("should put a higher rank first, whatever the scores", () => {
    const [a, b] = [GameId.make("a"), GameId.make("b")]
    const classifications = Record.fromEntries([
      [a, TestWeb.classified({ _tag: "Live" }, 90)],
      [b, TestWeb.classified(TestWeb.redZone, 10)]
    ])

    const sorted = [
      { tile: 0, game: a },
      { tile: 1, game: b }
    ].toSorted(byRank(classifications))

    assert.deepStrictEqual(sorted.map(({ game }) => game), [b, a])
  })

  it("should put the higher score first within a rank", () => {
    const [a, b] = [GameId.make("a"), GameId.make("b")]
    const classifications = Record.fromEntries([
      [a, TestWeb.classified({ _tag: "Live" }, 40)],
      [b, TestWeb.classified({ _tag: "Live" }, 60)]
    ])

    const sorted = [
      { tile: 0, game: a },
      { tile: 1, game: b }
    ].toSorted(byRank(classifications))

    assert.deepStrictEqual(sorted.map(({ game }) => game), [b, a])
  })

  it("should put the lower tile first on a tie", () => {
    const [a, b] = [GameId.make("a"), GameId.make("b")]

    const sorted = [
      { tile: 3, game: a },
      { tile: 1, game: b }
    ].toSorted(byRank({}))

    assert.deepStrictEqual(sorted.map(({ game }) => game), [b, a])
  })
})
```

`apps/web/src/autopilot/Ranking.ts`:

```ts
import type { SlateChanged } from "@sportal/api/LiveMessage"
import type { GameId } from "@sportal/domain/Game"
import { Moment } from "@sportal/domain/Moment"
import { Order } from "effect"

const ranks = ["redZone", "crunchTime", "bigPlay", "live", "break", "notLive"] as const

/** How worth showing a game is now: a red zone, crunch time, a big play, live play, a break, not live. */
export type Rank = (typeof ranks)[number]

/** A moment's rank; a game with no classification counts as live. */
export function rankOf(moment: Moment | undefined): Rank {
  if (moment === undefined) return "live"
  return Moment.match(moment, {
    ScoringThreat: () => "redZone",
    CrunchTime: () => "crunchTime",
    BigPlay: () => "bigPlay",
    Live: () => "live",
    Break: () => "break",
    Upcoming: () => "notLive",
    Final: () => "notLive"
  })
}

/** Whether a game in `rank` is in play: any rank above a break. */
export function isLive(rank: Rank): boolean {
  return outranks(rank, "break")
}

/** Whether `a` is a strictly higher rank than `b`. */
export function outranks(a: Rank, b: Rank): boolean {
  return ranks.indexOf(a) < ranks.indexOf(b)
}

/** The best first: the higher rank, then the higher score, then the lower tile. */
export function byRank(
  classifications: SlateChanged["classifications"]
): Order.Order<{ readonly tile: number; readonly game: GameId }> {
  return Order.combine(
    Order.mapInput(Order.Number, ({ game }) => ranks.indexOf(rankOf(classifications[game]?.moment))),
    Order.combine(
      Order.mapInput(Order.Number, ({ game }) => -(classifications[game]?.score ?? 0)),
      Order.mapInput(Order.Number, ({ tile }) => tile)
    )
  )
}

/** A rank as people read it. */
export function label(rank: Rank): string {
  return labels[rank]
}

const labels = {
  redZone: "red zone",
  crunchTime: "crunch time",
  bigPlay: "big play",
  live: "live",
  break: "on a break",
  notLive: "not live"
} satisfies Record<Rank, string>
```

Run: `pnpm vitest run apps/web/src/autopilot/Ranking.test.ts` — fails before `Ranking.ts` exists, passes after.

- [ ] **Step 2: `Decision.ts`**

```ts
import type { GameId } from "@sportal/domain/Game"
import { Data, type DateTime, type Duration, Option } from "effect"
import type { LayoutName } from "../screen/Screen.ts"
import type { Rank } from "./Ranking.ts"

/** A game on a tile, with its rank and score, as a step saw it. */
export interface Ranked {
  readonly game: GameId
  readonly rank: Rank
  readonly score: number
}

/** What a step did with the layout: fitted it, kept it, left it to you, or had no ceiling to fit under. */
export type LayoutDecision = Data.TaggedEnum<{
  Fitted: { readonly from: LayoutName; readonly to: LayoutName }
  Kept: { readonly layout: LayoutName }
  Yours: { readonly until: DateTime.Utc }
  NoCeiling: object
}>
export const LayoutDecision = Data.taggedEnum<LayoutDecision>()

/** Why the main tile kept its game: it is the best, nothing ranks higher, its dwell, it is yours, or nothing is live. */
export type StayReason = Data.TaggedEnum<{
  Best: object
  SameRank: object
  Dwell: { readonly left: Duration.Duration }
  Yours: { readonly until: DateTime.Utc }
  NothingLive: object
}>
export const StayReason = Data.taggedEnum<StayReason>()

/** What a step did with the main tile: promoted a game over the one there, and why, or kept it, and why. */
export type MainDecision = Data.TaggedEnum<{
  Promoted: {
    readonly game: GameId
    readonly over: Option.Option<GameId>
    readonly why: "outranks" | "stopped"
  }
  Stayed: { readonly game: Option.Option<GameId>; readonly why: StayReason }
}>
export const MainDecision = Data.taggedEnum<MainDecision>()

/** Where a step left the sound: on the main tile's game, or yours. */
export type SoundDecision = Data.TaggedEnum<{
  OnMain: { readonly game: Option.Option<GameId> }
  Yours: { readonly until: DateTime.Utc }
}>
export const SoundDecision = Data.taggedEnum<SoundDecision>()

/**
 * What one step of the autopilot decided and why, for its log: off, frozen (the Screen soloed), or what it did with
 * each part, with the ranking it saw.
 */
export type Decision = Data.TaggedEnum<{
  Off: object
  Frozen: object
  Stepped: {
    readonly ranking: ReadonlyArray<Ranked>
    readonly layout: LayoutDecision
    readonly main: MainDecision
    readonly sound: SoundDecision
  }
}>
export const Decision = Data.taggedEnum<Decision>()
```

(`explain` and `details`, for the log, come in Task 4. `Option` is used in Task 4; if knip or biome flags an unused import now, import `type Option` until then.)

- [ ] **Step 3: Rewrite `Autopilot.ts`**

Replace the whole file:

```ts
import type { SlateChanged } from "@sportal/api/LiveMessage"
import { GameId } from "@sportal/domain/Game"
import { Array as Arr, Data, DateTime, Duration, Equal, Option, Result, Schema } from "effect"
import { LayoutName, Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"
import { Decision, LayoutDecision, MainDecision, type Ranked, SoundDecision, StayReason } from "./Decision.ts"
import { fit, nextFit } from "./Fit.ts"
import { byRank, isLive, outranks, type Rank, rankOf } from "./Ranking.ts"

type Classifications = SlateChanged["classifications"]

/** What a command you send can make yours: the main tile, the sound or the layout. */
export type Part = "main" | "audio" | "layout"

/**
 * What the autopilot is doing, for its toggle to say: off, a part yours until a time, nothing live, or following the
 * main tile's game in its rank; `fitted` is the slot count of a layout fitted below the ceiling.
 */
export type AutopilotStatus = Data.TaggedEnum<{
  Off: object
  Yours: { readonly part: Part; readonly until: DateTime.Utc }
  NothingLive: { readonly fitted: Option.Option<number> }
  Following: { readonly game: GameId; readonly rank: Rank; readonly fitted: Option.Option<number> }
}>
export const AutopilotStatus = Data.taggedEnum<AutopilotStatus>()

/** One step: the next autopilot, the commands to send in order, and what it decided and why. */
export interface Step {
  readonly next: Autopilot
  readonly commands: ReadonlyArray<ScreenCommand>
  readonly decision: Decision
}

const Held = Schema.Struct({ game: GameId, since: Schema.DateTimeUtcFromString })
type Held = typeof Held.Type

/**
 * A Display's autopilot. While on, it fits the layout to the games worth showing, never past the ceiling (the layout
 * you chose), and shows the best game by the ranking in the main tile, the sound on it. The main tile's game holds
 * the tile for `dwell` against a game in a higher rank, and gives way at once when it stops. Each command you send
 * makes the part it touches yours for `suspension`. Pure.
 */
export class Autopilot extends Schema.Class<Autopilot>("sportal/Autopilot")({
  on: Schema.Boolean,
  /** The main tile's game at the last step, and since when it has held the tile. */
  main: Schema.OptionFromOptionalKey(Held),
  /** The layout you chose: the most the autopilot fits the layout to. */
  ceiling: Schema.OptionFromOptionalKey(LayoutName),
  /** Until when each part is yours. */
  suspended: Schema.Struct({
    main: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
    audio: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
    layout: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString)
  })
}) {
  static readonly off: Autopilot = new Autopilot({
    on: false,
    main: Option.none(),
    ceiling: Option.none(),
    suspended: { main: Option.none(), audio: Option.none(), layout: Option.none() }
  })

  /** How long the main tile's game holds the tile against a game in a higher rank, unless it stops. */
  static readonly dwell = Duration.seconds(30)

  /** How long a command you send keeps the autopilot off the part it touched. */
  static readonly suspension = Duration.minutes(3)

  /** On, the ceiling taken from `screen`; or off, everything forgotten. The Screen is left as it is. */
  toggle(screen: Screen): Autopilot {
    return this.on
      ? Autopilot.off
      : new Autopilot({ ...Autopilot.off, on: true, ceiling: Option.some(screen.layout) })
  }

  /** After `command`, which you sent at `now`: the parts it touches are yours for `suspension`; a `SetLayout` sets the ceiling. */
  manual(command: ScreenCommand, now: DateTime.Utc): Autopilot {
    if (!this.on) return this
    const touched = suspends(command)
    const until = Option.some(DateTime.addDuration(now, Autopilot.suspension))
    const yours = (part: Part) => (touched.includes(part) ? until : this.suspended[part])
    return new Autopilot({
      ...this,
      ceiling: command._tag === "SetLayout" ? Option.some(command.layout) : this.ceiling,
      suspended: { main: yours("main"), audio: yours("audio"), layout: yours("layout") }
    })
  }

  /**
   * One step at `now` on `screen` with each game's classification: it fits the layout unless the layout is yours,
   * then, on the fitted Screen, steers the main tile unless it is yours, then the sound. Off or soloed, nothing. When
   * nothing changed, `next` is this autopilot.
   */
  step(screen: Screen, classifications: Classifications, now: DateTime.Utc): Step {
    if (!this.on) return { next: this, commands: [], decision: Decision.Off() }
    if (Option.isSome(screen.solo)) return { next: this, commands: [], decision: Decision.Frozen() }
    const suspended = {
      main: running(this.suspended.main, now),
      audio: running(this.suspended.audio, now),
      layout: running(this.suspended.layout, now)
    }

    const [layout, fitted] = steerLayout(screen, this.ceiling, suspended.layout, classifications, now)
    const afterFit = afterAll(screen, fitted)
    const held = heldIn(afterFit, this.main, now)
    const [main, promoted] = steerMain(afterFit, held, suspended.main, classifications, now)
    const afterMain = afterAll(afterFit, promoted)
    const [sound, focused] = steerSound(afterMain, afterFit.audioFocus, suspended.audio)

    const next = new Autopilot({ ...this, suspended, main: heldIn(afterMain, held, now) })
    return {
      next: unchangedOr(this, next),
      commands: [...fitted, ...promoted, ...focused],
      decision: Decision.Stepped({ ranking: rankingOf(afterFit, classifications), layout, main, sound })
    }
  }

  /**
   * When the next step may change something with no new slate: the main game's dwell ending, a suspension ending, or
   * the hold of a game over on a tile of `screen` running out.
   */
  nextDeadline(now: DateTime.Utc, screen: Screen, classifications: Classifications): Option.Option<DateTime.Utc> {
    const times = [
      ...Option.toArray(Option.map(this.main, ({ since }) => DateTime.addDuration(since, Autopilot.dwell))),
      ...Option.toArray(this.suspended.main),
      ...Option.toArray(this.suspended.audio),
      ...Option.toArray(this.suspended.layout),
      ...(Option.isSome(this.ceiling) ? Option.toArray(nextFit(screen, classifications, now)) : [])
    ]
    return Arr.head(times.filter((time) => DateTime.isGreaterThan(time, now)).toSorted(DateTime.Order))
  }

  /** What it is doing at `now` on `screen`: a part yours (the main tile, the sound, then the layout), else what it follows. */
  status(now: DateTime.Utc, screen: Screen, classifications: Classifications): AutopilotStatus {
    if (!this.on) return AutopilotStatus.Off()
    for (const part of ["main", "audio", "layout"] as const) {
      const until = running(this.suspended[part], now)
      if (Option.isSome(until)) return AutopilotStatus.Yours({ part, until: until.value })
    }
    const fitted = Option.filter(this.ceiling, (ceiling) => ceiling !== screen.layout).pipe(
      Option.map(() => Screen.slotCount(screen.layout))
    )
    const game = gameIn(screen.tiles[0])
    const rank = game === undefined ? "notLive" : rankOf(classifications[game]?.moment)
    return game === undefined || !isLive(rank)
      ? AutopilotStatus.NothingLive({ fitted })
      : AutopilotStatus.Following({ game, rank, fitted })
  }
}

/** The layout fitted under `ceiling`, unless it is yours or there is none. */
function steerLayout(
  screen: Screen,
  ceiling: Option.Option<LayoutName>,
  yours: Option.Option<DateTime.Utc>,
  classifications: Classifications,
  now: DateTime.Utc
): readonly [LayoutDecision, ReadonlyArray<ScreenCommand>] {
  if (Option.isSome(yours)) return [LayoutDecision.Yours({ until: yours.value }), []]
  if (Option.isNone(ceiling)) return [LayoutDecision.NoCeiling(), []]
  const commands = fit(screen, ceiling.value, classifications, now)
  if (commands.length === 0) return [LayoutDecision.Kept({ layout: screen.layout }), []]
  return [LayoutDecision.Fitted({ from: screen.layout, to: afterAll(screen, commands).layout }), commands]
}

/**
 * The main tile, unless it is yours: the best game by the ranking takes it from a game that has stopped, or, after
 * the dwell, from a game in a lower rank. With no live game, nothing moves.
 */
function steerMain(
  screen: Screen,
  held: Option.Option<Held>,
  yours: Option.Option<DateTime.Utc>,
  classifications: Classifications,
  now: DateTime.Utc
): readonly [MainDecision, ReadonlyArray<ScreenCommand>] {
  const current = Option.map(held, ({ game }) => game)
  const stay = (why: StayReason): readonly [MainDecision, ReadonlyArray<ScreenCommand>] => [
    MainDecision.Stayed({ game: current, why }),
    []
  ]
  if (Option.isSome(yours)) return stay(StayReason.Yours({ until: yours.value }))

  const rank = (game: GameId) => rankOf(classifications[game]?.moment)
  const best = Arr.head(occupiedIn(screen.tiles).toSorted(byRank(classifications)))
  if (Option.isNone(best) || !isLive(rank(best.value.game))) return stay(StayReason.NothingLive())
  const { game, tile } = best.value
  if (Option.contains(current, game)) return stay(StayReason.Best())

  const promote = (why: "outranks" | "stopped"): readonly [MainDecision, ReadonlyArray<ScreenCommand>] => [
    MainDecision.Promoted({ game, over: current, why }),
    [{ _tag: "Promote", tile }]
  ]
  if (Option.isNone(held) || !isLive(rank(held.value.game))) return promote("stopped")
  if (!outranks(rank(game), rank(held.value.game))) return stay(StayReason.SameRank())
  const dwellEnd = DateTime.addDuration(held.value.since, Autopilot.dwell)
  return DateTime.isLessThan(now, dwellEnd)
    ? stay(StayReason.Dwell({ left: DateTime.distance(now, dwellEnd) }))
    : promote("outranks")
}

/**
 * The sound on the main tile's game; while the sound is yours, back on `heard` (the game it was on before the main
 * tile was steered) when a promote moved it and that game is still on screen.
 */
function steerSound(
  screen: Screen,
  heard: Option.Option<GameId>,
  yours: Option.Option<DateTime.Utc>
): readonly [SoundDecision, ReadonlyArray<ScreenCommand>] {
  if (Option.isSome(yours)) {
    const back = Option.flatMap(heard, (game) =>
      screen.hears(game) ? Option.none() : Option.fromUndefinedOr(screen.slotOf(game))
    )
    const commands: ReadonlyArray<ScreenCommand> = Option.match(back, {
      onNone: () => [],
      onSome: (tile) => [{ _tag: "FocusAudio", tile }]
    })
    return [SoundDecision.Yours({ until: yours.value }), commands]
  }
  const main = gameIn(screen.tiles[0])
  const commands: ReadonlyArray<ScreenCommand> =
    main === undefined || screen.hears(main) ? [] : [{ _tag: "FocusAudio", tile: 0 }]
  return [SoundDecision.OnMain({ game: Option.fromUndefinedOr(main) }), commands]
}

/** The main tile's game and since when it has held the tile: `held`'s while it is the same game, else from `now`. */
function heldIn(screen: Screen, held: Option.Option<Held>, now: DateTime.Utc): Option.Option<Held> {
  const game = gameIn(screen.tiles[0])
  if (game === undefined) return Option.none()
  return Option.exists(held, (was) => was.game === game) ? held : Option.some({ game, since: now })
}

/** Each occupied tile's game with its rank and score, best first. */
function rankingOf(screen: Screen, classifications: Classifications): ReadonlyArray<Ranked> {
  return occupiedIn(screen.tiles)
    .toSorted(byRank(classifications))
    .map(({ game }) => ({
      game,
      rank: rankOf(classifications[game]?.moment),
      score: classifications[game]?.score ?? 0
    }))
}

/** A suspension, while it still runs at `now`. */
function running(until: Option.Option<DateTime.Utc>, now: DateTime.Utc): Option.Option<DateTime.Utc> {
  return Option.filter(until, (time) => DateTime.isLessThan(now, time))
}

/** `current` when `next` is equal to it, so an idle step changes nothing; else `next`. */
function unchangedOr(current: Autopilot, next: Autopilot): Autopilot {
  return Equal.equals(current, next) ? current : next
}

/** The parts a command you send makes yours. */
function suspends(command: ScreenCommand): ReadonlyArray<Part> {
  switch (command._tag) {
    case "Promote":
      return ["main"]
    case "Solo":
      return ["main", "audio"]
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
  }
}

/** `screen` after the autopilot's own commands, none of which asks a game's availability. */
function afterAll(screen: Screen, commands: ReadonlyArray<ScreenCommand>): Screen {
  return commands.reduce(
    (current, command) =>
      Result.getOrElse(
        current.apply(command, () => []),
        () => current
      ),
    screen
  )
}

function occupiedIn(tiles: ReadonlyArray<Tile>) {
  return tiles.flatMap((tile, index) => (Tile.guards.Empty(tile) ? [] : [{ tile: index, game: tile.game }]))
}

function gameIn(tile: Tile | undefined): GameId | undefined {
  return tile === undefined || Tile.guards.Empty(tile) ? undefined : tile.game
}
```

- [ ] **Step 4: `TestWeb.classified` takes a since**

In `apps/web/src/TestWeb.ts`:

```ts
/** `moment` classified since `since` (2026-10-10 20:00 UTC unless given) with `score`, all of it from closeness. */
export function classified(
  moment: Moment,
  score = 50,
  since: DateTime.Utc = DateTime.makeUnsafe("2026-10-10T20:00:00Z")
): Classification {
  return new Classification({
    moment,
    score,
    since,
    breakdown: { prior: 0, closeness: score, swing: 0, upset: 0, momentBonus: 0 }
  })
}
```

- [ ] **Step 5: Rewrite `Autopilot.test.ts`**

Replace the whole file:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { DateTime, Duration, Option, Record, Result } from "effect"
import type { Screen, ScreenCommand } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import { Autopilot, AutopilotStatus } from "./Autopilot.ts"
import { Decision, MainDecision, StayReason } from "./Decision.ts"

const home = GameId.make("home")
const other = GameId.make("other")
const third = GameId.make("third")
const fourth = GameId.make("fourth")

const redZone = TestWeb.redZone
const live: Moment = { _tag: "Live" }
const final: Moment = { _tag: "Final" }
const timeout: Moment = {
  _tag: "Break",
  reason: "timeout",
  expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z")
}

const start = DateTime.makeUnsafe("2026-10-10T20:00:00Z")

function at(seconds: number) {
  return DateTime.addDuration(start, Duration.seconds(seconds))
}

/** `games` on tiles in order, in a Quad, the sound on the main tile. */
function screenOf(games: ReadonlyArray<GameId | undefined>): Screen {
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
  return commands.reduce(
    (current, command) => Result.getOrThrow(current.apply(command, TestWeb.onFox)),
    screen
  )
}

const quad = screenOf([home, other, third, fourth])
const on = Autopilot.off.toggle(quad)

/** The autopilot after a first step at the start, with home in plain live play holding the main tile. */
const holding = on.step(
  quad,
  classified([
    [home, live],
    [other, live],
    [third, live],
    [fourth, live]
  ]),
  start
).next

describe("Autopilot.step, the main tile", () => {
  it("should send nothing while off", () => {
    const { commands } = Autopilot.off.step(quad, classified([[home, timeout]]), start)

    assert.deepStrictEqual(commands, [])
  })

  it("should send nothing while the Screen is soloed", () => {
    const soloed = after(quad, [{ _tag: "Solo", tile: 1 }])

    const { commands } = on.step(soloed, classified([[home, timeout]]), start)

    assert.deepStrictEqual(commands, [])
  })

  it("should promote the best live game when the main tile's game is on a break", () => {
    const { commands } = on.step(
      quad,
      classified([
        [home, timeout],
        [other, live, 50],
        [third, live, 70],
        [fourth, live, 10]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 2 }])
  })

  it("should promote the best live game into an empty main tile", () => {
    const screen = screenOf([undefined, other, third, fourth])

    const { commands } = on.step(
      screen,
      classified([
        [other, live, 50],
        [third, live, 60],
        [fourth, live, 10]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 2 }])
  })

  it("should promote a higher rank once the main tile's game has held it for the dwell", () => {
    const { commands } = holding.step(
      quad,
      classified([
        [home, live],
        [other, redZone],
        [third, live],
        [fourth, live]
      ]),
      at(30)
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should wait out the dwell before a higher rank takes the main tile", () => {
    const { commands } = holding.step(
      quad,
      classified([
        [home, live],
        [other, redZone],
        [third, live],
        [fourth, live]
      ]),
      at(10)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should not switch within a rank for a higher score", () => {
    const { commands } = holding.step(
      quad,
      classified([
        [home, live, 40],
        [other, live, 90],
        [third, live],
        [fourth, live]
      ]),
      at(60)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should move nothing when no game is live", () => {
    const { commands } = on.step(
      quad,
      classified([
        [home, timeout],
        [other, timeout],
        [third, final],
        [fourth, { _tag: "Upcoming" }]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should leave the main tile alone while it is yours", () => {
    const yours = holding.manual({ _tag: "Promote", tile: 0 }, start)

    const { commands } = yours.step(
      quad,
      classified([
        [home, timeout],
        [other, redZone],
        [third, live],
        [fourth, live]
      ]),
      at(60)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should rank again once your suspension runs out", () => {
    const promoted = after(quad, [{ _tag: "Promote", tile: 2 }])
    const moments = classified([
      [home, live],
      [other, redZone],
      [third, live],
      [fourth, live]
    ])
    const yours = on.manual({ _tag: "Promote", tile: 2 }, start).step(promoted, moments, at(1)).next

    const { commands } = yours.step(promoted, moments, at(181))

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })
})

describe("Autopilot.step, the sound", () => {
  it("should put the sound on the main tile's game", () => {
    const heardElsewhere = after(quad, [{ _tag: "FocusAudio", tile: 2 }])

    const { commands } = holding.step(
      heardElsewhere,
      classified([
        [home, live],
        [other, live],
        [third, live],
        [fourth, live]
      ]),
      at(1)
    )

    assert.deepStrictEqual(commands, [{ _tag: "FocusAudio", tile: 0 }])
  })

  it("should put the sound back where you put it after a promote while the sound is yours", () => {
    const heard = after(quad, [{ _tag: "FocusAudio", tile: 3 }])
    const yours = holding.manual({ _tag: "FocusAudio", tile: 3 }, start)

    const { commands } = yours.step(
      heard,
      classified([
        [home, timeout],
        [other, live],
        [third, live],
        [fourth, live]
      ]),
      at(1)
    )

    assert.deepStrictEqual(commands, [
      { _tag: "Promote", tile: 1 },
      { _tag: "FocusAudio", tile: 3 }
    ])
  })
})

describe("Autopilot.step, the layout", () => {
  it("should fit the layout before it promotes, and promote on the fitted Screen", () => {
    const { commands } = on.step(
      quad,
      classified([
        [home, timeout],
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
    const yours = on.manual({ _tag: "SetLayout", layout: "Quad" }, start)

    const { commands } = yours.step(
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

  it("should not fit the layout for an autopilot kept before it had a ceiling", () => {
    const kept = new Autopilot({ ...on, ceiling: Option.none() })

    const { commands } = kept.step(
      quad,
      classified([
        [home, live],
        [other, final],
        [third, final],
        [fourth, final]
      ]),
      at(180)
    )

    assert.deepStrictEqual(commands, [])
  })
})

describe("Autopilot.step, the decision", () => {
  it("should say it is off", () => {
    const { decision } = Autopilot.off.step(quad, {}, start)

    assert.deepStrictEqual(decision, Decision.Off())
  })

  it("should say it is frozen while the Screen is soloed", () => {
    const soloed = after(quad, [{ _tag: "Solo", tile: 1 }])

    const { decision } = on.step(soloed, {}, start)

    assert.deepStrictEqual(decision, Decision.Frozen())
  })

  it("should say it promoted a game because the main tile's game stopped", () => {
    const { decision } = on.step(
      quad,
      classified([
        [home, timeout],
        [other, live],
        [third, live],
        [fourth, live]
      ]),
      start
    )

    assert.deepStrictEqual(
      Decision.$is("Stepped")(decision) ? decision.main : undefined,
      MainDecision.Promoted({ game: other, over: Option.some(home), why: "stopped" })
    )
  })

  it("should say how long the dwell has left", () => {
    const { decision } = holding.step(
      quad,
      classified([
        [home, live],
        [other, redZone],
        [third, live],
        [fourth, live]
      ]),
      at(10)
    )

    assert.deepStrictEqual(
      Decision.$is("Stepped")(decision) ? decision.main : undefined,
      MainDecision.Stayed({ game: Option.some(home), why: StayReason.Dwell({ left: Duration.seconds(20) }) })
    )
  })
})

describe("Autopilot.manual", () => {
  it("should make the main tile yours when you promote", () => {
    const pilot = on.manual({ _tag: "Promote", tile: 2 }, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.some(at(180)),
      audio: Option.none(),
      layout: Option.none()
    })
  })

  it("should make the main tile and the sound yours when you solo", () => {
    const pilot = on.manual({ _tag: "Solo", tile: 1 }, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.some(at(180)),
      audio: Option.some(at(180)),
      layout: Option.none()
    })
  })

  it("should make the main tile yours when you swap tile 0", () => {
    const pilot = on.manual({ _tag: "Swap", a: 0, b: 2 }, start)

    assert.deepStrictEqual(pilot.suspended.main, Option.some(at(180)))
  })

  it("should make the layout yours when you swap two tiles other than tile 0", () => {
    const pilot = on.manual({ _tag: "Swap", a: 1, b: 2 }, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.none(),
      layout: Option.some(at(180))
    })
  })

  it("should make the layout yours when you clear a tile other than tile 0", () => {
    const pilot = on.manual({ _tag: "Clear", tile: 2 }, start)

    assert.deepStrictEqual(pilot.suspended.layout, Option.some(at(180)))
  })

  it("should make only the sound yours when you focus the sound", () => {
    const pilot = on.manual({ _tag: "FocusAudio", tile: 2 }, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.some(at(180)),
      layout: Option.none()
    })
  })

  it("should make the layout you set the ceiling", () => {
    const pilot = on.manual({ _tag: "SetLayout", layout: "Pair" }, start)

    assert.deepStrictEqual(pilot.ceiling, Option.some("Pair"))
  })

  it("should make nothing yours when you move a divider", () => {
    const pilot = on.manual({ _tag: "SetSplit", split: { x: 0.4, y: 0.5 } }, start)

    assert.deepStrictEqual(pilot.suspended, Autopilot.off.suspended)
  })
})

describe("Autopilot.toggle", () => {
  it("should take the ceiling from the Screen when turned on", () => {
    const pilot = Autopilot.off.toggle(quad)

    assert.deepStrictEqual(pilot.ceiling, Option.some("Quad"))
  })

  it("should forget everything when turned off", () => {
    const off = holding.toggle(quad)

    assert.strictEqual(off, Autopilot.off)
  })
})

describe("Autopilot.nextDeadline", () => {
  it("should give the end of the main tile's dwell", () => {
    const deadline = holding.nextDeadline(at(1), quad, {})

    assert.deepStrictEqual(deadline, Option.some(at(30)))
  })

  it("should give the end of your suspension", () => {
    const pilot = on.manual({ _tag: "FocusAudio", tile: 2 }, start)

    const deadline = pilot.nextDeadline(at(1), quad, {})

    assert.deepStrictEqual(deadline, Option.some(at(180)))
  })

  it("should give the end of the hold of a game over on a tile", () => {
    const deadline = on.nextDeadline(at(1), quad, classified([[third, final]]))

    assert.deepStrictEqual(deadline, Option.some(at(120)))
  })

  it("should give no deadline while off", () => {
    const deadline = Autopilot.off.nextDeadline(start, quad, classified([[third, final]]))

    assert.deepStrictEqual(deadline, Option.none())
  })
})

describe("Autopilot.status", () => {
  it("should say the main tile is yours until your suspension ends", () => {
    const pilot = on.manual({ _tag: "Promote", tile: 2 }, start)

    const status = pilot.status(at(1), quad, {})

    assert.deepStrictEqual(status, AutopilotStatus.Yours({ part: "main", until: at(180) }))
  })

  it("should say which game it follows and its rank", () => {
    const status = on.status(start, quad, classified([[home, redZone]]))

    assert.deepStrictEqual(
      status,
      AutopilotStatus.Following({ game: home, rank: "redZone", fitted: Option.none() })
    )
  })

  it("should say nothing is live when the main tile's game is not", () => {
    const status = on.status(start, quad, classified([[home, timeout]]))

    assert.deepStrictEqual(status, AutopilotStatus.NothingLive({ fitted: Option.none() }))
  })

  it("should say it fitted the layout while the Screen's layout is not the ceiling", () => {
    const paired = after(quad, [{ _tag: "SetLayout", layout: "Pair" }])

    const status = on.status(start, paired, classified([[home, live]]))

    assert.deepStrictEqual(
      status,
      AutopilotStatus.Following({ game: home, rank: "live", fitted: Option.some(2) })
    )
  })
})
```

- [ ] **Step 6: `AutopilotState.ts`, `DisplayState.ts`**

`AutopilotInput.Commanded` carries only the command:

```ts
/** What moves the autopilot: turned on or off, a command you sent, or time passing. */
export type AutopilotInput = Data.TaggedEnum<{
  Toggled: object
  Commanded: { readonly command: ScreenCommand }
  Ticked: object
}>
```

The writer:

```ts
  (ctx, input: AutopilotInput) => {
    const now = DateTime.nowUnsafe()
    const current = ctx.get(kept)
    if (AutopilotInput.$is("Commanded")(input)) {
      ctx.set(kept, current.manual(input.command, now))
      return
    }
    const screen = ctx.get(DisplayScreen.screen)
    const moved = AutopilotInput.$is("Toggled")(input) ? current.toggle(screen) : current
    const { next, commands } = moved.step(screen, ctx.get(LiveStream.live).classifications, now)
    Atom.batch(() => {
      if (next !== current) ctx.set(kept, next)
      for (const command of commands) ctx.set(DisplayScreen.screen, command)
    })
  }
```

Drop the now-unused `Screen` type import if nothing else uses it (`untilDeadline` still does). In `apps/web/src/display/DisplayState.ts`, `AutopilotInput.Commanded({ command, screen: ctx.get(DisplayScreen.screen) })` becomes `AutopilotInput.Commanded({ command })`; its doc comment stays true.

- [ ] **Step 7: `AutopilotState.test.ts`**

With no home, a red zone on another tile waits out the main game's dwell. The `slate` helper takes home's classification too: `function slate(otherClassification = TestWeb.classified({ _tag: "Live" }), homeClassification = TestWeb.classified({ _tag: "Live" }))`, passing `homeClassification` for `homeGame`. Then:

- "should promote a red zone on another tile as soon as it is turned on" becomes "should promote a live game as soon as it is turned on while the main tile's game is on a break": `arranged(slate(TestWeb.classified({ _tag: "Live" }), TestWeb.classified(timeout)))`, toggle, expect `other` in the main tile (define `const timeout: Moment = { _tag: "Break", reason: "timeout", expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z") }`).
- "should promote a red zone a slate brings while it is on" becomes "should promote a live game when a slate puts the main tile's game on a break": arranged `slate()`, toggle, mount the pilot, then the source sends `slate(TestWeb.classified({ _tag: "Live" }), TestWeb.classified(timeout))`; expect `other` in the main tile.
- "should promote home again at the end of the dwell with no new slate" becomes "should promote a red zone once the main tile's game has held it for the dwell, with no new slate": same TestClock setup; `arranged(slate(TestWeb.classified(TestWeb.redZone)))`, toggle, mount, `passing(Duration.seconds(30))`, then `until` the main tile holds `other`; assert it does.
- The two layout tests, "should keep nothing in this browser for a tick that changes nothing" and "should read the autopilot back on after a reload" stay; if a layout test now also sees a promote it did not expect, report it rather than weaken it.

- [ ] **Step 8: `AutopilotToggle.tsx` and its tests**

The status words:

```tsx
  const doing = AutopilotStatus.$match(autopilot.status(now, screen, classifications), {
    Off: () => "Autopilot off",
    Yours: ({ part, until }) =>
      `Autopilot on: ${partName(part)} yours for ${countdown(DateTime.distance(now, until))}`,
    NothingLive: ({ fitted }) => `Autopilot on: following, nothing live${fittedWords(fitted)}`,
    Following: ({ game, rank, fitted }) =>
      `Autopilot on: following ${nameOf(game)} — ${label(rank)}${fittedWords(fitted)}`
  })
```

```ts
/** `, fitted to 2 tiles` for a layout fitted below the ceiling; nothing otherwise. */
function fittedWords(fitted: Option.Option<number>): string {
  return Option.match(fitted, {
    onNone: () => "",
    onSome: (slots) => `, fitted to ${slots} ${slots === 1 ? "tile" : "tiles"}`
  })
}
```

Remove `whyAway`, and the `Match` and `Moment` imports; import `label` from `./Ranking.ts`.

`AutopilotToggle.test.ts`: remove the away tests and `awayOn`/`soundAwayOn`; the `suspended` literals lose nothing (they already have `layout`) but `home` literals become `ceiling: Option.some("Quad")`. Tests (screen with `dal` on tile 0 is `TestWeb.withTiles(["dal"])`; `classify` as the file has it):

- "should say it is off" → `Autopilot off · A` (stays).
- "should name the game it follows and its rank": on (`Autopilot.off.toggle(Screen.initial)`), screen `TestWeb.withTiles(["dal"])`, `classify(TestWeb.classified(TestWeb.redZone))` → `Autopilot on: following PHI @ DAL — red zone · A`.
- "should say nothing is live": on, `Screen.initial`, no classifications → `Autopilot on: following, nothing live · A`.
- "should say it fitted the layout": on with ceiling Quad, screen `new Screen({ ...TestWeb.withTiles(["dal"]), layout: "Pair" })`, `classify(TestWeb.classified({ _tag: "Live" }))` → `Autopilot on: following PHI @ DAL — live, fitted to 2 tiles · A`.
- The three "yours" tests (main tile 2:41, sound 1:15, layout 2:41) stay.

`titleOf` passes `screen` and `classifications` as now.

- [ ] **Step 9: Docs**

- `CONTEXT.md`: remove the **Home** and **Away** rows; reword **Autopilot** to "A Display's follower of the classifications: shows the best game by its ranking in the main tile, the sound on it, and fits the layout under the ceiling. Off by default; your commands win."; add after it:

```markdown
| **Ranking** | The autopilot's order of games: a red zone, crunch time, a big play, live play, a break, not live; then score, then tile. | priority |
| **Dwell** | The 30 s the main tile's game holds the tile against a game in a higher rank, unless it stops. | hold |
```

  and **Ceiling** becomes "The layout you chose (when you turn the autopilot on, and each one you set): the autopilot fits the layout down from it as games end and back up to it as they start, never past."
- `docs/specs/2026-10-10-autopilot-design.md`: a line under its title: "Its chase (home, away, the main tile and the sound) is superseded by [Autopilot ranking](2026-10-10-autopilot-ranking-design.md)."
- `docs/specs/2026-10-10-autopilot-ranking-design.md`, under Web → `Autopilot.ts`: `manual(command, now)` (with no home, it needs no Screen) and `nextDeadline` gives the main game's dwell end whenever there is one (a wake that changes nothing is harmless).

- [ ] **Step 10: Run the tests, check, commit**

Run: `pnpm vitest run apps/web/src` — PASS. Then `pnpm check` — fully green.

```bash
git add apps/web CONTEXT.md docs
git commit -m "feat(web): the autopilot shows the best game by one ranking, held for a dwell, with no home

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Timeline tests

**Files:**
- Modify: `apps/web/src/TestWeb.ts`
- Create: `apps/web/src/autopilot/AutopilotTimeline.test.ts`

**Interfaces:**
- Consumes: `Autopilot` (Task 2: `manual(command, now)`, `step(...) → { next, commands, decision }`), `Decision`, `TestWeb.classified(moment, score, since)`.
- Produces: `TestWeb.timeline(screen, autopilot, steps): ReadonlyArray<TimelineFrame>`, `TestWeb.TimelineStep`, `TestWeb.TimelineFrame`.

- [ ] **Step 1: The harness, in `TestWeb.ts`**

```ts
/** One moment of a scripted game day: seconds after 20:00 UTC, each game's classification then, and a command you send first. */
export interface TimelineStep {
  readonly at: number
  readonly classifications: ReadonlyArray<readonly [GameId, Classification]>
  readonly command?: ScreenCommand
}

/** What the Screen showed after a timeline step: the main tile's game, the game heard, the layout, and the decision. */
export interface TimelineFrame {
  readonly at: number
  readonly main: GameId | undefined
  readonly heard: GameId | undefined
  readonly layout: LayoutName
  readonly decision: Decision
}

/**
 * Plays `steps` through `autopilot` from `screen` as a Display would: your command through the Screen and `manual`,
 * then a step, its commands applied in order. Every game is on FOX.
 */
export function timeline(
  screen: Screen,
  autopilot: Autopilot,
  steps: ReadonlyArray<TimelineStep>
): ReadonlyArray<TimelineFrame> {
  const start = DateTime.makeUnsafe("2026-10-10T20:00:00Z")
  const applied = (on: Screen, commands: ReadonlyArray<ScreenCommand>) =>
    commands.reduce((current, command) => Result.getOrThrow(current.apply(command, onFox)), on)
  return steps.reduce(
    (played, step) => {
      const now = DateTime.addDuration(start, Duration.seconds(step.at))
      const before =
        step.command === undefined
          ? played
          : { ...played, screen: applied(played.screen, [step.command]), autopilot: played.autopilot.manual(step.command, now) }
      const { next, commands, decision } = before.autopilot.step(
        before.screen,
        Record.fromEntries(step.classifications),
        now
      )
      const shown = applied(before.screen, commands)
      const main = shown.tiles[0]
      const frame: TimelineFrame = {
        at: step.at,
        main: main === undefined || main._tag === "Empty" ? undefined : main.game,
        heard: Option.getOrUndefined(shown.audioFocus),
        layout: shown.layout,
        decision
      }
      return { screen: shown, autopilot: next, frames: [...played.frames, frame] }
    },
    { screen, autopilot, frames: [] as ReadonlyArray<TimelineFrame> }
  ).frames
}
```

Add the imports it needs (`Autopilot` from `./autopilot/Autopilot.ts`, `type Decision` from `./autopilot/Decision.ts`, `type LayoutName`, `type ScreenCommand` from `./screen/Screen.ts`, `Duration`, `Option`, `Record`, `Result` from `effect`), matching how `TestWeb.ts` already imports.

- [ ] **Step 2: The scenarios**

`apps/web/src/autopilot/AutopilotTimeline.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { PlayId } from "@sportal/domain/Play"
import { DateTime, Result } from "effect"
import type { Classification } from "@sportal/domain/Classification"
import * as TestWeb from "../TestWeb.ts"
import { Autopilot } from "./Autopilot.ts"

const home = GameId.make("home")
const other = GameId.make("other")
const third = GameId.make("third")
const fourth = GameId.make("fourth")

const quad = Result.getOrThrow(
  TestWeb.withTiles([home, other, third, fourth]).apply({ _tag: "FocusAudio", tile: 0 }, TestWeb.onFox)
)
const on = Autopilot.off.toggle(quad)

const live = TestWeb.classified({ _tag: "Live" })
const redZone = TestWeb.classified(TestWeb.redZone)
const crunch = TestWeb.classified({ _tag: "CrunchTime", margin: 3, secondsLeft: 100 })
const final = TestWeb.classified({ _tag: "Final" })
const touchdownBreak = TestWeb.classified({
  _tag: "Break",
  reason: "afterScore",
  expectedEnd: DateTime.makeUnsafe("2026-10-10T20:03:00Z"),
  after: { play: PlayId.make("9"), kind: "touchdown" }
} satisfies Moment)
const timeout = TestWeb.classified({
  _tag: "Break",
  reason: "timeout",
  expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z")
})

/** Each of the four games' classifications, in tile order. */
function games(a: Classification, b: Classification, c: Classification, d: Classification) {
  return [
    [home, a],
    [other, b],
    [third, c],
    [fourth, d]
  ] as const
}

describe("the autopilot over a game day", () => {
  it("should hand a touchdown's break off to a game in live play", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(live, live, live, live) },
      { at: 40, classifications: games(touchdownBreak, live, live, live) }
    ])

    assert.deepStrictEqual(
      frames.map(({ main }) => main),
      [home, other]
    )
  })

  it("should hold a red zone through its dwell before a higher rank takes over", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(live, live, live, live) },
      { at: 31, classifications: games(live, crunch, live, live) },
      { at: 45, classifications: games(live, crunch, redZone, live) },
      { at: 61, classifications: games(live, crunch, redZone, live) }
    ])

    assert.deepStrictEqual(
      frames.map(({ main }) => main),
      [home, other, other, third]
    )
  })

  it("should take crunch time over live play but not over a red zone", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(redZone, crunch, live, live) },
      { at: 40, classifications: games(redZone, crunch, live, live) },
      { at: 41, classifications: games(live, crunch, live, live) }
    ])

    assert.deepStrictEqual(
      frames.map(({ main }) => main),
      [home, home, other]
    )
  })

  it("should leave your promote for three minutes, then rank again", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(live, live, redZone, live), command: { _tag: "Promote", tile: 1 } },
      { at: 60, classifications: games(live, live, redZone, live) },
      { at: 181, classifications: games(live, live, redZone, live) }
    ])

    assert.deepStrictEqual(
      frames.map(({ main }) => main),
      [other, other, third]
    )
  })

  it("should leave the main tile as it is when nothing is live", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(live, live, live, live) },
      { at: 10, classifications: games(timeout, timeout, final, final) }
    ])

    assert.deepStrictEqual(
      frames.map(({ main }) => main),
      [home, home]
    )
  })

  it("should shrink the layout when a finished game's hold runs out", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(live, live, final, final) },
      { at: 121, classifications: games(live, live, final, final) }
    ])

    assert.deepStrictEqual(
      frames.map(({ layout }) => layout),
      ["Quad", "Pair"]
    )
  })
})
```

(`final` is classified since 20:00, so its hold ends at 20:02 = 120 s. In the dwell scenario, home's dwell ends at 30 s, so crunch time takes the main tile at 31 s; the red zone at 45 s waits for crunch time's dwell, which ends at 61 s.)

- [ ] **Step 3: Run, check, commit**

Run: `pnpm vitest run apps/web/src/autopilot/AutopilotTimeline.test.ts` — PASS (the fold exists, so these pass on first run; if one fails, the scenario or the fold is wrong: investigate and report which, do not loosen the expectation). Then `pnpm check` — fully green.

```bash
git add apps/web/src/TestWeb.ts apps/web/src/autopilot/AutopilotTimeline.test.ts
git commit -m "test(web): timeline scenarios that play scripted game days through the autopilot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The decision log

**Files:**
- Modify: `apps/web/src/autopilot/Decision.ts`, `apps/web/src/autopilot/AutopilotState.ts`
- Test: `apps/web/src/autopilot/Decision.test.ts` (create), `apps/web/src/autopilot/AutopilotState.test.ts`

**Interfaces:**
- Consumes: `Decision` and its parts (Task 2), `Step.decision`.
- Produces: `explain(decision, nameOf): string`, `details(decision): Record<string, string | number>` in `Decision.ts`; `AutopilotState.decision: Atom.Writable<Decision>`.

- [ ] **Step 1: Tests for `explain` and `details`**

`apps/web/src/autopilot/Decision.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { DateTime, Duration, Option } from "effect"
import { Decision, details, explain, LayoutDecision, MainDecision, SoundDecision, StayReason } from "./Decision.ts"

const dal = GameId.make("dal")
const buf = GameId.make("buf")
const nameOf = (game: GameId) => (game === dal ? "PHI @ DAL" : "NE @ BUF")

function stayed(why: StayReason) {
  return Decision.Stepped({
    ranking: [
      { game: buf, rank: "redZone", score: 70 },
      { game: dal, rank: "live", score: 50 }
    ],
    layout: LayoutDecision.Kept({ layout: "Quad" }),
    main: MainDecision.Stayed({ game: Option.some(dal), why }),
    sound: SoundDecision.OnMain({ game: Option.some(dal) })
  })
}

describe("explain", () => {
  it("should say which game it promoted over which, and why", () => {
    const decision = Decision.Stepped({
      ranking: [],
      layout: LayoutDecision.Fitted({ from: "Quad", to: "Pair" }),
      main: MainDecision.Promoted({ game: buf, over: Option.some(dal), why: "outranks" }),
      sound: SoundDecision.OnMain({ game: Option.some(buf) })
    })

    const words = explain(decision, nameOf)

    assert.strictEqual(
      words,
      "promoted NE @ BUF over PHI @ DAL: it ranks higher; layout Quad to Pair; sound on the main tile"
    )
  })

  it("should say the same words while a dwell counts down", () => {
    const early = stayed(StayReason.Dwell({ left: Duration.seconds(20) }))
    const later = stayed(StayReason.Dwell({ left: Duration.seconds(5) }))

    const [a, b] = [explain(early, nameOf), explain(later, nameOf)]

    assert.strictEqual(a, b)
  })

  it("should say it is off", () => {
    assert.strictEqual(explain(Decision.Off(), nameOf), "off")
  })
})

describe("details", () => {
  it("should give the ranking it saw", () => {
    const given = details(stayed(StayReason.Best()))

    assert.strictEqual(given["autopilot.ranking"], "buf redZone 70, dal live 50")
  })

  it("should give how long a dwell has left", () => {
    const given = details(stayed(StayReason.Dwell({ left: Duration.seconds(20) })))

    assert.strictEqual(given["autopilot.dwellLeftSeconds"], 20)
  })

  it("should give nothing for an autopilot that is off", () => {
    assert.deepStrictEqual(details(Decision.Off()), {})
  })
})
```

Run: `pnpm vitest run apps/web/src/autopilot/Decision.test.ts` — FAIL (`explain`/`details` missing).

- [ ] **Step 2: `explain` and `details` in `Decision.ts`**

Append:

```ts
/**
 * A decision in words, `nameOf` naming each game. What changes from step to step while a decision stands (a dwell's
 * seconds, a suspension's end, the ranking) is left out, so two steps with the same words decided the same.
 */
export function explain(decision: Decision, nameOf: (game: GameId) => string): string {
  return Decision.$match(decision, {
    Off: () => "off",
    Frozen: () => "frozen: the Screen is soloed",
    Stepped: ({ layout, main, sound }) =>
      [mainWords(main, nameOf), layoutWords(layout), soundWords(sound)].join("; ")
  })
}

/** A decision's details for its log: the ranking it saw, best first, and how long a dwell has left. */
export function details(decision: Decision): Record<string, string | number> {
  if (!Decision.$is("Stepped")(decision)) return {}
  const { ranking, main } = decision
  const dwell =
    MainDecision.$is("Stayed")(main) && StayReason.$is("Dwell")(main.why)
      ? { "autopilot.dwellLeftSeconds": Math.ceil(Duration.toSeconds(main.why.left)) }
      : {}
  return {
    "autopilot.ranking": ranking.map(({ game, rank, score }) => `${game} ${rank} ${score}`).join(", "),
    ...dwell
  }
}

function mainWords(main: MainDecision, nameOf: (game: GameId) => string): string {
  const named = (game: Option.Option<GameId>, none: string) => Option.match(game, { onNone: () => none, onSome: nameOf })
  return MainDecision.$match(main, {
    Promoted: ({ game, over, why }) =>
      `promoted ${nameOf(game)} over ${named(over, "an empty main tile")}: ${
        why === "outranks" ? "it ranks higher" : "the main tile's game stopped"
      }`,
    Stayed: ({ game, why }) =>
      `kept ${named(game, "the empty main tile")}: ${StayReason.$match(why, {
        Best: () => "it is the best",
        SameRank: () => "nothing ranks higher",
        Dwell: () => "holding for its dwell",
        Yours: () => "the main tile is yours",
        NothingLive: () => "nothing is live"
      })}`
  })
}

function layoutWords(layout: LayoutDecision): string {
  return LayoutDecision.$match(layout, {
    Fitted: ({ from, to }) => `layout ${from} to ${to}`,
    Kept: ({ layout }) => `layout ${layout}`,
    Yours: () => "layout yours",
    NoCeiling: () => "no ceiling"
  })
}

function soundWords(sound: SoundDecision): string {
  return SoundDecision.$match(sound, {
    OnMain: () => "sound on the main tile",
    Yours: () => "sound yours"
  })
}
```

(`Duration` becomes a value import.) Run the Decision tests — PASS.

- [ ] **Step 3: The `decision` atom and its log**

In `AutopilotState.ts`:

```ts
/** What the autopilot's last step decided, for its log. */
export const decision: Atom.Writable<Decision> = Atom.make<Decision>(Decision.Off()).pipe(Atom.keepAlive)
```

The writer sets it with the step's decision, inside the same `Atom.batch`:

```ts
    const { next, commands, decision: decided } = moved.step(screen, ctx.get(LiveStream.live).classifications, now)
    Atom.batch(() => {
      if (next !== current) ctx.set(kept, next)
      ctx.set(decision, decided)
      for (const command of commands) ctx.set(DisplayScreen.screen, command)
    })
```

The `pilot` logs each new decision, alongside its ticking:

```ts
export const pilot = runtime.atom((get) =>
  Effect.gen(function* () {
    const deadlines = …as now…
    const ticks = Stream.merge(get.stream(LiveStream.live), deadlines).pipe(
      Stream.runForEach(() => Effect.sync(() => get.set(autopilot, AutopilotInput.Ticked())))
    )
    const log = get.stream(decision).pipe(
      Stream.changesWith((a, b) => explain(a, String) === explain(b, String)),
      Stream.runForEach((decided) =>
        Effect.logInfo(`Autopilot: ${explain(decided, nameIn(get.once(LiveStream.live).slate))}`).pipe(
          Effect.annotateLogs(details(decided))
        )
      )
    )
    yield* Effect.all([ticks, log], { concurrency: "unbounded", discard: true })
  }).pipe(logDefect("The autopilot"))
)

/** A game's matchup on `slate`, `PHI @ DAL`; its id when the slate does not have it. */
function nameIn(slate: Slate): (game: GameId) => string {
  return (game) =>
    Option.match(slate.gameOf(game), {
      onNone: () => game,
      onSome: ({ snapshot }) => `${snapshot.away.team.abbreviation} @ ${snapshot.home.team.abbreviation}`
    })
}
```

Check `Stream.changesWith`, `get.once` and `Effect.annotateLogs` against Effect 4's signatures in `node_modules/effect/src` and adjust to the real names; the behaviour must be as written. `AutopilotToggle.tsx` names a game the same way inline (`nameOf`): export `nameIn` and have the toggle use `nameIn(slate)` from `AutopilotState.ts`, so the matchup wording lives in one place (the toggle importing `AutopilotState.ts` makes no cycle: `AutopilotState.ts` does not import the toggle).

- [ ] **Step 4: Log tests**

In `AutopilotState.test.ts`, two tests with a capturing logger in the registry's runtime (as the TestClock tests build theirs with `TestWeb.registryOf(Layer.mergeAll(Shell.layerTest(…), HubClient.layerTest(…), …))`, add `Logger.layer([capture])` where `capture` pushes each log's message into an array; check Effect 4's `Logger.make` signature):

- "should log a new decision once": arranged `slate()` (both live), toggle, mount the pilot, send the same slate twice more through `source.onmessage`; the messages starting with `Autopilot: kept` number exactly one.
- "should log a promote with the matchup's name": arranged with home on a break (Task 2's `slate(live, timeout)`), toggle, mount; a message `Autopilot: promoted … over …: the main tile's game stopped; …` is logged (assert with `startsWith("Autopilot: promoted")`).

Wait for the log with `TestWeb.until` on an atom, or by yielding until the captured array has the line (`Effect.yieldNow` in a loop bounded to a few hundred iterations); no real sleeps.

- [ ] **Step 5: Run, check, commit**

Run: `pnpm vitest run apps/web/src/autopilot` — PASS; `pnpm check` — fully green.

```bash
git add apps/web/src/autopilot
git commit -m "feat(web): the autopilot logs each new decision, in words, with the ranking it saw

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web logs to Grafana through the Hub

**Files:**
- Create: `apps/hub/src/TelemetryRelay.ts`, `apps/hub/src/TelemetryRelay.test.ts`, `apps/web/src/WebTelemetry.ts`
- Modify: `apps/hub/src/HubServer.ts` (or `main.ts`, wherever the router's layers are merged), `apps/web/src/WebRuntime.ts`, `apps/web/vite.config.ts` only if `/api` is not already proxied (it is: `proxy: { "/api": … }`)
- Test: `apps/hub/src/HubServer.test.ts`

**Interfaces:**
- Consumes: `HubConfig.otlpUrl: Option<URL>`, `HttpClient` (the Hub's `FetchHttpClient`), the web runtime's `FetchHttpClient`.
- Produces: `POST /api/telemetry/logs` on the Hub; `sportal-web` logs in Loki.

- [ ] **Step 1: The relay's tests**

`apps/hub/src/HubServer.test.ts`, under "HTTP endpoints":

```ts
    it.effect("should take a Display's logs and drop them without a collector", () =>
      served(() =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient

          const response = yield* http.execute(
            HttpClientRequest.post("/api/telemetry/logs").pipe(HttpClientRequest.bodyText("{}", "application/json"))
          )

          assert.strictEqual(response.status, 204)
        })
      )
    )
```

`apps/hub/src/TelemetryRelay.test.ts`: the relay with a collector configured (`HubConfig.layerTest({ SPORTAL_VERSION: "1.2.3", SPORTAL_OTLP_URL: "http://collector.test:4318" })` — check the env names in `HubConfig.ts`) and a fake `HttpClient` (`HttpClient.make` recording each request and answering `200`):

- "should forward a Display's logs to the collector's logs endpoint": the recorded request is a `POST` to `http://collector.test:4318/v1/logs` with the body sent and its content type.
- "should answer 204 once the collector took them".
- "should answer 502 when the collector cannot be reached": the fake client fails.

Serve the relay for these with `HttpRouter.toWebHandler` (or the same `NodeHttpServer.layerTest` pattern as `HubServer.test.ts`, giving the relay its own fake client) — whichever Effect 4 supports most directly.

- [ ] **Step 2: `TelemetryRelay.ts`**

```ts
import { Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HubConfig } from "./HubConfig.ts"

/**
 * Relays a Display's OTLP logs, posted to `/api/telemetry/logs`, to the collector the Hub reports to; with no
 * collector, takes them and drops them. A failed relay warns once.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { otlpUrl } = yield* HubConfig
    const client = yield* HttpClient.HttpClient
    const warnOnce = yield* Effect.cached(Effect.logWarning("The Hub cannot relay a Display's logs to the collector"))
    return HttpRouter.add("POST", "/api/telemetry/logs", (request: HttpServerRequest.HttpServerRequest) =>
      Option.match(otlpUrl, {
        onNone: () => Effect.succeed(HttpServerResponse.empty({ status: 204 })),
        onSome: (url) =>
          request.arrayBuffer.pipe(
            Effect.flatMap((body) =>
              client.execute(
                HttpClientRequest.post(`${url.href.replace(/\/$/, "")}/v1/logs`).pipe(
                  HttpClientRequest.bodyUint8Array(
                    new Uint8Array(body),
                    request.headers["content-type"] ?? "application/json"
                  )
                )
              )
            ),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.as(HttpServerResponse.empty({ status: 204 })),
            Effect.catch(() => warnOnce.pipe(Effect.as(HttpServerResponse.empty({ status: 502 }))))
          )
      })
    )
  })
)
```

This is the intended shape; check each name against Effect 4 (`effect/http`'s `HttpRouter.add`, `HttpServerRequest#arrayBuffer`, `HttpClientRequest.bodyUint8Array`, `HttpClientResponse.filterStatusOk`, `Effect.catch`, `Effect.cached`) and fix it to compile with the same behaviour. Merge it into the served router beside `api` and `web` in `HubServer.ts` (`HttpRouter.serve(Layer.mergeAll(api, web, TelemetryRelay.layer))`), so `HubServer.layer` now also needs `HttpClient` — `main.ts` already provides `FetchHttpClient.layer`; `HubServer.test.ts`'s server under test gets it from `NodeHttpServer.layerTest`. The route must be added before the SPA static fallback if order matters.

- [ ] **Step 3: `WebTelemetry.ts` and the web runtime**

```ts
import { Layer } from "effect"
import { OtlpLogger, OtlpSerialization } from "effect/observability"

/** This page's logs, shipped over OTLP to the Hub, which relays them to the collector: service `sportal-web`. */
export const layer = OtlpLogger.layer({
  url: "/api/telemetry/logs",
  resource: {
    serviceName: "sportal-web",
    attributes: { "service.instance.id": crypto.randomUUID() }
  },
  shutdownTimeout: "1 second"
}).pipe(Layer.provide(OtlpSerialization.layerJson))
```

(Check `OtlpSerialization`'s layer name in Effect 4.) In `WebRuntime.ts`, the runtime's layer becomes `Layer.mergeAll(HubClient.layer, Shell.layer, WebTelemetry.layer).pipe(Layer.provide(FetchHttpClient.layer))`, and its doc comment names the telemetry. A relative URL is fine in the browser (the page is served by the Hub, or by Vite proxying `/api` to it). Tests that build the real runtime must stay quiet: the exporter reports a failed export only at Debug; if any test output shows telemetry noise or a test hangs on the exporter, report it rather than suppress it.

- [ ] **Step 4: Run, check, commit**

Run: `pnpm vitest run apps/hub/src/HubServer.test.ts apps/hub/src/TelemetryRelay.test.ts apps/web/src` — PASS; `pnpm check` — fully green.

```bash
git add apps/hub/src apps/web/src
git commit -m "feat: web logs reach Grafana, relayed through the Hub

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand-check (controller, with the user)**

With `pnpm dev` running (telemetry up), turning the autopilot on in a Display shows `Autopilot: …` lines in Grafana Explore under `{service_name="sportal-web"}`. Agents cannot judge the running app here; ask the user to look.
