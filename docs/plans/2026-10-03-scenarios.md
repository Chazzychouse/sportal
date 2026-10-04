# Scenarios and Synthetic Streams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Play a scripted or recorded game day through the real Hub, Stage, and shell, at any speed, with synthetic stream pages in place of YouTube TV.

**Architecture:** A pure `Scenario` in `packages/domain` holds timed frames of `GameSnapshot`s and is written with a builder over `TestGame`. In the Hub, `SPORTAL_SCENARIO` makes `main.ts` wire a `ScenarioProvider` (behind `Provider`) and a `ScenarioSource` (behind `Source`), and gives Ingest and the provider a scenario clock that runs `SPORTAL_SCENARIO_SPEED` times faster. The scenario source's channels point at `/scenario-stream/<game id>`, a web UI page that draws the game's live state; the web UI resolves that path against its own origin and the shell admits it.

**Tech Stack:** Effect 4 (`Schema.Class`, `Layer`, `Clock`, `FileSystem`, `effect/testing` `TestClock`), `@effect/vitest`, React 19, Electron.

**Spec:** `docs/specs/2026-10-03-scenarios-design.md`. Work only in the worktree `/home/chazzy/development/projects/sportal-director` (branch `director`). Never touch the main checkout.

## Global Constraints

- Read `AGENTS.md` first. Effect 4 is newer than most training data: check `node_modules/effect/ai-docs/src/` before writing Effect code from memory.
- Every exported type name is a `CONTEXT.md` term; this plan adds **Scenario** and **Scenario time**.
- Main export first; private helpers below as hoisted `function` declarations; no options-bag type aliases; no `any`, casts outside decoding, non-null assertions, enums, default exports, or `index.ts` barrels.
- In the Hub, only `main.ts` and tests name concrete adapters.
- Time comes from Effect's `Clock`; no `Date.now()` in `packages/domain` or the Hub.
- Expected failures are tagged errors; nothing is caught and ignored.
- `Situation.yardLine` is yards to the goal the team with the ball attacks. ESPN's `situation.yardLine` is not: it counts from the home team's goal line, so the ESPN adapter takes `100 - yardLine` when the home team has the ball and leaves the yard line out when no team does (checked against the 2026-10-03 recordings: away AUB "at TENN 12" is `12`; home UNM "at UTEP 8" is `92`). A team is in the red zone at 20 or fewer.
- Tests sit beside their file as `Name.test.ts`. Run one file with `pnpm vitest run <path>`. `pnpm check` must pass before every commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Files

| File | Responsibility |
| --- | --- |
| `packages/domain/src/Scenario.ts` (create) | `Scenario`: frames, `slateAt`, `build` |
| `packages/domain/src/scenarios/*.ts` (create) | One named scenario per file |
| `packages/domain/src/scenarios/Scenarios.ts` (create) | The built scenarios by name |
| `packages/domain/src/Source.ts` (modify) | `SourceName` gains `"Scenario"` |
| `apps/hub/src/scenario/ScenarioClock.ts` (create) | Scenario time as a `Clock` layer |
| `apps/hub/src/scenario/ScenarioProvider.ts` (create) | `Provider` from a scenario; loads built scenarios and recorded slices |
| `apps/hub/src/scenario/ScenarioSource.ts` (create) | `Source` that carries every game on its synthetic stream page |
| `apps/hub/src/scenario/CutScenario.ts` (create) | Cuts a recording window into a slice; the `scenario:cut` script |
| `apps/hub/src/provider/espn/EspnProvider.ts` (modify) | Exports `slateOf`, reused by the cutter |
| `apps/hub/src/main.ts` (modify) | Wires scenario mode |
| `apps/web/src/scenario/ScenarioStream.tsx` (create) | The synthetic stream page |
| `apps/web/src/main.tsx` (modify) | Routes `/scenario-stream/` |
| `apps/web/src/stage/TileRects.ts` (modify) | Resolves a path locator against the page's origin |
| `apps/desktop/src/main/ProviderSession.ts` (modify) | `allows(url, ui)`; the service exposes `allows`; `layer(ui)` |
| `apps/desktop/src/main/TileViews.ts`, `main.ts` (modify) | Use the session's `allows`; pass the UI address |
| `CONTEXT.md`, `AGENTS.md`, `docs/game-day-checklist.md` (modify) | Glossary, command, checklist row |

---

### Task 1: `Scenario` in the domain

**Files:**
- Create: `packages/domain/src/Scenario.ts`
- Test: `packages/domain/src/Scenario.test.ts`
- Modify: `packages/domain/src/Source.ts:8` (`SourceName`)
- Modify: `CONTEXT.md` (glossary rows)

**Interfaces:**
- Consumes: `snapshot`, `team`, `broadcast` from `packages/domain/src/TestGame.ts`; `GameSnapshot`, `GameId`, `GameStatus` from `Game.ts`; `Situation`.
- Produces:
  - `class Scenario extends Schema.Class` with fields `name: string`, `origin: DateTime.Utc` (`Schema.DateTimeUtcFromString`), `frames: ReadonlyArray<{ at: number; slate: ReadonlyArray<GameSnapshot> }>` (`at` in milliseconds from the start).
  - `scenario.slateAt(start: DateTime.Utc, elapsed: Duration.Duration): ReadonlyArray<GameSnapshot>`
  - `Scenario.build(name: string, games: ReadonlyArray<{ id; home; away; league?; network?; kickoff?; ranking?; timeline }>): Scenario` — the exact shape is in Step 3.
  - `SourceName` accepts `"Scenario"`.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/Scenario.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Schema } from "effect"
import { Scenario } from "./Scenario.ts"

const drive = Scenario.build("drive", [
  {
    id: "1",
    home: "UGA",
    away: "ALA",
    network: "CBS",
    timeline: [
      ["0:00", { status: "live", period: 4, clock: "2:10", score: [24, 24], ball: { team: "home", yardLine: 75, down: 1, distance: 10 } }],
      ["1:00", { clock: "0:41", ball: { team: "home", yardLine: 17, down: 1, distance: 10 } }],
      // Out of order on purpose: changes apply in time order whatever order they are written in.
      ["0:30", { clock: "1:30" }],
      ["2:00", { clock: "0:03", score: [27, 24], ball: null, lastPlay: "Field goal is good" }]
    ]
  },
  { id: "2", home: "TEX", away: "OU", kickoff: "1:30", timeline: [["1:30", { status: "live", period: 1, clock: "15:00" }]] }
])

const game = (id: string, seconds: number, start = drive.origin) =>
  drive.slateAt(start, Duration.seconds(seconds)).find((candidate) => candidate.id === id)

describe("Scenario.build", () => {
  it("makes one frame per distinct offset, in time order", () => {
    assert.deepStrictEqual(
      drive.frames.map((frame) => frame.at),
      [0, 30_000, 60_000, 90_000, 120_000]
    )
  })

  it("merges each change onto the game as it was before it", () => {
    const tie = game("1", 60)
    assert.strictEqual(tie?.clock, "0:41")
    assert.strictEqual(tie?.home.score, 24)
    assert.strictEqual(tie?.period, 4)
    assert.strictEqual(tie?.situation?.possession, "fbs:UGA")
    assert.strictEqual(tie?.situation?.down, 1)
  })

  it("marks the red zone from the yard line", () => {
    assert.isFalse(game("1", 0)?.situation?.isRedZone)
    assert.isTrue(game("1", 60)?.situation?.isRedZone)
  })

  it("takes the ball away between plays but keeps the timeouts and the last play", () => {
    const situation = game("1", 120)?.situation
    assert.isUndefined(situation?.possession)
    assert.isFalse(situation?.isRedZone)
    assert.strictEqual(situation?.homeTimeouts, 3)
    assert.strictEqual(situation?.lastPlay, "Field goal is good")
  })

  it("keeps a game scheduled at its kickoff until its first change", () => {
    assert.strictEqual(game("2", 60)?.status, "scheduled")
    assert.strictEqual(game("2", 90)?.status, "live")
    assert.strictEqual(
      DateTime.toEpochMillis(game("2", 0)?.kickoff ?? drive.origin),
      DateTime.toEpochMillis(drive.origin) + 90_000
    )
  })

  it("lists the networks it is given", () => {
    assert.deepStrictEqual(game("1", 0)?.broadcasts.map((broadcast) => broadcast.network), ["CBS"])
    assert.deepStrictEqual(game("2", 0)?.broadcasts, [])
  })
})

describe("Scenario#slateAt", () => {
  it("moves every instant by the time between the scenario's origin and its start", () => {
    const start = DateTime.makeUnsafe("2026-11-01T18:00:00Z")
    assert.strictEqual(
      DateTime.toEpochMillis(game("2", 0, start)?.kickoff ?? start),
      DateTime.toEpochMillis(start) + 90_000
    )
  })

  it("holds the last frame once the scenario has ended", () => {
    assert.strictEqual(game("1", 60 * 60)?.clock, "0:03")
  })

  it.effect("survives a round trip through JSON", () =>
    Effect.gen(function* () {
      const json = Schema.fromJsonString(Scenario)
      const back = yield* Schema.decodeEffect(json)(yield* Schema.encodeEffect(json)(drive))
      assert.strictEqual(back.frames.length, 5)
      assert.strictEqual(back.slateAt(back.origin, Duration.seconds(60))[0]?.clock, "0:41")
    })
  )
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run packages/domain/src/Scenario.test.ts`
Expected: FAIL, cannot find module `./Scenario.ts`.

- [ ] **Step 3: Write `Scenario.ts`**

```ts
import { DateTime, Duration, Schema } from "effect"
import { GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import type { LeagueId } from "./League.ts"
import { Situation } from "./Situation.ts"
import { broadcast, snapshot, team } from "./TestGame.ts"

/** The whole slate `at` milliseconds after a scenario starts. */
const Frame = Schema.Struct({ at: Schema.Int, slate: Schema.Array(GameSnapshot) })

/**
 * A timeline of game snapshots for several games, scripted or cut from a recording, that a Hub can play instead
 * of a provider. Its instants are as written or recorded; `slateAt` moves them to when it is played.
 */
export class Scenario extends Schema.Class<Scenario>("sportal/Scenario")({
  name: Schema.String,
  /** When the scenario starts, as written or recorded. */
  origin: Schema.DateTimeUtcFromString,
  /** In order of `at`, the first at 0. */
  frames: Schema.Array(Frame)
}) {
  /**
   * A scenario written as games and the changes to each from an offset in scenario time ("m:ss" or "h:mm:ss";
   * a kickoff may be negative, for a game already under way). It starts at 2026-10-03 16:00 UTC. Each game is
   * scheduled at its kickoff (the start, unless given) until its first change; each change merges onto the game
   * as it was. There is one frame per distinct offset.
   */
  static build(
    name: string,
    games: ReadonlyArray<{
      readonly id: string
      readonly home: string
      readonly away: string
      readonly league?: LeagueId
      readonly network?: string
      readonly kickoff?: string
      readonly ranking?: { readonly home?: number; readonly away?: number }
      readonly timeline: ReadonlyArray<
        readonly [
          offset: string,
          change: {
            readonly status?: GameStatus
            readonly period?: number
            readonly clock?: string
            readonly score?: readonly [home: number, away: number]
            /**
             * Who has the ball and where, `yardLine` being yards to the goal they attack (the ESPN adapter orients ESPN's yard line this way);
             * `null` while the ball is dead (after a score, at a break).
             */
            readonly ball?: {
              readonly team: "home" | "away"
              readonly yardLine: number
              readonly down: number
              readonly distance: number
            } | null
            readonly timeouts?: readonly [home: number, away: number]
            readonly lastPlay?: string
          }
        ]
      >
    }>
  ): Scenario {
    const origin = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
    const steps = games.map((game) => ({
      first: initial(game, origin),
      timeline: [...game.timeline]
        .map(([offset, change]) => ({ at: millisOf(offset), change }))
        .sort((a, b) => a.at - b.at)
    }))
    const offsets = [...new Set([0, ...steps.flatMap(({ timeline }) => timeline.map(({ at }) => at))])].sort(
      (a, b) => a - b
    )
    return new Scenario({
      name,
      origin,
      frames: offsets.map((at) => ({
        at,
        slate: steps.map(({ first, timeline }) =>
          timeline.filter((step) => step.at <= at).reduce((game, step) => changed(game, step.change), first)
        )
      }))
    })
  }

  /**
   * The slate `elapsed` after the scenario started at `start`: the latest frame by then, held after the last,
   * with every instant moved by the time from the scenario's origin to `start`.
   */
  slateAt(start: DateTime.Utc, elapsed: Duration.Duration): ReadonlyArray<GameSnapshot> {
    const at = Duration.toMillis(elapsed)
    const frame = this.frames.findLast((candidate) => candidate.at <= at) ?? this.frames[0]
    if (frame === undefined) return []
    const shift = DateTime.toEpochMillis(start) - DateTime.toEpochMillis(this.origin)
    return frame.slate.map(
      (game) =>
        new GameSnapshot({ ...game, kickoff: DateTime.makeUnsafe(DateTime.toEpochMillis(game.kickoff) + shift) })
    )
  }
}

/** A game as `build` first writes it: scheduled at its kickoff, nil–nil. */
function initial(game: Parameters<typeof Scenario.build>[1][number], origin: DateTime.Utc): GameSnapshot {
  const league = game.league ?? "fbs"
  return snapshot({
    id: GameId.make(game.id),
    league,
    kickoff: DateTime.makeUnsafe(DateTime.toEpochMillis(origin) + millisOf(game.kickoff ?? "0:00")),
    home: {
      team: team(game.home, league),
      score: 0,
      ...(game.ranking?.home === undefined ? {} : { ranking: game.ranking.home })
    },
    away: {
      team: team(game.away, league),
      score: 0,
      ...(game.ranking?.away === undefined ? {} : { ranking: game.ranking.away })
    },
    broadcasts: game.network === undefined ? [] : [broadcast(game.network)]
  })
}

/** "m:ss", "h:mm:ss", or either with a leading "-", in milliseconds. */
function millisOf(offset: string): number {
  const seconds = offset
    .replace(/^-/, "")
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0)
  return (offset.startsWith("-") ? -1 : 1) * seconds * 1000
}

function changed(
  game: GameSnapshot,
  change: Parameters<typeof Scenario.build>[1][number]["timeline"][number][1]
): GameSnapshot {
  const [home, away] = change.score ?? [game.home.score, game.away.score]
  const status = change.status ?? game.status
  const situation = situationOf(game, status, change)
  return new GameSnapshot({
    ...game,
    status,
    period: change.period ?? game.period,
    clock: change.clock ?? game.clock,
    home: { ...game.home, score: home },
    away: { ...game.away, score: away },
    ...(situation === undefined ? {} : { situation })
  })
}

/**
 * The game's situation after `change`: none until the game is live or a change describes one, and from then on
 * the earlier situation with the change merged in. Three timeouts each unless said otherwise.
 */
function situationOf(
  game: GameSnapshot,
  status: GameStatus,
  change: Parameters<typeof Scenario.build>[1][number]["timeline"][number][1]
): Situation | undefined {
  const before = game.situation
  const describes = change.ball !== undefined || change.timeouts !== undefined || change.lastPlay !== undefined
  if (before === undefined && !describes)
    return status === "live" ? new Situation({ isRedZone: false, homeTimeouts: 3, awayTimeouts: 3 }) : undefined
  const [homeTimeouts, awayTimeouts] = change.timeouts ?? [before?.homeTimeouts ?? 3, before?.awayTimeouts ?? 3]
  const lastPlay = change.lastPlay ?? before?.lastPlay
  const timing = { homeTimeouts, awayTimeouts, ...(lastPlay === undefined ? {} : { lastPlay }) }
  if (change.ball === null) return new Situation({ isRedZone: false, ...timing })
  if (change.ball === undefined) return new Situation({ ...(before ?? { isRedZone: false }), ...timing })
  const { team: side, yardLine, down, distance } = change.ball
  return new Situation({
    possession: game[side].team.id,
    yardLine,
    down,
    distance,
    isRedZone: yardLine <= 20,
    ...timing
  })
}
```

In `packages/domain/src/Source.ts`, change the `SourceName` line to:

```ts
export const SourceName = Schema.Literals(["YouTube TV", "Scenario"])
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm vitest run packages/domain/src/Scenario.test.ts`
Expected: PASS, 9 tests. If TypeScript rejects `new GameSnapshot({ ...game, … })`, that is the same spread `new Stage({ ...props.stage, … })` uses in `apps/web/src/stage/StageView.tsx`; check the field names before changing the approach.

- [ ] **Step 5: Add the glossary rows**

In `CONTEXT.md`, under **Game state**, after the **Test game** row, add:

```markdown
| **Scenario** | A timeline of game snapshots for several games, written or cut from a recording, that a Hub can play instead of a provider. | fixture, simulation |
| **Scenario time** | The clock a scenario plays on: from the Hub's start, at the scenario's speed. | |
```

- [ ] **Step 6: Check and commit**

Run: `pnpm check`
Expected: passes. (knip may report `Scenario` unused until Task 2 uses it; if it does, fold Task 2 into this commit rather than adding an ignore.)

```bash
git add packages/domain/src/Scenario.ts packages/domain/src/Scenario.test.ts packages/domain/src/Source.ts CONTEXT.md
git commit -m "feat(domain): a scenario, written as games and their changes, played at any start

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The named scenarios

**Files:**
- Create: `packages/domain/src/scenarios/TwoMinuteDrillTie.ts`, `ThreeRedZonesAtOnce.ts`, `AllLullsButOne.ts`, `BlowoutAndUpsetBrewing.ts`, `KickoffWindow.ts`, `Scenarios.ts`
- Test: `packages/domain/src/scenarios/Scenarios.test.ts`

**Interfaces:**
- Consumes: `Scenario.build` (Task 1).
- Produces: `scenarios: ReadonlyMap<string, Scenario>` from `@sportal/domain/scenarios/Scenarios`, with the names `two-minute-drill-tie`, `three-red-zones-at-once`, `all-lulls-but-one`, `blowout-and-upset-brewing`, `kickoff-window`. Game ids used by later tests: `tie-uga-ala` (in the red zone from 2:00 to 3:00 of `two-minute-drill-tie`).

- [ ] **Step 1: Write the failing test**

`packages/domain/src/scenarios/Scenarios.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Duration } from "effect"
import type { Scenario } from "../Scenario.ts"
import { allLullsButOne } from "./AllLullsButOne.ts"
import { kickoffWindow } from "./KickoffWindow.ts"
import { scenarios } from "./Scenarios.ts"
import { threeRedZonesAtOnce } from "./ThreeRedZonesAtOnce.ts"
import { twoMinuteDrillTie } from "./TwoMinuteDrillTie.ts"

const at = (scenario: Scenario, seconds: number) => scenario.slateAt(scenario.origin, Duration.seconds(seconds))
const game = (scenario: Scenario, id: string, seconds: number) =>
  at(scenario, seconds).find((candidate) => candidate.id === id)

describe("scenarios", () => {
  it("lists every scenario under its own name", () => {
    assert.deepStrictEqual(
      [...scenarios.keys()],
      [
        "two-minute-drill-tie",
        "three-red-zones-at-once",
        "all-lulls-but-one",
        "blowout-and-upset-brewing",
        "kickoff-window"
      ]
    )
    for (const [name, scenario] of scenarios) assert.strictEqual(scenario.name, name)
  })

  it("starts every scenario with at least three games", () => {
    for (const scenario of scenarios.values()) assert.isAtLeast(at(scenario, 0).length, 3)
  })

  it("drives the tied game into the red zone at 2:00 and wins it with a field goal", () => {
    assert.isFalse(game(twoMinuteDrillTie, "tie-uga-ala", 90)?.situation?.isRedZone)
    assert.isTrue(game(twoMinuteDrillTie, "tie-uga-ala", 120)?.situation?.isRedZone)
    assert.strictEqual(game(twoMinuteDrillTie, "tie-uga-ala", 180)?.home.score, 27)
    assert.strictEqual(game(twoMinuteDrillTie, "tie-uga-ala", 240)?.status, "final")
  })

  it("has three games in the red zone at once at 1:00", () => {
    assert.strictEqual(at(threeRedZonesAtOnce, 60).filter((g) => g.situation?.isRedZone).length, 3)
  })

  it("keeps every game but one still for the first two minutes", () => {
    const moving = at(allLullsButOne, 0).filter((before) => {
      const after = game(allLullsButOne, before.id, 120)
      return after?.clock !== before.clock || after?.status !== before.status
    })
    assert.deepStrictEqual(
      moving.map((g) => g.id),
      ["lull-aub-ark"]
    )
  })

  it("kicks games off one after another, one of them in the NFL", () => {
    assert.strictEqual(game(kickoffWindow, "ko-mia-unc", 60)?.status, "scheduled")
    assert.strictEqual(game(kickoffWindow, "ko-mia-unc", 120)?.status, "live")
    assert.strictEqual(game(kickoffWindow, "ko-kc-buf", 0)?.league, "nfl")
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run packages/domain/src/scenarios/Scenarios.test.ts`
Expected: FAIL, cannot find module `./AllLullsButOne.ts`.

- [ ] **Step 3: Write the scenarios**

`packages/domain/src/scenarios/TwoMinuteDrillTie.ts`:

```ts
import { Scenario } from "../Scenario.ts"

/** A tied top-five game decided by a two-minute drill, beside a blowout, a halftime, and a quiet first half. */
export const twoMinuteDrillTie = Scenario.build("two-minute-drill-tie", [
  {
    id: "tie-uga-ala",
    home: "UGA",
    away: "ALA",
    network: "CBS",
    kickoff: "-3:05:00",
    ranking: { home: 5, away: 2 },
    timeline: [
      ["0:00", { status: "live", period: 4, clock: "2:10", score: [24, 24], timeouts: [2, 2], ball: { team: "home", yardLine: 75, down: 1, distance: 10 } }],
      ["0:40", { clock: "1:48", ball: { team: "home", yardLine: 52, down: 2, distance: 4 } }],
      ["1:20", { clock: "1:12", ball: { team: "home", yardLine: 38, down: 1, distance: 10 } }],
      ["2:00", { clock: "0:41", ball: { team: "home", yardLine: 17, down: 1, distance: 10 } }],
      ["2:30", { clock: "0:22", timeouts: [1, 2], ball: { team: "home", yardLine: 9, down: 3, distance: 5 } }],
      ["3:00", { clock: "0:03", score: [27, 24], ball: null, lastPlay: "Field goal is good" }],
      ["3:40", { status: "final", clock: "0:00" }]
    ]
  },
  {
    id: "tie-osu-mich",
    home: "OSU",
    away: "MICH",
    network: "FOX",
    kickoff: "-2:20:00",
    timeline: [
      ["0:00", { status: "live", period: 3, clock: "6:30", score: [35, 7], ball: { team: "away", yardLine: 64, down: 2, distance: 7 } }],
      ["1:30", { clock: "4:10", ball: { team: "away", yardLine: 49, down: 3, distance: 2 } }],
      ["3:00", { clock: "1:55", ball: { team: "home", yardLine: 80, down: 1, distance: 10 }, lastPlay: "Punt" }]
    ]
  },
  {
    id: "tie-tex-ou",
    home: "TEX",
    away: "OU",
    network: "ABC",
    kickoff: "-1:40:00",
    timeline: [
      ["0:00", { status: "halftime", period: 2, clock: "0:00", score: [14, 10], ball: null }],
      ["4:00", { status: "live", period: 3, clock: "15:00", ball: { team: "away", yardLine: 75, down: 1, distance: 10 } }]
    ]
  },
  {
    id: "tie-lsu-miss",
    home: "LSU",
    away: "MISS",
    network: "ESPN",
    kickoff: "-1:10:00",
    timeline: [
      ["0:00", { status: "live", period: 2, clock: "9:12", score: [10, 3], ball: { team: "home", yardLine: 61, down: 1, distance: 10 } }],
      ["2:00", { clock: "7:40", ball: { team: "home", yardLine: 44, down: 2, distance: 6 } }]
    ]
  }
])
```

`packages/domain/src/scenarios/ThreeRedZonesAtOnce.ts`:

```ts
import { Scenario } from "../Scenario.ts"

/**
 * Three red-zone trips at once, of different worth: a one-score fourth quarter, a tie in the third, and a
 * blowout. They end in a go-ahead touchdown, an interception, and a garbage-time field goal.
 */
export const threeRedZonesAtOnce = Scenario.build("three-red-zones-at-once", [
  {
    id: "rz-psu-iowa",
    home: "PSU",
    away: "IOWA",
    network: "CBS",
    kickoff: "-3:00:00",
    timeline: [
      ["0:00", { status: "live", period: 4, clock: "5:20", score: [17, 13], ball: { team: "away", yardLine: 34, down: 2, distance: 6 } }],
      ["1:00", { clock: "4:31", ball: { team: "away", yardLine: 12, down: 1, distance: 10 } }],
      ["2:00", { clock: "3:58", score: [17, 20], ball: null, lastPlay: "Touchdown" }]
    ]
  },
  {
    id: "rz-fsu-clem",
    home: "FSU",
    away: "CLEM",
    network: "ABC",
    kickoff: "-2:00:00",
    timeline: [
      ["0:00", { status: "live", period: 3, clock: "8:05", score: [21, 21], ball: { team: "home", yardLine: 30, down: 1, distance: 10 } }],
      ["1:00", { clock: "7:20", ball: { team: "home", yardLine: 15, down: 2, distance: 5 } }],
      ["2:30", { clock: "6:02", ball: { team: "away", yardLine: 92, down: 1, distance: 10 }, lastPlay: "Interception" }]
    ]
  },
  {
    id: "rz-ore-wash",
    home: "ORE",
    away: "WASH",
    network: "FOX",
    kickoff: "-3:10:00",
    timeline: [
      ["0:00", { status: "live", period: 4, clock: "9:40", score: [38, 10], ball: { team: "home", yardLine: 41, down: 1, distance: 10 } }],
      ["1:00", { clock: "8:55", ball: { team: "home", yardLine: 8, down: 1, distance: 8 } }],
      ["3:00", { clock: "7:10", score: [41, 10], ball: null, lastPlay: "Field goal is good" }]
    ]
  },
  {
    id: "rz-ksu-isu",
    home: "KSU",
    away: "ISU",
    network: "ESPN",
    kickoff: "-1:00:00",
    timeline: [
      ["0:00", { status: "live", period: 2, clock: "11:00", score: [7, 7], ball: { team: "away", yardLine: 55, down: 1, distance: 10 } }],
      ["2:00", { clock: "9:30", ball: { team: "away", yardLine: 50, down: 3, distance: 5 } }]
    ]
  }
])
```

`packages/domain/src/scenarios/AllLullsButOne.ts`:

```ts
import { Scenario } from "../Scenario.ts"

/**
 * Every game stopped but one: a halftime, a timeout, the end of a quarter, and a weather delay, while one game
 * goes for it on fourth down late and scores.
 */
export const allLullsButOne = Scenario.build("all-lulls-but-one", [
  {
    id: "lull-aub-ark",
    home: "AUB",
    away: "ARK",
    network: "SECN",
    kickoff: "-3:15:00",
    timeline: [
      ["0:00", { status: "live", period: 4, clock: "1:55", score: [20, 23], ball: { team: "home", yardLine: 33, down: 4, distance: 2 } }],
      ["0:30", { clock: "1:40", ball: { team: "home", yardLine: 29, down: 1, distance: 10 } }],
      ["1:00", { clock: "1:02", ball: { team: "home", yardLine: 21, down: 2, distance: 2 } }],
      ["1:30", { clock: "0:40", ball: { team: "home", yardLine: 14, down: 1, distance: 10 } }],
      ["2:30", { clock: "0:31", score: [27, 23], ball: null, lastPlay: "Touchdown" }]
    ]
  },
  {
    id: "lull-tenn-uk",
    home: "TENN",
    away: "UK",
    network: "ESPN",
    kickoff: "-1:35:00",
    timeline: [
      ["0:00", { status: "halftime", period: 2, clock: "0:00", score: [17, 14], ball: null }],
      ["5:00", { status: "live", period: 3, clock: "15:00", ball: { team: "away", yardLine: 75, down: 1, distance: 10 } }]
    ]
  },
  {
    id: "lull-wisc-minn",
    home: "WISC",
    away: "MINN",
    network: "BTN",
    kickoff: "-2:10:00",
    timeline: [
      ["0:00", { status: "live", period: 3, clock: "4:12", score: [13, 10], timeouts: [3, 2], ball: { team: "home", yardLine: 66, down: 3, distance: 4 }, lastPlay: "Timeout Minnesota" }],
      ["3:30", { clock: "3:40", ball: { team: "home", yardLine: 58, down: 1, distance: 10 }, lastPlay: "Pass complete" }]
    ]
  },
  {
    id: "lull-unc-duke",
    home: "UNC",
    away: "DUKE",
    network: "ACCN",
    kickoff: "-0:35:00",
    timeline: [
      ["0:00", { status: "live", period: 1, clock: "0:00", score: [3, 0], ball: null, lastPlay: "End of 1st Quarter" }],
      ["3:00", { period: 2, clock: "15:00", ball: { team: "away", yardLine: 70, down: 1, distance: 10 } }]
    ]
  },
  {
    id: "lull-hou-rice",
    home: "HOU",
    away: "RICE",
    network: "ESPNU",
    kickoff: "-1:00:00",
    timeline: [["0:00", { status: "delayed", period: 2, clock: "6:12", score: [7, 10], ball: null, lastPlay: "Weather delay" }]]
  }
])
```

`packages/domain/src/scenarios/BlowoutAndUpsetBrewing.ts`:

```ts
import { Scenario } from "../Scenario.ts"

/** An unranked team leading the No. 3 team late, beside a No. 1 team's blowout and an even first half. */
export const blowoutAndUpsetBrewing = Scenario.build("blowout-and-upset-brewing", [
  {
    id: "upset-ala-van",
    home: "ALA",
    away: "VAN",
    network: "CBS",
    kickoff: "-2:50:00",
    ranking: { home: 3 },
    timeline: [
      ["0:00", { status: "live", period: 4, clock: "8:30", score: [17, 24], ball: { team: "away", yardLine: 70, down: 1, distance: 10 } }],
      ["1:30", { clock: "6:02", ball: { team: "away", yardLine: 45, down: 3, distance: 2 } }],
      ["3:00", { clock: "4:15", ball: { team: "home", yardLine: 80, down: 1, distance: 10 }, lastPlay: "Punt" }],
      ["4:30", { clock: "2:20", ball: { team: "home", yardLine: 48, down: 4, distance: 3 } }],
      ["5:30", { clock: "1:50", ball: { team: "away", yardLine: 52, down: 1, distance: 10 }, lastPlay: "Turnover on downs" }]
    ]
  },
  {
    id: "upset-osu-akr",
    home: "OSU",
    away: "AKR",
    network: "BTN",
    kickoff: "-2:00:00",
    ranking: { home: 1 },
    timeline: [
      ["0:00", { status: "live", period: 3, clock: "10:00", score: [49, 3], ball: { team: "home", yardLine: 35, down: 1, distance: 10 } }],
      ["2:00", { clock: "7:45", score: [56, 3], ball: null, lastPlay: "Touchdown" }]
    ]
  },
  {
    id: "upset-byu-utah",
    home: "BYU",
    away: "UTAH",
    network: "ESPN",
    kickoff: "-0:50:00",
    timeline: [
      ["0:00", { status: "live", period: 2, clock: "12:20", score: [14, 14], ball: { team: "home", yardLine: 58, down: 2, distance: 8 } }],
      ["3:00", { clock: "9:05", ball: { team: "home", yardLine: 37, down: 1, distance: 10 } }]
    ]
  }
])
```

`packages/domain/src/scenarios/KickoffWindow.ts`:

```ts
import { Scenario } from "../Scenario.ts"

/** Games kicking off two minutes apart, one of them in the NFL, the first scoring early. */
export const kickoffWindow = Scenario.build("kickoff-window", [
  {
    id: "ko-ala-msst",
    home: "ALA",
    away: "MSST",
    network: "SECN",
    timeline: [
      ["0:00", { status: "live", period: 1, clock: "15:00", ball: { team: "away", yardLine: 75, down: 1, distance: 10 } }],
      ["1:00", { clock: "13:20", ball: { team: "away", yardLine: 52, down: 1, distance: 10 } }],
      ["3:00", { clock: "9:45", score: [0, 7], ball: null, lastPlay: "Touchdown" }]
    ]
  },
  {
    id: "ko-mia-unc",
    home: "MIA",
    away: "UNC",
    network: "ACCN",
    kickoff: "2:00",
    timeline: [
      ["2:00", { status: "live", period: 1, clock: "15:00", ball: { team: "home", yardLine: 75, down: 1, distance: 10 } }],
      ["4:00", { clock: "12:10", ball: { team: "home", yardLine: 40, down: 2, distance: 3 } }]
    ]
  },
  {
    id: "ko-kc-buf",
    home: "KC",
    away: "BUF",
    league: "nfl",
    network: "CBS",
    kickoff: "4:00",
    timeline: [
      ["4:00", { status: "live", period: 1, clock: "15:00", ball: { team: "home", yardLine: 75, down: 1, distance: 10 } }],
      ["6:00", { clock: "11:30", ball: { team: "home", yardLine: 22, down: 1, distance: 10 } }]
    ]
  },
  {
    id: "ko-usc-ucla",
    home: "USC",
    away: "UCLA",
    network: "FOX",
    kickoff: "6:00",
    timeline: [
      ["6:00", { status: "live", period: 1, clock: "15:00", ball: { team: "away", yardLine: 75, down: 1, distance: 10 } }],
      ["7:00", { clock: "14:00", ball: { team: "away", yardLine: 61, down: 2, distance: 3 } }]
    ]
  }
])
```

`packages/domain/src/scenarios/Scenarios.ts`:

```ts
import type { Scenario } from "../Scenario.ts"
import { allLullsButOne } from "./AllLullsButOne.ts"
import { blowoutAndUpsetBrewing } from "./BlowoutAndUpsetBrewing.ts"
import { kickoffWindow } from "./KickoffWindow.ts"
import { threeRedZonesAtOnce } from "./ThreeRedZonesAtOnce.ts"
import { twoMinuteDrillTie } from "./TwoMinuteDrillTie.ts"

/** Every written scenario, by the name `SPORTAL_SCENARIO` gives it. */
export const scenarios: ReadonlyMap<string, Scenario> = new Map(
  [twoMinuteDrillTie, threeRedZonesAtOnce, allLullsButOne, blowoutAndUpsetBrewing, kickoffWindow].map(
    (scenario) => [scenario.name, scenario] as const
  )
)
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm vitest run packages/domain/src/scenarios/Scenarios.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Check and commit**

Run: `pnpm format && pnpm check`
Expected: passes. Biome may rewrap the long timeline lines; that is fine. If knip reports `scenarios` unused, fold this commit with Task 4's rather than adding an ignore.

```bash
git add packages/domain/src/scenarios
git commit -m "feat(domain): five written scenarios for the Director to handle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Scenario time

**Files:**
- Create: `apps/hub/src/scenario/ScenarioClock.ts`
- Test: `apps/hub/src/scenario/ScenarioClock.test.ts`

**Interfaces:**
- Produces: `ScenarioClock.layer(speed: number): Layer.Layer<never>` that provides `Clock.Clock`, imported as `import * as ScenarioClock from "./ScenarioClock.ts"`.

`TestClock.adjust` reads the `Clock` of the fiber it runs in, so in tests it must run where the scenario clock is **not** provided. Get the scenario clock with `Layer.build` and `Context.get`, as below, and adjust the test clock outside it.

- [ ] **Step 1: Write the failing test**

```ts
import { assert, describe, it } from "@effect/vitest"
import { Clock, Context, Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as ScenarioClock from "./ScenarioClock.ts"

describe("ScenarioClock", () => {
  it.effect("starts where the clock it replaces is and runs speed times faster", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute")
      const clock = Context.get(yield* Layer.build(ScenarioClock.layer(10)), Clock.Clock)
      assert.strictEqual(clock.currentTimeMillisUnsafe(), 60_000)
      yield* TestClock.adjust("1 second")
      assert.strictEqual(clock.currentTimeMillisUnsafe(), 70_000)
    }).pipe(Effect.scoped)
  )

  it.effect("wakes a sleeper once its duration has passed in scenario time", () =>
    Effect.gen(function* () {
      const clock = Context.get(yield* Layer.build(ScenarioClock.layer(10)), Clock.Clock)
      let woke = false
      yield* Effect.forkChild(
        clock.sleep(Duration.seconds(10)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              woke = true
            })
          )
        )
      )
      yield* TestClock.adjust(999)
      assert.isFalse(woke)
      yield* TestClock.adjust(1)
      assert.isTrue(woke)
    }).pipe(Effect.scoped)
  )
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run apps/hub/src/scenario/ScenarioClock.test.ts`
Expected: FAIL, cannot find module `./ScenarioClock.ts`.

- [ ] **Step 3: Write `ScenarioClock.ts`**

```ts
import { Clock, Duration, Effect, Layer } from "effect"

/**
 * Scenario time: a clock that starts where the one it replaces is and runs `speed` times faster, its sleeps
 * shortened to match. Ingest and the Scenario provider run on it, so a scenario plays faster without either
 * one waiting differently.
 */
export const layer = (speed: number) =>
  Layer.effect(
    Clock.Clock,
    Effect.gen(function* () {
      const real = yield* Clock.Clock
      const startMillis = real.currentTimeMillisUnsafe()
      const startMonotonic = real.monotonicTimeNanosUnsafe()
      const millis = () => startMillis + (real.currentTimeMillisUnsafe() - startMillis) * speed
      const nanos = () => BigInt(Math.round(millis() * 1_000_000))
      const monotonic = () =>
        startMonotonic + BigInt(Math.round(Number(real.monotonicTimeNanosUnsafe() - startMonotonic) * speed))
      return {
        currentTimeMillisUnsafe: millis,
        currentTimeMillis: Effect.sync(millis),
        currentTimeNanosUnsafe: nanos,
        currentTimeNanos: Effect.sync(nanos),
        monotonicTimeNanosUnsafe: monotonic,
        monotonicTimeNanos: Effect.sync(monotonic),
        sleep: (duration) => real.sleep(Duration.millis(Duration.toMillis(duration) / speed))
      } satisfies Clock.Clock
    })
  )
```

If `satisfies Clock.Clock` reports missing members, read `node_modules/effect/dist/Clock.d.ts` (the `Clock` interface) and add them with the same scaling; do not cast.

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm vitest run apps/hub/src/scenario/ScenarioClock.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

Run `pnpm check` (knip may flag the unused export until Task 7 wires it; fold into Task 4's commit if so).

```bash
git add apps/hub/src/scenario/ScenarioClock.ts apps/hub/src/scenario/ScenarioClock.test.ts
git commit -m "feat(hub): scenario time, a clock that runs at a scenario's speed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The Scenario provider

**Files:**
- Create: `apps/hub/src/scenario/ScenarioProvider.ts`
- Test: `apps/hub/src/scenario/ScenarioProvider.test.ts`
- Create: `fixtures/scenarios/.gitkeep` (empty), so the slice folder exists

**Interfaces:**
- Consumes: `Scenario`, `scenarios` (Tasks 1–2); `Provider` port; `ScenarioClock.layer` (Task 3) in the test.
- Produces:
  - `ScenarioProvider.layer(name: string, from?: string): Layer<Provider, ScenarioUnknown | PlatformError | SchemaError, FileSystem>`. `from` defaults to `folder`.
  - `ScenarioProvider.folder: string`: the absolute path of `fixtures/scenarios/`.

- [ ] **Step 1: Write the failing test**

```ts
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Scenario } from "@sportal/domain/Scenario"
import { Context, DateTime, Effect, FileSystem, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Ingest } from "../ingest/Ingest.ts"
import { Provider } from "../provider/Provider.ts"
import * as ScenarioClock from "./ScenarioClock.ts"
import * as ScenarioProvider from "./ScenarioProvider.ts"

describe("ScenarioProvider", () => {
  it.effect("answers each league with the scenario's slate at the time since it started", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      assert.strictEqual((yield* provider.slate("fbs")).length, 4)
      assert.deepStrictEqual(yield* provider.slate("nfl"), [])

      yield* TestClock.adjust("2 minutes")
      const tie = (yield* provider.slate("fbs")).find((game) => game.id === "tie-uga-ala")
      assert.isTrue(tie?.situation?.isRedZone)
    }).pipe(
      Effect.provide(ScenarioProvider.layer("two-minute-drill-tie").pipe(Layer.provide(NodeServices.layer)))
    )
  )

  it.effect("plays a recorded slice from its folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const slice = Scenario.build("slice", [
        { id: "9", home: "UGA", away: "ALA", timeline: [["0:00", { status: "live", period: 1, clock: "15:00" }]] }
      ])
      yield* fs.writeFileString(join(dir, "slice.json"), yield* Schema.encodeEffect(Schema.fromJsonString(Scenario))(slice))

      const slate = yield* Effect.gen(function* () {
        return yield* (yield* Provider).slate("fbs")
      }).pipe(Effect.provide(ScenarioProvider.layer("slice", dir)))
      assert.deepStrictEqual(
        slate.map((game) => game.id),
        ["9"]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("refuses a name it does not know, listing the names it does", () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const error = yield* Layer.build(ScenarioProvider.layer("../../etc/passwd", dir)).pipe(Effect.flip)
      assert.strictEqual(error._tag, "ScenarioUnknown")
      assert.include(error.message, "two-minute-drill-tie")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("plays at the scenario's speed under Ingest, while the rest of the Hub keeps real time", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Ingest.layer(["fbs"]).pipe(
          Layer.provide(ScenarioProvider.layer("two-minute-drill-tie")),
          Layer.provide(ScenarioClock.layer(10)),
          Layer.provide(NodeServices.layer)
        )
      )
      // 13 real seconds are 130 scenario seconds: the drive is at the 17, in the red zone, since 2:00.
      yield* TestClock.adjust("13 seconds")
      const tie = (yield* Context.get(context, Ingest).slate).find((game) => game.id === "tie-uga-ala")
      assert.isTrue(tie?.situation?.isRedZone)
      assert.strictEqual(DateTime.toEpochMillis(yield* DateTime.now), 13_000)
    }).pipe(Effect.scoped)
  )
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run apps/hub/src/scenario/ScenarioProvider.test.ts`
Expected: FAIL, cannot find module `./ScenarioProvider.ts`.

- [ ] **Step 3: Write `ScenarioProvider.ts`**

```ts
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Scenario } from "@sportal/domain/Scenario"
import { scenarios } from "@sportal/domain/scenarios/Scenarios"
import { DateTime, Duration, Effect, FileSystem, Layer, Schema } from "effect"
import { Provider } from "../provider/Provider.ts"

/**
 * A scenario as the provider: each league's slate is the scenario's at the time since the Hub started, which is
 * scenario time when the Hub runs on the scenario clock. `name` is a written scenario's, or a recorded slice's
 * in `from`.
 */
export const layer = (name: string, from: string = folder) =>
  Layer.effect(
    Provider,
    Effect.gen(function* () {
      const scenario = yield* load(name, from)
      const start = yield* DateTime.now
      yield* Effect.logInfo(`ScenarioProvider: playing ${scenario.name}, ${scenario.frames.length} frames`)
      return Provider.of({
        slate: (league) =>
          DateTime.now.pipe(
            Effect.map((now) =>
              scenario
                .slateAt(start, Duration.millis(DateTime.toEpochMillis(now) - DateTime.toEpochMillis(start)))
                .filter((game) => game.league === league)
            )
          )
      })
    })
  )

/** Where recorded slices are kept: `fixtures/scenarios/` at the repository's root. */
export const folder = fileURLToPath(new URL("../../../../fixtures/scenarios/", import.meta.url))

/** A written scenario by name, or else a slice in `from`. Only a listed name is read, so no name reaches a path. */
function load(name: string, from: string) {
  return Effect.gen(function* () {
    const written = scenarios.get(name)
    if (written !== undefined) return written
    const fs = yield* FileSystem.FileSystem
    const recorded = (yield* fs.exists(from))
      ? (yield* fs.readDirectory(from))
          .filter((file) => file.endsWith(".json"))
          .map((file) => file.slice(0, -".json".length))
      : []
    if (!recorded.includes(name))
      return yield* Effect.fail(new ScenarioUnknown({ name, known: [...scenarios.keys(), ...recorded] }))
    return yield* fs.readFileString(join(from, `${name}.json`)).pipe(Effect.flatMap(decodeScenario))
  })
}

/** `SPORTAL_SCENARIO` names neither a written scenario nor a recorded slice. */
class ScenarioUnknown extends Schema.TaggedError<ScenarioUnknown>()("ScenarioUnknown", {
  name: Schema.String,
  known: Schema.Array(Schema.String)
}) {
  override get message() {
    return `No scenario named "${this.name}". Known: ${this.known.join(", ")}`
  }
}

const decodeScenario = Schema.decodeEffect(Schema.fromJsonString(Scenario))
```

If `Schema.TaggedError` rejects a `message` getter, drop the getter and assert on `error.known` in the test instead.

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm vitest run apps/hub/src/scenario/ScenarioProvider.test.ts`
Expected: PASS, 4 tests. If the Ingest test sees the slate unchanged, the clock did not reach Ingest's fork: check that `Layer.provide(ScenarioClock.layer(10))` comes after `Layer.provide(ScenarioProvider.layer(…))` as written, so it is provided to both.

- [ ] **Step 5: Commit**

```bash
touch fixtures/scenarios/.gitkeep
git add apps/hub/src/scenario/ScenarioProvider.ts apps/hub/src/scenario/ScenarioProvider.test.ts fixtures/scenarios/.gitkeep
git commit -m "feat(hub): a scenario as the provider, written or recorded

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The Scenario source

**Files:**
- Create: `apps/hub/src/scenario/ScenarioSource.ts`
- Test: `apps/hub/src/scenario/ScenarioSource.test.ts`

**Interfaces:**
- Consumes: the `Source` port (`apps/hub/src/source/Source.ts`); `ChannelAvailability`.
- Produces: `ScenarioSource.layer: Layer<Source>`. Every game is `Carried` on `{ name: <first network or "Scenario">, source: "Scenario", locator: { _tag: "WebView", url: "/scenario-stream/<game id, URI-encoded>" } }`.

- [ ] **Step 1: Write the failing test**

```ts
import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import { broadcast, snapshot } from "@sportal/domain/TestGame"
import { Effect, Stream } from "effect"
import { Source } from "../source/Source.ts"
import * as ScenarioSource from "./ScenarioSource.ts"

describe("ScenarioSource", () => {
  it.effect("carries every game on its synthetic stream page, named for its first network", () =>
    Effect.gen(function* () {
      const availability = yield* (yield* Source).availability
      const carried = availability(snapshot({ broadcasts: [broadcast("CBS"), broadcast("Paramount+", "streaming")] }))
      assert.strictEqual(carried._tag, "Carried")
      if (carried._tag !== "Carried") return
      assert.deepStrictEqual(carried.channel, {
        name: "CBS",
        source: "Scenario",
        locator: { _tag: "WebView", url: "/scenario-stream/1" }
      })
    }).pipe(Effect.provide(ScenarioSource.layer))
  )

  it.effect("calls a game with no network's channel Scenario", () =>
    Effect.gen(function* () {
      const carried = (yield* (yield* Source).availability)(snapshot())
      assert.strictEqual(carried._tag === "Carried" ? carried.channel.name : undefined, "Scenario")
    }).pipe(Effect.provide(ScenarioSource.layer))
  )

  it.effect("learns nothing and never changes", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(Network.make("CBS"), "https://tv.youtube.com/watch/x")
      yield* source.readGuide("{}")
      assert.strictEqual(yield* Stream.runCount(source.changes), 0)
    }).pipe(Effect.provide(ScenarioSource.layer))
  )
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run apps/hub/src/scenario/ScenarioSource.test.ts`
Expected: FAIL, cannot find module `./ScenarioSource.ts`.

- [ ] **Step 3: Write `ScenarioSource.ts`**

```ts
import type { GameSnapshot } from "@sportal/domain/Game"
import { ChannelAvailability } from "@sportal/domain/Source"
import { Effect, Layer, Option, Stream } from "effect"
import { Source } from "../source/Source.ts"

/**
 * A scenario's source: every game is carried on the web UI's synthetic stream page for it, so a scenario needs
 * no sign-in and no stream budget. The address is a path, since only the web UI knows the origin it is served
 * from. Nothing is learned or stored.
 */
export const layer = Layer.succeed(
  Source,
  Source.of({
    availability: Effect.succeed((game: GameSnapshot) =>
      ChannelAvailability.Carried({
        channel: {
          name: game.broadcasts[0]?.network ?? "Scenario",
          source: "Scenario",
          locator: { _tag: "WebView", url: `/scenario-stream/${encodeURIComponent(game.id)}` }
        },
        learnedFor: Option.none()
      })
    ),
    changes: Stream.empty,
    readGuide: () => Effect.void,
    learn: () => Effect.void,
    markNotCarried: () => Effect.void,
    forget: () => Effect.void
  })
)
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm vitest run apps/hub/src/scenario/ScenarioSource.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/scenario/ScenarioSource.ts apps/hub/src/scenario/ScenarioSource.test.ts
git commit -m "feat(hub): a scenario's source, carrying every game on its synthetic stream

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Cutting recorded slices

**Files:**
- Modify: `apps/hub/src/provider/espn/EspnProvider.ts` (export `slateOf`)
- Create: `apps/hub/src/scenario/CutScenario.ts`
- Test: `apps/hub/src/scenario/CutScenario.test.ts`
- Modify: `apps/hub/package.json` (script)

**Interfaces:**
- Consumes: `EspnPayload.Scoreboard`; `Scenario`; `ScenarioProvider.folder` (Task 4).
- Produces:
  - `EspnProvider.slateOf(league: LeagueId, scoreboard: typeof EspnPayload.Scoreboard.Type): Effect<Array<GameSnapshot>>`
  - `CutScenario.cut(options: { name: string; recording: string; from: DateTime.Utc; to: DateTime.Utc; games: ReadonlyArray<string> }): Effect<Scenario, CutFailed | PlatformError, FileSystem>`
  - Script: `pnpm --filter @sportal/hub scenario:cut <name> <recording-dir> <from> <to> [game ids…]`, writing `fixtures/scenarios/<name>.json`.

- [ ] **Step 1: Write the failing test**

`apps/hub/src/scenario/CutScenario.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem } from "effect"
import * as CutScenario from "./CutScenario.ts"

// A real ESPN poll, recorded as the spike's recorder writes them: gzipped, named for the instant.
const poll = gzipSync(readFileSync(new URL("../provider/espn/fixtures/fbs-scoreboard-live.json", import.meta.url)))
const utc = (iso: string) => DateTime.makeUnsafe(iso)

describe("CutScenario.cut", () => {
  it.effect("makes a frame of each poll in the window, timed from the first", () =>
    Effect.gen(function* () {
      const recording = yield* recordingOf(["20261003T160848Z", "20261003T160918Z", "20261003T170000Z"])
      const scenario = yield* CutScenario.cut({
        name: "noon",
        recording,
        from: utc("2026-10-03T16:00:00Z"),
        to: utc("2026-10-03T16:30:00Z"),
        games: []
      })
      assert.deepStrictEqual(
        scenario.frames.map((frame) => frame.at),
        [0, 30_000]
      )
      assert.strictEqual(DateTime.toEpochMillis(scenario.origin), DateTime.toEpochMillis(utc("2026-10-03T16:08:48Z")))
      assert.strictEqual(scenario.frames[0]?.slate.length, 59)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps only the games named", () =>
    Effect.gen(function* () {
      const recording = yield* recordingOf(["20261003T160848Z"])
      const scenario = yield* CutScenario.cut({
        name: "one",
        recording,
        from: utc("2026-10-03T16:00:00Z"),
        to: utc("2026-10-03T17:00:00Z"),
        games: ["401862787"]
      })
      assert.deepStrictEqual(
        scenario.frames[0]?.slate.map((game) => game.id),
        ["401862787"]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("fails when no poll falls in the window", () =>
    Effect.gen(function* () {
      const recording = yield* recordingOf(["20261003T160848Z"])
      const error = yield* CutScenario.cut({
        name: "none",
        recording,
        from: utc("2026-10-03T20:00:00Z"),
        to: utc("2026-10-03T21:00:00Z"),
        games: []
      }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "CutFailed")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** A recording folder for college football holding the live poll under each of these instants. */
function recordingOf(instants: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const recording = join(yield* fs.makeTempDirectoryScoped(), "college-football")
    yield* fs.makeDirectory(join(recording, "scoreboard"), { recursive: true })
    for (const instant of instants) yield* fs.writeFile(join(recording, "scoreboard", `${instant}.json.gz`), poll)
    return recording
  })
}
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run apps/hub/src/scenario/CutScenario.test.ts`
Expected: FAIL, cannot find module `./CutScenario.ts`.

- [ ] **Step 3: Export `slateOf` from `EspnProvider.ts`**

Replace the body of `slate` inside `layer` so it only fetches and hands over:

```ts
    const slate = Effect.fn("EspnProvider.slate")(function* (league: LeagueId) {
      const scoreboard = yield* client.get(scoreboardUrl(league)).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(EspnPayload.Scoreboard)),
        Effect.mapError((cause) => new ProviderError({ league, cause }))
      )
      return yield* slateOf(league, scoreboard)
    })
```

and add, directly below `layer`:

```ts
/** The snapshots in one ESPN scoreboard; an event that does not decode is skipped and logged. */
export const slateOf = Effect.fn("EspnProvider.slateOf")(function* (
  league: LeagueId,
  scoreboard: typeof EspnPayload.Scoreboard.Type
) {
  const snapshots: Array<GameSnapshot> = []
  for (const raw of scoreboard.events) {
    const event = decodeEvent(raw)
    if (Option.isNone(event)) {
      yield* Effect.logWarning("EspnProvider: skipped an event that failed to decode", raw)
      continue
    }
    const snapshot = toSnapshot(league, event.value)
    if (Option.isSome(snapshot)) snapshots.push(snapshot.value)
  }
  return snapshots
})
```

Run: `pnpm vitest run apps/hub/src/provider/espn/EspnProvider.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 4: Write `CutScenario.ts`**

```ts
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Scenario } from "@sportal/domain/Scenario"
import { DateTime, Effect, FileSystem, Option, Schema } from "effect"
import * as EspnPayload from "../provider/espn/EspnPayload.ts"
import * as EspnProvider from "../provider/espn/EspnProvider.ts"
import { folder } from "./ScenarioProvider.ts"

/**
 * A window of a recorded game day as a scenario: each scoreboard poll in it, decoded as ESPN's live ones are, is a
 * frame, timed from the first. `recording` is a league's folder of the spike's recorder (`…/college-football`
 * or `…/nfl`); `games`, when not empty, keeps only those games.
 */
export const cut = Effect.fn("CutScenario.cut")(function* (options: {
  name: string
  recording: string
  from: DateTime.Utc
  to: DateTime.Utc
  games: ReadonlyArray<string>
}) {
  const league = leagues[basename(options.recording)]
  if (league === undefined)
    return yield* Effect.fail(new CutFailed({ reason: `${options.recording} is not a college-football or nfl recording` }))
  const fs = yield* FileSystem.FileSystem
  const scoreboards = join(options.recording, "scoreboard")
  const polls = (yield* fs.readDirectory(scoreboards))
    .flatMap((file) => Option.toArray(Option.map(instantOf(file), (instant) => ({ file, instant }))))
    .filter(({ instant }) => DateTime.between(instant, { minimum: options.from, maximum: options.to }))
    .sort((a, b) => DateTime.toEpochMillis(a.instant) - DateTime.toEpochMillis(b.instant))
  const [first] = polls
  if (first === undefined)
    return yield* Effect.fail(new CutFailed({ reason: `no scoreboard poll in ${scoreboards} falls in the window` }))

  const frames: Array<{ at: number; slate: ReadonlyArray<GameSnapshot> }> = []
  for (const { file, instant } of polls) {
    const bytes = yield* fs.readFile(join(scoreboards, file))
    const scoreboard = yield* Effect.try({
      try: () => gunzipSync(bytes).toString("utf8"),
      catch: () => new CutFailed({ reason: `${file} is not gzipped` })
    }).pipe(
      Effect.flatMap((json) =>
        decodeScoreboard(json).pipe(Effect.mapError(() => new CutFailed({ reason: `${file} is not an ESPN scoreboard` })))
      )
    )
    const slate = (yield* EspnProvider.slateOf(league, scoreboard)).filter(
      (game) => options.games.length === 0 || options.games.includes(game.id)
    )
    frames.push({ at: DateTime.toEpochMillis(instant) - DateTime.toEpochMillis(first.instant), slate })
  }
  return new Scenario({ name: options.name, origin: first.instant, frames })
})

/** A recording could not be cut into a scenario, and why. */
class CutFailed extends Schema.TaggedError<CutFailed>()("CutFailed", { reason: Schema.String }) {}

const leagues: Record<string, LeagueId> = { "college-football": "fbs", nfl: "nfl" }

/** The instant a recorded poll was taken, from its name ("20261003T160848Z.json.gz"). */
function instantOf(file: string): Option.Option<DateTime.Utc> {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json\.gz$/.exec(file)
  if (match === null) return Option.none()
  const [, year, month, day, hour, minute, second] = match
  return Option.some(DateTime.makeUnsafe(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`))
}

const decodeScoreboard = Schema.decodeEffect(Schema.fromJsonString(EspnPayload.Scoreboard))

// As a script: pnpm --filter @sportal/hub scenario:cut <name> <recording-dir> <from> <to> [game ids…]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, recording, from, to, ...games] = process.argv.slice(2)
  const window = Option.all({
    from: DateTime.make(from ?? "").pipe(Option.map(DateTime.toUtc)),
    to: DateTime.make(to ?? "").pipe(Option.map(DateTime.toUtc))
  })
  if (name === undefined || !/^[a-z0-9-]+$/.test(name) || recording === undefined || Option.isNone(window)) {
    console.error(
      "Usage: scenario:cut <name, lowercase-and-dashes> <recording-dir> <from ISO instant> <to ISO instant> [game ids…]"
    )
    process.exitCode = 1
  } else {
    Effect.gen(function* () {
      // pnpm runs scripts in the package; a relative recording path is the caller's.
      const scenario = yield* cut({
        name,
        recording: resolve(process.env.INIT_CWD ?? process.cwd(), recording),
        ...window.value,
        games
      })
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(Scenario))(scenario)
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(folder, { recursive: true })
      const path = join(folder, `${name}.json`)
      yield* fs.writeFileString(path, json)
      yield* Effect.logInfo(
        `CutScenario: wrote ${path}: ${scenario.frames.length} frames, ${Math.round(json.length / 1024)} KB`
      )
    }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
  }
}
```

In `apps/hub/package.json` `scripts`, add:

```json
    "scenario:cut": "node src/scenario/CutScenario.ts"
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm vitest run apps/hub/src/scenario/CutScenario.test.ts apps/hub/src/provider/espn/EspnProvider.test.ts`
Expected: PASS.

- [ ] **Step 6: Cut one real slice by hand**

The recordings are git-ignored and live only in the main checkout. Find a window with a red-zone trip:

```bash
cd /home/chazzy/development/projects/sportal/fixtures/espn-recordings/2026-10-03/college-football/scoreboard
for f in $(ls | sed -n '1~20p'); do echo "$f $(zcat $f | jq '[.events[] | select(.competitions[0].situation.isRedZone == true) | .id] | length')"; done
```

Pick a window of about 20 minutes around a poll with several red-zone games and two or three of those game ids, then:

```bash
cd /home/chazzy/development/projects/sportal-director
pnpm --filter @sportal/hub scenario:cut recorded-red-zones /home/chazzy/development/projects/sportal/fixtures/espn-recordings/2026-10-03/college-football <from> <to> <id> <id> <id>
```

Expected: `CutScenario: wrote …/fixtures/scenarios/recorded-red-zones.json: N frames, K KB`, with K under 1000. If it is larger, narrow the window or the games.

- [ ] **Step 7: Check and commit**

Run: `pnpm check`

```bash
git add apps/hub/src/provider/espn/EspnProvider.ts apps/hub/src/scenario/CutScenario.ts apps/hub/src/scenario/CutScenario.test.ts apps/hub/package.json fixtures/scenarios/recorded-red-zones.json
git commit -m "feat(hub): cut a recorded window into a scenario slice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Scenario mode in the Hub

**Files:**
- Modify: `apps/hub/src/main.ts`
- Modify: `AGENTS.md` (Commands)

**Interfaces:**
- Consumes: `ScenarioClock.layer`, `ScenarioProvider.layer`, `ScenarioSource.layer`.
- Produces: `SPORTAL_SCENARIO=<name>` and `SPORTAL_SCENARIO_SPEED=<n>` (default 1) on the Hub.

- [ ] **Step 1: Wire it in `main.ts`**

Add the imports:

```ts
import * as ScenarioClock from "./scenario/ScenarioClock.ts"
import * as ScenarioProvider from "./scenario/ScenarioProvider.ts"
import * as ScenarioSource from "./scenario/ScenarioSource.ts"
```

After the `routes` constant, add:

```ts
    // A scenario plays a game day in place of ESPN and YouTube TV. Only Ingest and the scenario run on scenario
    // time; the rest of the Hub keeps the real clock.
    const scenario = yield* Config.String("SPORTAL_SCENARIO").pipe(Config.option)
    const speed = yield* Config.Number("SPORTAL_SCENARIO_SPEED").pipe(Config.withDefault(1))
    const leagues = ["nfl", "fbs"] as const
    const games = Option.match(scenario, {
      onNone: () =>
        Layer.mergeAll(
          Ingest.layer(leagues).pipe(Layer.provide(EspnProvider.layer)),
          YouTubeTv.layer.pipe(Layer.provide(SqlChannelStore.layer))
        ),
      onSome: (name) =>
        Layer.mergeAll(
          Ingest.layer(leagues).pipe(
            Layer.provide(ScenarioProvider.layer(name)),
            Layer.provide(ScenarioClock.layer(speed))
          ),
          ScenarioSource.layer
        )
    })
```

and replace the provide chain with:

```ts
    return HttpRouter.serve(routes).pipe(
      Layer.provide(StageSessions.layer),
      Layer.provide(games),
      Layer.provide(Database.layer(join(dataDir, "sportal.sqlite"))),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(NodeHttpServer.layer(createServer, { port, host })),
      Layer.provide(NodeServices.layer)
    )
```

If TypeScript cannot unify the two `Option.match` branches, annotate `games` with the `Layer.Layer<Ingest | Source, …, …>` it reports for the ESPN branch widened by the scenario branch's error and requirement types. Do not cast.

- [ ] **Step 2: Run the Hub in scenario mode**

```bash
cd /home/chazzy/development/projects/sportal-director
SPORTAL_DATA_DIR=$(mktemp -d) SPORTAL_PORT=4410 SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_SCENARIO_SPEED=10 timeout 20 node apps/hub/src/main.ts &
sleep 14; curl -s http://127.0.0.1:4410/api/slate | jq '[.[] | {id, clock, red: .situation.isRedZone}]'; wait
```

Expected: the log says `ScenarioProvider: playing two-minute-drill-tie, 9 frames`; after about 14 seconds, `tie-uga-ala` shows clock `0:41` or `0:22` with `red: true`. If `/api/slate` is not the slate route, find it in `packages/api/src/SportalApi.ts`. Then run it with `SPORTAL_SCENARIO=no-such` and check that it exits listing the known names.

- [ ] **Step 3: Document the command**

In `AGENTS.md` under **Commands**, after the `pnpm dev` line, add:

```markdown
- `SPORTAL_SCENARIO=<name> SPORTAL_SCENARIO_SPEED=10 pnpm dev` — play a scenario instead of ESPN and YouTube TV, ten
  times faster: a written one (`packages/domain/src/scenarios/Scenarios.ts`) or a recorded slice in
  `fixtures/scenarios/`. Every game plays as a synthetic stream page. Cut a slice from a recording with
  `pnpm --filter @sportal/hub scenario:cut <name> <recording-dir> <from> <to> [game ids…]`.
```

- [ ] **Step 4: Check and commit**

Run: `pnpm check`

```bash
git add apps/hub/src/main.ts AGENTS.md
git commit -m "feat(hub): SPORTAL_SCENARIO plays a scenario in place of ESPN and YouTube TV

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The synthetic stream page

**Files:**
- Create: `apps/web/src/scenario/ScenarioStream.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/stage/TileRects.ts` (`placements`), `apps/web/src/stage/StageView.tsx:37`
- Test: `apps/web/src/stage/TileRects.test.ts`

**Interfaces:**
- Consumes: `useLive()` from `apps/web/src/hub/Live.ts`; `TeamLogo`; `statusText`.
- Produces: `placements(stage, rects, origin, page: string)`. A locator URL that starts with `/` comes back resolved against `page`; any other URL is unchanged.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/stage/TileRects.test.ts`, pass a fourth argument `page` to every existing `placements(…)` call (`"http://127.0.0.1:4401"`), and add to `describe("placements", …)`:

```ts
  it("resolves a scenario stream's path against the page's origin and leaves full addresses alone", () => {
    const scenario = {
      name: "CBS",
      source: "Scenario" as const,
      locator: { _tag: "WebView" as const, url: "/scenario-stream/401856707" }
    }
    const carriedOnScenario = () => ChannelAvailability.Carried({ channel: scenario, learnedFor: Option.none() })
    const stage = Result.getOrThrow(
      Result.getOrThrow(Stage.initial.apply({ _tag: "Assign", tile: 0, game: bama }, carriedOnScenario)).apply(
        { _tag: "Assign", tile: 1, game: irish },
        carriedOnFox
      )
    )
    assert.deepStrictEqual(
      placements(stage, tileRects(stage, area), { x: 0, y: 0 }, "http://127.0.0.1:4401").map((p) => p.url),
      ["http://127.0.0.1:4401/scenario-stream/401856707", "https://tv.youtube.com/watch/fox"]
    )
  })
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run apps/web/src/stage/TileRects.test.ts`
Expected: FAIL, the first URL is still the bare path.

- [ ] **Step 3: Resolve the path in `placements`**

In `apps/web/src/stage/TileRects.ts`, extend the doc comment and signature, and resolve the stream URL:

```ts
/**
 * What the shell must show for each stream and picking tile with a size: its game's view, in window pixels.
 * `origin` is where the Stage area sits in the window; `page` is the web UI's own address, which a source's path
 * (a scenario's synthetic stream) is resolved against.
 */
export function placements(
  stage: Stage,
  rects: ReturnType<typeof tileRects>,
  origin: { x: number; y: number },
  page: string
): Array<TilePlacement> {
```

and in the `StreamTile` branch:

```ts
        ? {
            url: tile.channel.locator.url.startsWith("/")
              ? new URL(tile.channel.locator.url, page).href
              : tile.channel.locator.url,
            role: "stream" as const,
            muted: stage.audioFocus !== tile.game
          }
```

In `apps/web/src/stage/StageView.tsx`, change line 37 to:

```ts
  const placed = placements(shown, rects, area, window.location.origin)
```

Run: `pnpm vitest run apps/web/src/stage/TileRects.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the page**

`apps/web/src/scenario/ScenarioStream.tsx`:

```tsx
import type { GameSnapshot } from "@sportal/domain/Game"
import { useEffect } from "react"
import { useLive } from "../hub/Live.ts"
import { statusText } from "../slate/StatusText.ts"
import { TeamLogo } from "../slate/TeamLogo.tsx"

/**
 * A scenario's stream of one game, in place of a provider's player: the game's live state from the Hub over a
 * moving test pattern, so a frozen stream shows, and a steady tone of the game's own pitch, so audio focus can be
 * heard moving. The shell mutes it like any stream.
 */
export function ScenarioStream(props: { game: string }) {
  const { slate, connected } = useLive()
  const game = slate.find((candidate) => candidate.id === props.game)
  useTone(props.game)
  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-white">
      <style>{"@keyframes scenario-pan { to { background-position: 160px 0 } }"}</style>
      <div
        aria-hidden
        className="absolute inset-0 opacity-30"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, #c0c0c0 0 20px, #c0c000 20px 40px, #00c0c0 40px 60px, #00c000 60px 80px, #c000c0 80px 100px, #c00000 100px 120px, #0000c0 120px 140px, #101010 140px 160px)",
          animation: "scenario-pan 4s linear infinite"
        }}
      />
      {game === undefined ? (
        <p className="relative grid h-full place-items-center font-mono text-[4vmin]">
          {connected ? `No game ${props.game} in this scenario` : "Waiting for the Hub"}
        </p>
      ) : (
        <Scorebug game={game} />
      )}
      <p className="absolute right-[2vmin] bottom-[2vmin] font-mono text-[2.5vmin] opacity-70">{props.game}</p>
    </div>
  )
}

function useTone(game: string) {
  useEffect(() => {
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    // A semitone in the two octaves above A3, from the game id, so each game has its own note.
    const step = [...game].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 24
    oscillator.frequency.value = 220 * 2 ** (step / 12)
    gain.gain.value = 0.05
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    return () => {
      void context.close()
    }
  }, [game])
}

function Scorebug(props: { game: GameSnapshot }) {
  const { game } = props
  const situation = game.situation
  const down = situation?.down
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-[4vmin] font-sans">
      <div className="flex flex-col gap-[2vmin] text-[10vmin] font-semibold tabular-nums leading-none">
        {[game.away, game.home].map((side) => (
          <div key={side.team.id} className="flex items-center gap-[3vmin]">
            <TeamLogo team={side.team} size={64} />
            <span className="w-[20vmin]">{side.team.abbreviation}</span>
            <span>{side.score}</span>
            {situation?.possession === side.team.id && <span className="text-[5vmin] text-yellow-300">●</span>}
          </div>
        ))}
      </div>
      <p className="font-mono text-[6vmin]">{statusText(game)}</p>
      {down !== undefined && situation?.distance !== undefined && situation.yardLine !== undefined && (
        <p className="font-mono text-[5vmin]">
          {["1st", "2nd", "3rd", "4th"][down - 1]} &amp; {situation.distance} · {situation.yardLine} to the goal
        </p>
      )}
      {situation?.isRedZone && (
        <p className="rounded bg-red-600 px-[3vmin] py-[1vmin] font-semibold text-[5vmin]">RED ZONE</p>
      )}
      {situation?.lastPlay !== undefined && <p className="text-[3.5vmin] opacity-80">{situation.lastPlay}</p>}
    </div>
  )
}
```

- [ ] **Step 5: Route it in `main.tsx`**

Replace the render with:

```tsx
// A phone opens /remote, from the desk's join code; a scenario's stream view opens /scenario-stream/<game>;
// every other path is a Display.
const path = window.location.pathname
const scenarioStream = "/scenario-stream/"
createRoot(root).render(
  <StrictMode>
    {path.startsWith("/remote") ? (
      <RemoteView />
    ) : path.startsWith(scenarioStream) ? (
      <ScenarioStream game={decodeURIComponent(path.slice(scenarioStream.length))} />
    ) : (
      <App />
    )}
  </StrictMode>
)
```

with `import { ScenarioStream } from "./scenario/ScenarioStream.tsx"`, and delete the old comment above the render.

- [ ] **Step 6: Look at the page**

Start the Hub in scenario mode on its usual port and the web dev server:

```bash
SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_SCENARIO_SPEED=10 pnpm --filter @sportal/hub dev
pnpm --filter @sportal/web dev
```

Open `http://127.0.0.1:4401/scenario-stream/tie-uga-ala` in a browser (the page may need one click before it plays sound in a plain browser). Expected: moving colour bars, UGA and ALA with scores, `Q4` and a clock that ticks down every second or so, down and distance, and the red-zone mark from about 12 seconds in. `/scenario-stream/nope` reads "No game nope in this scenario". Stop both servers.

- [ ] **Step 7: Check and commit**

Run: `pnpm check`

```bash
git add apps/web/src/scenario apps/web/src/main.tsx apps/web/src/stage/TileRects.ts apps/web/src/stage/TileRects.test.ts apps/web/src/stage/StageView.tsx
git commit -m "feat(web): the synthetic stream page a scenario's tiles play

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The shell admits scenario streams

**Files:**
- Modify: `apps/desktop/src/main/ProviderSession.ts`
- Modify: `apps/desktop/src/main/TileViews.ts:6,113`
- Modify: `apps/desktop/src/main/main.ts:23`
- Test: `apps/desktop/src/main/ProviderSession.test.ts`; update `TileViews.test.ts:351` and `GuideReader.test.ts:155`

**Interfaces:**
- Produces:
  - `allows(url: string, ui: string): boolean`: true for the existing provider hosts (https only), and for `ui`'s exact origin with a path under `/scenario-stream/`.
  - `ProviderSession.layer(ui: string)`; the service gains `readonly allows: (url: string) => boolean`.

- [ ] **Step 1: Write the failing tests**

In `ProviderSession.test.ts`, add `const ui = "http://127.0.0.1:4401"` near the top, change `ProviderSession.layer` (line 144) to `ProviderSession.layer(ui)`, change both `allows(url)` calls to `allows(url, ui)`, and add these cases:

```ts
  it.each(["http://127.0.0.1:4401/scenario-stream/401856707", "http://127.0.0.1:4401/scenario-stream/tie-uga-ala"])(
    "allows the UI's own scenario stream %s",
    (url) => {
      expect(allows(url, ui)).toBe(true)
    }
  )

  it.each([
    "http://127.0.0.1:4401/",
    "http://127.0.0.1:4401/remote",
    "http://127.0.0.1:4402/scenario-stream/1",
    "http://localhost:4401/scenario-stream/1",
    "https://evil.example/scenario-stream/1"
  ])("refuses %s, which is not the UI's scenario stream", (url) => {
    expect(allows(url, ui)).toBe(false)
  })
```

In `TileViews.test.ts:351` and `GuideReader.test.ts:155`, change `ProviderSession.layer` to `ProviderSession.layer("http://127.0.0.1:4401")`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run apps/desktop/src/main/ProviderSession.test.ts`
Expected: FAIL; TypeScript or the new cases reject the second argument.

- [ ] **Step 3: Implement**

In `ProviderSession.ts`:

1. Add to the service shape, after `createView`:

```ts
    /** Whether a provider view may load `url`: the provider's pages, or the UI's own scenario streams. */
    readonly allows: (url: string) => boolean
```

2. Make the layer take the UI's address: `static readonly layer = (ui: string) => Layer.effect(`, and at the start of its `Effect.gen` add `const permits = (url: string) => allows(url, ui)`. Pass `permits` instead of `allows` to both `confine(…)` calls, and add `allows: permits,` to `ProviderSession.of({ … })`.

3. Replace `allows`:

```ts
/**
 * Provider views may visit the provider and its sign-in pages, and the web UI's own synthetic stream pages for a
 * scenario (`ui` is the address the shell loads the UI from).
 */
export function allows(url: string, ui: string): boolean {
  if (!URL.canParse(url)) return false
  const { protocol, hostname, origin, pathname } = new URL(url)
  if (URL.canParse(ui) && origin === new URL(ui).origin && pathname.startsWith("/scenario-stream/")) return true
  return protocol === "https:" && allowedHosts.includes(hostname)
}
```

In `TileViews.ts`, import `{ hostOf, load, ProviderSession }` (drop `allows`) and change line 113 to `if (providers.allows(placement.url)) permitted.push(placement)`.

In `apps/desktop/src/main/main.ts`, change `Layer.provide(ProviderSession.layer)` to `Layer.provide(ProviderSession.layer(hubUrl))`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run apps/desktop`
Expected: PASS, including TileViews and GuideReader.

- [ ] **Step 5: Check and commit**

Run: `pnpm check`

```bash
git add apps/desktop/src/main
git commit -m "feat(desktop): provider views admit the UI's own scenario streams, and nothing else on it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: End to end in the shell

**Files:**
- Modify: `docs/game-day-checklist.md`

Electron launched from an agent's shell misreports rendering on this machine, so the user runs this step; the implementer prepares it and records the result the user reports.

- [ ] **Step 1: Add the checklist row**

Append to the table in `docs/game-day-checklist.md`, after row 34:

```markdown
| 35 | Run `SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_SCENARIO_SPEED=10 pnpm dev`, fill four tiles from the strip | Each tile plays a synthetic stream: colour bars moving, its game's score and clock ticking; no sign-in, no picking tile. Moving audio focus (`1`–`4`) moves the tone you hear. `tie-uga-ala` shows RED ZONE about 12 seconds in and goes final about 22 seconds in |
```

- [ ] **Step 2: Ask the user to run row 35**

Ask the user to run, from the worktree, `SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_SCENARIO_SPEED=10 pnpm dev` and check row 35. If no tone plays in the shell, add `autoplayPolicy: "no-user-gesture-required"` to the `createView` `webPreferences` in `ProviderSession.ts`, with a test asserting it, and ask again.

- [ ] **Step 3: Commit**

```bash
git add docs/game-day-checklist.md
git commit -m "docs: game-day row for playing a scenario in the shell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
