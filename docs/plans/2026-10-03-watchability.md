# Game Events and Watchability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score every game 0–100 on how worth watching it is right now, flag lulls, give reasons, and show the scores live, so the Director (piece 3) can rank games and the weights can be tuned by watching a scenario.

**Architecture:** Pure domain first: `GameSnapshot#eventsSince(previous)` derives `GameEvent`s; `Watchability` is a `Schema.Class` folded forward one snapshot at a time (`Watchability.initial`, `watchability.next(before, after, now)`), remembering just enough (when play last showed, break and boost windows) to tell a lull. A Hub `Watch` service folds every game on each Ingest change, on Ingest's clock, and the live stream's `SlateChanged` carries the result. The web strip and the synthetic stream page show it.

**Tech Stack:** Effect 4 (`Schema.Class`, `Data.taggedEnum`, `Context.Service`, `SubscriptionRef`, `effect/testing` `TestClock`), `@effect/vitest`, React 19.

**Spec:** `docs/specs/2026-10-03-watchability-design.md`. Work on `main` in `/home/chazzy/development/projects/sportal` (the user said so for this phase).

## Global Constraints

- Read `AGENTS.md` first. Effect 4 is newer than most training data: check `node_modules/effect/ai-docs/src/` and the `.d.ts` files before writing Effect code from memory.
- Every exported type name is a `CONTEXT.md` term. This plan adds **Lull** and sharpens **GameEvent** and **Watchability**.
- An operation on a domain type lives on the type (method or static). Main export first; private helpers below as hoisted `function` declarations; a constant beside its only user; no options-bag type aliases; no `any`, casts outside decoding, non-null assertions, enums, default exports, or barrels.
- Time comes from Effect's `Clock` (`DateTime.now`) in the Hub; domain code takes `now` as a parameter.
- Ranking: late and close first, then field position, then stakes. Field-position credit counts fully only in a one-score game (margin ≤ 8); otherwise 20% of it.
- Anticipation starts at the opponent's 40 (`yardLine` ≤ 40). ESPN's `yardLine` is yards to the goal the team with the ball attacks; the red zone is ≤ 20.
- Lull: halftime, `delayed`, or a live game whose clock reads 0:00; a 90 s break after a timeout (not in the last two minutes of a half or in overtime), a score, or a change of possession that is not a turnover, ended early by a new last play; or no change in clock or last play for **60 s** (measured on the 2026-10-03 recordings: with 30 s polls, 25% of live poll pairs sat unchanged for 60 s or more, 38% for 30 s, so 45 s would flag ordinary play).
- Every weight and window is a named constant beside the code that uses it. Scenario tests pin orderings, not exact scores.
- Tests sit beside their file as `Name.test.ts`; run one with `pnpm vitest run <path>`. `pnpm check` must pass before every commit.
- The user runs the app from this checkout while you work: never start anything on ports 4400 or 4401.
- Commit messages end with a `Co-Authored-By:` trailer naming the model that wrote the commit.

## Files

| File | Responsibility |
| --- | --- |
| `packages/domain/src/GameEvent.ts` (create) | The `GameEvent` tagged enum |
| `packages/domain/src/Game.ts` (modify) | `GameSnapshot#eventsSince`, `#secondsLeft`, `#inTwoMinuteDrill` |
| `packages/domain/src/Situation.ts` (modify) | `Situation#inScoringRange`, `#goalToGo` |
| `packages/domain/src/Watchability.ts` (create) | Score, lull, reasons, memory; `initial` and `next` |
| `apps/hub/src/watch/Watch.ts` (create) | Folds the slate into watchability on Ingest's clock |
| `apps/hub/src/main.ts`, `http/HubServer.ts` (modify) | Wire `Watch`; publish watchability |
| `packages/api/src/LiveMessage.ts` (modify) | `SlateChanged` carries `watchability` |
| `apps/web/src/hub/Live.ts`, `slate/SlateView.tsx`, `scenario/ScenarioStream.tsx` (modify) | Keep and show it |
| `CONTEXT.md`, `docs/technical-spec.md`, the spec (modify) | Glossary and doc alignment |

---

### Task 1: Game events

**Files:**
- Create: `packages/domain/src/GameEvent.ts`
- Modify: `packages/domain/src/Game.ts`, `packages/domain/src/Situation.ts`
- Test: `packages/domain/src/GameEvent.test.ts`
- Modify: `CONTEXT.md` (GameEvent row), `docs/technical-spec.md` §5.2

**Interfaces:**
- Produces:
  - `GameEvent` (type) and `GameEvent` (constructors and `$match`/`$is`, from `Data.taggedEnum`) with members: `ScoreChanged { game, team, points }`, `EnteredRedZone { game, team }`, `ReachedScoringRange { game, team }`, `GoalToGo { game, team }`, `FourthDown { game, team }`, `TwoMinuteDrill { game }`, `Overtime { game }`, `Turnover { game, team }` (team that gained the ball), `PossessionChanged { game, team }`, `TimeoutTaken { game, team }`, `PeriodEnded { game, period }`, `WentToHalftime { game }`, `WentFinal { game }`. `game: GameId`, `team: TeamId`.
  - `snapshot.eventsSince(previous: GameSnapshot): ReadonlyArray<GameEvent>`
  - `snapshot.secondsLeft(): number` — an unreadable clock reads as a full quarter (900).
  - `snapshot.inTwoMinuteDrill(): boolean` — live, Q2 or Q4, 0 < seconds left ≤ 120.
  - `situation.inScoringRange(): boolean` (`yardLine` ≤ 40), `situation.goalToGo(): boolean` (`distance` ≥ `yardLine`).

`diff` is a method on `GameSnapshot` (`next.eventsSince(previous)`), not a static on `GameEvent`: the rule is that an operation on a domain type lives on that type, and `GameEvent.ts` imports `Game.ts` only as types, so there is no import cycle at runtime.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/GameEvent.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "./Game.ts"
import { Situation } from "./Situation.ts"
import { snapshot, team } from "./TestGame.ts"

const live = (overrides: Partial<GameSnapshot> = {}) =>
  snapshot({
    status: "live",
    period: 4,
    clock: "5:00",
    home: { team: team("UGA"), score: 21 },
    away: { team: team("ALA"), score: 17 },
    ...overrides
  })
const ball = (side: "UGA" | "ALA", yardLine: number, down = 1, distance = 10, rest: Partial<Situation> = {}) =>
  new Situation({
    possession: team(side).id,
    yardLine,
    down,
    distance,
    isRedZone: yardLine <= 20,
    homeTimeouts: 3,
    awayTimeouts: 3,
    ...rest
  })
const tags = (before: GameSnapshot, after: GameSnapshot) => after.eventsSince(before).map((event) => event._tag)

describe("GameSnapshot#eventsSince", () => {
  it("reports each side's points", () => {
    const events = live({ home: { team: team("UGA"), score: 28 } }).eventsSince(live())
    assert.deepStrictEqual(events.map((e) => (e._tag === "ScoreChanged" ? [e.team, e.points] : e._tag)), [["fbs:UGA", 7]])
  })

  it("reports a drive reaching the 40, then the red zone, then goal to go, once each", () => {
    const at = (yardLine: number, distance = 10) => live({ situation: ball("ALA", yardLine, 1, distance) })
    assert.deepStrictEqual(tags(at(55), at(38)), ["ReachedScoringRange"])
    assert.deepStrictEqual(tags(at(38), at(30)), [])
    assert.deepStrictEqual(tags(at(30), at(18)), ["EnteredRedZone"])
    assert.deepStrictEqual(tags(at(18), at(6, 6)), ["GoalToGo"])
  })

  it("reports fourth down once per spot", () => {
    const fourth = live({ situation: ball("ALA", 33, 4, 2) })
    assert.deepStrictEqual(tags(live({ situation: ball("ALA", 34, 3, 3) }), fourth), ["FourthDown"])
    assert.deepStrictEqual(tags(fourth, fourth), [])
  })

  it("calls a change of possession a turnover only when the last play says interception or fumble", () => {
    const before = live({ situation: ball("ALA", 45) })
    const picked = live({ situation: ball("UGA", 70, 1, 10, { lastPlay: "Pass INTERCEPTED by K.Smith" }) })
    const punted = live({ situation: ball("UGA", 80, 1, 10, { lastPlay: "J.Doe punt 40 yards" }) })
    const unclear = live({ situation: ball("UGA", 80) })
    assert.deepStrictEqual(tags(before, picked), ["Turnover"])
    assert.deepStrictEqual(tags(before, punted), ["PossessionChanged"])
    assert.deepStrictEqual(tags(before, unclear), ["PossessionChanged"])
  })

  it("does not call the ball changing hands after a score a turnover", () => {
    const before = live({ situation: ball("ALA", 3, 1, 3) })
    const after = live({
      away: { team: team("ALA"), score: 24 },
      situation: ball("UGA", 75, 1, 10, { lastPlay: "Fumble recovered in the end zone, touchdown" })
    })
    assert.deepStrictEqual(tags(before, after), ["ScoreChanged", "PossessionChanged"])
  })

  it("reports a timeout from a drop in either side's count", () => {
    const before = live({ situation: ball("ALA", 45) })
    const after = live({ situation: ball("ALA", 45, 1, 10, { awayTimeouts: 2 }) })
    assert.deepStrictEqual(tags(before, after), ["TimeoutTaken"])
  })

  it("reports the clock and status: two-minute drill, end of a period, halftime, overtime, final", () => {
    assert.deepStrictEqual(tags(live({ clock: "2:05" }), live({ clock: "1:58" })), ["TwoMinuteDrill"])
    assert.deepStrictEqual(tags(live({ period: 1, clock: "0:00" }), live({ period: 2, clock: "15:00" })), ["PeriodEnded"])
    assert.deepStrictEqual(tags(live({ period: 2, clock: "0:00" }), live({ period: 2, status: "halftime" })), [
      "WentToHalftime"
    ])
    assert.deepStrictEqual(tags(live({ clock: "0:00" }), live({ period: 5, clock: "" })), ["Overtime", "PeriodEnded"])
    assert.deepStrictEqual(tags(live(), live({ status: "final" })), ["WentFinal"])
  })
})

describe("GameSnapshot#secondsLeft", () => {
  it("reads the clock, and an unreadable one as a full quarter", () => {
    assert.strictEqual(live({ clock: "2:10" }).secondsLeft(), 130)
    assert.strictEqual(live({ clock: "0:00" }).secondsLeft(), 0)
    assert.strictEqual(live({ clock: "" }).secondsLeft(), 900)
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run packages/domain/src/GameEvent.test.ts`
Expected: FAIL, `eventsSince` is not a function (or the module does not compile).

- [ ] **Step 3: Write `GameEvent.ts`**

```ts
import { Data } from "effect"
import type { GameId } from "./Game.ts"
import type { TeamId } from "./Team.ts"

/**
 * Something that happened in a game between two snapshots of it, derived by `GameSnapshot#eventsSince` and never
 * stored as truth. `team` is the team that scored, has the ball, gained it, or called the timeout.
 */
export type GameEvent = Data.TaggedEnum<{
  ScoreChanged: { readonly game: GameId; readonly team: TeamId; readonly points: number }
  EnteredRedZone: { readonly game: GameId; readonly team: TeamId }
  ReachedScoringRange: { readonly game: GameId; readonly team: TeamId }
  GoalToGo: { readonly game: GameId; readonly team: TeamId }
  FourthDown: { readonly game: GameId; readonly team: TeamId }
  TwoMinuteDrill: { readonly game: GameId }
  Overtime: { readonly game: GameId }
  Turnover: { readonly game: GameId; readonly team: TeamId }
  PossessionChanged: { readonly game: GameId; readonly team: TeamId }
  TimeoutTaken: { readonly game: GameId; readonly team: TeamId }
  PeriodEnded: { readonly game: GameId; readonly period: number }
  WentToHalftime: { readonly game: GameId }
  WentFinal: { readonly game: GameId }
}>
export const GameEvent = Data.taggedEnum<GameEvent>()
```

- [ ] **Step 4: Add the `Situation` methods**

In `packages/domain/src/Situation.ts`, give the class a body:

```ts
export class Situation extends Schema.Class<Situation>("sportal/Situation")({
  …fields unchanged…
}) {
  /** The ball is at the opponent's 40 or closer: about field-goal range, where a drive starts to matter. */
  inScoringRange(): boolean {
    return this.yardLine !== undefined && this.yardLine <= scoringRange
  }

  /** The line to gain is the goal line. */
  goalToGo(): boolean {
    return this.yardLine !== undefined && this.distance !== undefined && this.distance >= this.yardLine
  }
}

/** Yards to the goal at which a drive is in scoring range. */
const scoringRange = 40
```

- [ ] **Step 5: Add the `GameSnapshot` methods**

In `packages/domain/src/Game.ts`, import `{ GameEvent } from "./GameEvent.ts"` and `type { Situation }` is already imported as a value (`Situation`); add to the class body, after `progress()`:

```ts
  /** Seconds left in the period, from the clock ("2:10"). An unreadable clock reads as a full quarter. */
  secondsLeft(): number {
    const [minutes, seconds] = this.clock.split(":").map(Number)
    const total = (minutes ?? Number.NaN) * 60 + (seconds ?? 0)
    return Number.isFinite(total) ? total : quarterSeconds
  }

  /** Live in the last two minutes of the first or second half, with time still on the clock. */
  inTwoMinuteDrill(): boolean {
    const left = this.secondsLeft()
    return this.status === "live" && (this.period === 2 || this.period === 4) && left > 0 && left <= 120
  }

  /**
   * What happened in this game since `previous`, an earlier snapshot of it: points, the ball changing hands, a
   * drive reaching the 40, the red zone, goal to go, or fourth down, a timeout, and the clock and status. A change
   * of possession is a turnover only when the last play names an interception or a fumble and nobody scored.
   */
  eventsSince(previous: GameSnapshot): ReadonlyArray<GameEvent> {
    const game = this.id
    const events: Array<GameEvent> = []
    for (const side of ["home", "away"] as const) {
      const points = this[side].score - previous[side].score
      if (points > 0) events.push(GameEvent.ScoreChanged({ game, team: this[side].team.id, points }))
    }
    const scored = events.length > 0
    const before = previous.situation
    const after = this.situation
    const team = after?.possession
    if (team !== undefined && before?.possession !== undefined && team !== before.possession)
      events.push(
        !scored && /intercept|fumble/i.test(after?.lastPlay ?? "")
          ? GameEvent.Turnover({ game, team })
          : GameEvent.PossessionChanged({ game, team })
      )
    if (team !== undefined && after !== undefined) {
      // Only a change on the same team's drive is news; a new drive starting deep is not.
      const already = (test: (situation: Situation) => boolean) =>
        before !== undefined && before.possession === team && test(before)
      if (after.inScoringRange() && !already((s) => s.inScoringRange()))
        events.push(GameEvent.ReachedScoringRange({ game, team }))
      if (after.isRedZone && !already((s) => s.isRedZone)) events.push(GameEvent.EnteredRedZone({ game, team }))
      if (after.goalToGo() && !already((s) => s.goalToGo())) events.push(GameEvent.GoalToGo({ game, team }))
      if (after.down === 4 && !already((s) => s.down === 4 && s.yardLine === after.yardLine))
        events.push(GameEvent.FourthDown({ game, team }))
    }
    if (before !== undefined && after !== undefined) {
      if (after.homeTimeouts < before.homeTimeouts)
        events.push(GameEvent.TimeoutTaken({ game, team: this.home.team.id }))
      if (after.awayTimeouts < before.awayTimeouts)
        events.push(GameEvent.TimeoutTaken({ game, team: this.away.team.id }))
    }
    if (this.inTwoMinuteDrill() && !previous.inTwoMinuteDrill()) events.push(GameEvent.TwoMinuteDrill({ game }))
    if (this.period >= 5 && previous.period < 5) events.push(GameEvent.Overtime({ game }))
    if (this.period > previous.period && previous.period >= 1)
      events.push(GameEvent.PeriodEnded({ game, period: previous.period }))
    if (this.status === "halftime" && previous.status !== "halftime") events.push(GameEvent.WentToHalftime({ game }))
    if (this.status === "final" && previous.status !== "final") events.push(GameEvent.WentFinal({ game }))
    return events
  }
```

and below `progressRank`:

```ts
/** Seconds in a quarter, college and NFL alike. */
const quarterSeconds = 15 * 60
```

The reaching-the-40 test expects only `ReachedScoringRange` at the 38 and only `EnteredRedZone` at the 18 (already in range): the order above produces exactly that. The red-zone-to-goal-to-go step (18 → 6 with distance 6) produces only `GoalToGo`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm vitest run packages/domain/src/GameEvent.test.ts packages/domain`
Expected: PASS. If `tags(live({ clock: "0:00" }), live({ period: 5, clock: "" }))` orders differently, the order in Step 5 governs: `Overtime` before `PeriodEnded`.

- [ ] **Step 7: Docs**

`CONTEXT.md`, GameEvent row: `| **GameEvent** | Something that happened in a game between two snapshots of it: a score, the ball changing hands, a drive reaching the 40, the red zone, goal to go, fourth down, a timeout, a period or the game ending. Derived, never stored. | alert, update |`

`docs/technical-spec.md` §5.2: replace "The pure function `GameEvent.diff(previous, next)` derives events: `ScoreChanged`, `EnteredRedZone`, `Turnover`, `PeriodEnded`, `WentFinal`." with "`snapshot.eventsSince(previous)` derives events (see `GameEvent`), including the leading signals the Director anticipates with."

- [ ] **Step 8: Check and commit**

Run: `pnpm check`

```bash
git add packages/domain/src/GameEvent.ts packages/domain/src/GameEvent.test.ts packages/domain/src/Game.ts packages/domain/src/Situation.ts CONTEXT.md docs/technical-spec.md
git commit -m "feat(domain): game events, derived from two snapshots of a game"
```

(End the message with your Co-Authored-By trailer.)

---

### Task 2: Watchability

**Files:**
- Create: `packages/domain/src/Watchability.ts`
- Test: `packages/domain/src/Watchability.test.ts`
- Modify: `CONTEXT.md` (Watchability row, new Lull row), `docs/specs/2026-10-03-watchability-design.md` (three lines)

**Interfaces:**
- Consumes: `GameSnapshot#eventsSince`, `#secondsLeft`, `#inTwoMinuteDrill`, `#isLive`; `Situation#inScoringRange`, `#goalToGo` (Task 1).
- Produces: `class Watchability extends Schema.Class` with fields `game: GameId`, `score: number` (Int 0–100), `lull: boolean`, `reasons: ReadonlyArray<string>`, `activeAt: DateTime.Utc`, optional `breakUntil`, `boostUntil`; `Watchability.initial(game: GameSnapshot, now: DateTime.Utc): Watchability`; `watchability.next(before: GameSnapshot, after: GameSnapshot, now: DateTime.Utc): Watchability`.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/Watchability.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration } from "effect"
import type { GameSnapshot } from "./Game.ts"
import { Situation } from "./Situation.ts"
import { snapshot, team } from "./TestGame.ts"
import { Watchability } from "./Watchability.ts"

const now = DateTime.makeUnsafe("2026-10-03T20:00:00Z")
const later = (seconds: number) => DateTime.addDuration(now, Duration.seconds(seconds))
const game = (overrides: Partial<GameSnapshot> = {}) =>
  snapshot({
    status: "live",
    period: 4,
    clock: "2:10",
    home: { team: team("UGA"), score: 24 },
    away: { team: team("ALA"), score: 24 },
    ...overrides
  })
const ball = (yardLine: number, down = 1, distance = 10, rest: Partial<Situation> = {}) =>
  new Situation({
    possession: team("UGA").id,
    yardLine,
    down,
    distance,
    isRedZone: yardLine <= 20,
    homeTimeouts: 3,
    awayTimeouts: 3,
    ...rest
  })
const score = (g: GameSnapshot) => Watchability.initial(g, now).score

describe("Watchability.initial", () => {
  it("scores a game that is not live 0", () => {
    assert.strictEqual(score(game({ status: "scheduled" })), 0)
    assert.strictEqual(score(game({ status: "final" })), 0)
  })

  it("ranks late and close first", () => {
    assert.isAbove(score(game()), score(game({ period: 2, clock: "8:00" })))
    assert.isAbove(score(game()), score(game({ home: { team: team("UGA"), score: 45 } })))
    assert.isAbove(score(game({ period: 5, clock: "" })), score(game({ period: 4, clock: "12:00" })))
  })

  it("raises a one-score game as its drive nears the goal, and barely a blowout's", () => {
    const tied = (situation: Situation) => score(game({ situation }))
    assert.isAbove(tied(ball(38)), tied(ball(75)))
    assert.isAbove(tied(ball(15)), tied(ball(38)))
    assert.isAbove(tied(ball(4, 1, 4)), tied(ball(15)))
    const blowout = (situation: Situation) => score(game({ home: { team: team("UGA"), score: 52 }, situation }))
    assert.isBelow(blowout(ball(4, 1, 4)) - blowout(ball(75)), tied(ball(4, 1, 4)) - tied(ball(75)))
  })

  it("puts late and close above field position: a tied fourth quarter at midfield beats a two-score third in the red zone", () => {
    const tiedLate = score(game({ situation: ball(50) }))
    const redZoneEarlier = score(
      game({ period: 3, clock: "9:00", home: { team: team("UGA"), score: 31 }, situation: ball(12) })
    )
    assert.isAbove(tiedLate, redZoneEarlier)
  })

  it("names an upset brewing", () => {
    const upset = Watchability.initial(
      game({
        clock: "6:00",
        home: { team: team("ALA"), score: 17, ranking: 3 },
        away: { team: team("VAN"), score: 24 }
      }),
      now
    )
    assert.include(upset.reasons.join(" | "), "upset brewing: VAN leads #3 ALA")
  })

  it("leads its reasons with the largest part", () => {
    assert.strictEqual(Watchability.initial(game(), now).reasons[0], "tied Q4, 2:10")
  })

  it("is in a lull at halftime, in a delay, at 0:00 between periods, and after a timeout called as the last play", () => {
    assert.isTrue(Watchability.initial(game({ period: 2, status: "halftime", clock: "0:00" }), now).lull)
    assert.isTrue(Watchability.initial(game({ status: "delayed" }), now).lull)
    assert.isTrue(Watchability.initial(game({ period: 1, clock: "0:00" }), now).lull)
    assert.isTrue(
      Watchability.initial(game({ clock: "8:00", situation: ball(60, 1, 10, { lastPlay: "Timeout Georgia" }) }), now).lull
    )
    assert.isFalse(Watchability.initial(game({ situation: ball(60) }), now).lull)
  })
})

describe("Watchability#next", () => {
  it("falls into a lull once neither the clock nor the last play has changed for 60 seconds", () => {
    const g = game({ clock: "8:00", situation: ball(60) })
    const first = Watchability.initial(g, now)
    assert.isFalse(first.next(g, g, later(59)).lull)
    assert.isTrue(first.next(g, g, later(60)).lull)
    const moved = game({ clock: "7:40", situation: ball(55) })
    assert.isFalse(first.next(g, g, later(60)).next(g, moved, later(70)).lull)
  })

  it("takes a 90-second break after a score, ended early by a new last play", () => {
    const before = game({ clock: "8:00", situation: ball(3, 1, 3) })
    const scored = game({ clock: "7:52", home: { team: team("UGA"), score: 31 }, situation: ball(75, 1, 10, { lastPlay: "TD" }) })
    const afterScore = Watchability.initial(before, now).next(before, scored, later(10))
    assert.isTrue(afterScore.lull)
    // The clock moves but no new play shows: the break holds until it runs out.
    const ticking = game({ clock: "7:40", home: { team: team("UGA"), score: 31 }, situation: ball(75, 1, 10, { lastPlay: "TD" }) })
    assert.isTrue(afterScore.next(scored, ticking, later(99)).lull)
    assert.isFalse(afterScore.next(scored, ticking, later(101)).lull)
    const kickoff = game({ clock: "7:52", home: { team: team("UGA"), score: 31 }, situation: ball(75, 1, 10, { lastPlay: "Kickoff" }) })
    assert.isFalse(afterScore.next(scored, kickoff, later(40)).lull)
  })

  it("takes no break for a timeout in the two-minute drill", () => {
    const before = game({ clock: "1:30", situation: ball(30) })
    const timeout = game({ clock: "1:24", situation: ball(26, 2, 6, { homeTimeouts: 2 }) })
    assert.isFalse(Watchability.initial(before, now).next(before, timeout, later(10)).lull)
  })

  it("boosts a game for a minute after a turnover, without a break", () => {
    const before = game({ clock: "9:00", situation: new Situation({ ...ball(45), possession: team("ALA").id }) })
    const picked = game({ clock: "8:51", situation: ball(70, 1, 10, { lastPlay: "INTERCEPTED" }) })
    const first = Watchability.initial(before, now)
    const turned = first.next(before, picked, later(10))
    assert.isFalse(turned.lull)
    assert.isAbove(turned.score, Watchability.initial(picked, now).score)
    assert.strictEqual(turned.next(picked, picked, later(71)).score, Watchability.initial(picked, now).score)
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run packages/domain/src/Watchability.test.ts`
Expected: FAIL, cannot find module `./Watchability.ts`.

- [ ] **Step 3: Write `Watchability.ts`**

```ts
import { DateTime, Duration, Schema } from "effect"
import { GameId, type GameSnapshot } from "./Game.ts"

/**
 * How worth watching a game is right now, 0–100, whether it is in a lull, and why — with what it remembers to tell
 * a lull: when play last showed, and how long a break or a boost lasts. Folded forward one snapshot at a time.
 */
export class Watchability extends Schema.Class<Watchability>("sportal/Watchability")({
  game: GameId,
  score: Schema.Int,
  lull: Schema.Boolean,
  /** Short reasons for the score, the largest part first. */
  reasons: Schema.Array(Schema.String),
  /** When the game last showed play: its clock, last play, period, or status changed. */
  activeAt: Schema.DateTimeUtcFromString,
  /** Until when a TV break after a timeout, a score, or a change of possession lasts, unless play shows first. */
  breakUntil: Schema.optional(Schema.DateTimeUtcFromString),
  /** Until when a score or a turnover still adds to the score. */
  boostUntil: Schema.optional(Schema.DateTimeUtcFromString)
}) {
  /** A game first seen at `now`. With no history, a lull shows only from its status, its clock, or a timeout as its last play. */
  static initial(game: GameSnapshot, now: DateTime.Utc): Watchability {
    const timeout = /timeout/i.test(game.situation?.lastPlay ?? "") && !lateInHalf(game)
    return judged(game, now, {
      activeAt: now,
      breakUntil: timeout ? DateTime.addDuration(now, breakLength) : undefined,
      boostUntil: undefined
    })
  }

  /** This game one snapshot on: `before` is the snapshot this was judged from, `after` the new one. */
  next(before: GameSnapshot, after: GameSnapshot, now: DateTime.Utc): Watchability {
    const events = after.eventsSince(before)
    const played =
      before.clock !== after.clock ||
      before.period !== after.period ||
      before.status !== after.status ||
      before.situation?.lastPlay !== after.situation?.lastPlay
    const breaks = events.some(
      (event) =>
        event._tag === "ScoreChanged" ||
        event._tag === "PossessionChanged" ||
        (event._tag === "TimeoutTaken" && !lateInHalf(after))
    )
    const boosts = events.some((event) => event._tag === "ScoreChanged" || event._tag === "Turnover")
    const newPlay = before.situation?.lastPlay !== after.situation?.lastPlay
    return judged(after, now, {
      activeAt: played ? now : this.activeAt,
      breakUntil: breaks ? DateTime.addDuration(now, breakLength) : newPlay ? undefined : this.breakUntil,
      boostUntil: boosts ? DateTime.addDuration(now, boostLength) : this.boostUntil
    })
  }
}

/** How long a TV break is taken to last after a timeout, a score, or a change of possession. */
const breakLength = Duration.seconds(90)
/** How long a score or a turnover adds to a game's score. */
const boostLength = Duration.seconds(60)
/** No change in the clock or the last play for this long is a lull (60 s: see the plan's measurement). */
const stoppedAfter = Duration.seconds(60)

function judged(
  game: GameSnapshot,
  now: DateTime.Utc,
  memory: { activeAt: DateTime.Utc; breakUntil: DateTime.Utc | undefined; boostUntil: DateTime.Utc | undefined }
): Watchability {
  const breakUntil = stillOn(memory.breakUntil, now)
  const boostUntil = stillOn(memory.boostUntil, now)
  const stopped =
    DateTime.toEpochMillis(now) - DateTime.toEpochMillis(memory.activeAt) >= Duration.toMillis(stoppedAfter)
  const lull =
    game.status === "halftime" ||
    game.status === "delayed" ||
    (game.status === "live" && (game.secondsLeft() === 0 || breakUntil !== undefined || stopped))
  const parts = game.isLive()
    ? [closeness(game), situation(game), stakes(game), ...(boostUntil === undefined ? [] : [boost])]
    : []
  return new Watchability({
    game: game.id,
    score: Math.min(100, Math.round(parts.reduce((total, part) => total + part.points, 0))),
    lull,
    reasons: parts
      .filter((part) => part.points >= 1)
      .sort((a, b) => b.points - a.points)
      .map((part) => part.reason),
    activeAt: memory.activeAt,
    ...(breakUntil === undefined ? {} : { breakUntil }),
    ...(boostUntil === undefined ? {} : { boostUntil })
  })
}

function stillOn(until: DateTime.Utc | undefined, now: DateTime.Utc): DateTime.Utc | undefined {
  return until !== undefined && DateTime.isGreaterThan(until, now) ? until : undefined
}

/** The last two minutes of a half or overtime: timeouts there are short, not TV breaks. */
function lateInHalf(game: GameSnapshot): boolean {
  return game.inTwoMinuteDrill() || (game.status === "live" && game.period >= 5)
}

/** Late and close: the largest part. Overtime counts fully; the fourth quarter more the less time is left. */
function closeness(game: GameSnapshot) {
  const margin = Math.abs(game.home.score - game.away.score)
  const lateness =
    game.period >= 5
      ? 1
      : game.period === 4
        ? 0.6 + 0.4 * (1 - game.secondsLeft() / (15 * 60))
        : (earlyLateness[game.period] ?? 0)
  const close = margin <= 3 ? 1 : margin <= oneScore ? 0.8 : margin <= 16 ? 0.35 : 0.05
  const how = margin === 0 ? "tied" : margin <= oneScore ? "one-score" : margin <= 16 ? "two-score" : `${margin}-point`
  const period = game.period >= 5 ? "OT" : `Q${game.period}`
  return { points: closenessPoints * lateness * close, reason: `${how} ${period}, ${game.clock}` }
}

const closenessPoints = 50
/** Lateness of the first three quarters, by period. */
const earlyLateness = [0, 0.1, 0.2, 0.35]
/** A margin one score can tie or overturn. */
const oneScore = 8

/**
 * Field position and the clock for the team with the ball: from the 40, the red zone, goal to go, fourth down, the
 * two-minute drill. Full credit only in a one-score game.
 */
function situation(game: GameSnapshot) {
  const s = game.situation
  if (game.status !== "live" || s === undefined || s.possession === undefined || s.yardLine === undefined)
    return { points: 0, reason: "" }
  const offense = s.possession === game.home.team.id ? game.home.team : game.away.team
  const signals: Array<[number, string]> = []
  if (s.isRedZone) signals.push([redZonePoints, `red zone at the ${s.yardLine}`])
  else if (s.inScoringRange()) signals.push([scoringRangePoints, `at the ${s.yardLine}`])
  if (s.goalToGo()) signals.push([goalToGoPoints, "goal to go"])
  if (s.down === 4) signals.push([fourthDownPoints, `4th & ${s.distance ?? "?"}`])
  if (lateInHalf(game)) signals.push([twoMinutePoints, game.period >= 5 ? "overtime possession" : "two-minute drill"])
  const raw = Math.min(situationCap, signals.reduce((total, [points]) => total + points, 0))
  const margin = Math.abs(game.home.score - game.away.score)
  return {
    points: raw * (margin <= oneScore ? 1 : blowoutShare),
    reason: `${offense.abbreviation} ${signals.map(([, label]) => label).join(", ")}`
  }
}

const redZonePoints = 16
const scoringRangePoints = 8
const goalToGoPoints = 6
const fourthDownPoints = 6
const twoMinutePoints = 6
const situationCap = 30
/** The share of field-position credit a game more than one score apart keeps. */
const blowoutShare = 0.2

/** Stakes, from the third quarter in a one-score game: an upset brewing, or two ranked teams. */
function stakes(game: GameSnapshot) {
  const margin = Math.abs(game.home.score - game.away.score)
  if (game.period < 3 || margin > oneScore) return { points: 0, reason: "" }
  for (const [ranked, other] of [
    [game.home, game.away],
    [game.away, game.home]
  ] as const) {
    if (
      ranked.ranking !== undefined &&
      (other.ranking === undefined || other.ranking > ranked.ranking) &&
      other.score >= ranked.score
    )
      return {
        points: upsetPoints,
        reason: `upset brewing: ${other.team.abbreviation} ${other.score > ranked.score ? "leads" : "ties"} #${ranked.ranking} ${ranked.team.abbreviation}`
      }
  }
  return game.home.ranking !== undefined && game.away.ranking !== undefined
    ? {
        points: rankedPoints,
        reason: `#${game.away.ranking} ${game.away.team.abbreviation} at #${game.home.ranking} ${game.home.team.abbreviation}`
      }
    : { points: 0, reason: "" }
}

const upsetPoints = 10
const rankedPoints = 6

/** A score or a turnover in the last minute. */
const boost = { points: 8, reason: "just scored or turned over" }
```

If Biome's line width reflows these, that is fine. If `Schema.optional` produces a `?: T | undefined` type rather than `?: T`, the conditional spreads still compile; keep them.

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm vitest run packages/domain/src/Watchability.test.ts`
Expected: PASS. If an ordering test fails, do not change the test: print both scores and their reasons, adjust the named constants minimally, and record the change and the numbers in your report.

- [ ] **Step 5: Docs**

`CONTEXT.md` — Watchability row: `| **Watchability** | A 0–100 score of how worth watching a live game is right now, whether it is in a lull, and why; folded forward one snapshot at a time. | excitement, heat |`. Add after it: `| **Lull** | A live game with nothing happening: halftime, a delay, between periods, a TV break after a timeout, score, or change of possession, or no play for a minute. | break, stoppage |`

`docs/specs/2026-10-03-watchability-design.md`: in the Lull row, "45 s or more" → "60 s or more (measured on the recordings)"; in "Where memory lives", the signature → `Watchability.initial(snapshot, now)` and `watchability.next(before, after, now)`, which derives the events itself; in the Events row, `GameEvent.diff(previous, next)` → `next.eventsSince(previous)` and add `PossessionChanged`.

- [ ] **Step 6: Check and commit**

Run: `pnpm check`

```bash
git add packages/domain/src/Watchability.ts packages/domain/src/Watchability.test.ts CONTEXT.md docs/specs/2026-10-03-watchability-design.md
git commit -m "feat(domain): watchability, a game's worth watching now, its lulls, and why"
```

---

### Task 3: Watchability through the scenarios

**Files:**
- Test: `packages/domain/src/scenarios/Scenarios.test.ts` (add a `describe`)

**Interfaces:**
- Consumes: `Watchability` (Task 2); the written scenarios and `Scenario#slateAt` (piece 1).

This task pins the spec's scenario expectations. It changes weights only if they fail, and reports numbers.

- [ ] **Step 1: Write the tests**

Add to `packages/domain/src/scenarios/Scenarios.test.ts` (keep the existing imports; add `Watchability`, `DateTime`, and the scenario imports you need):

```ts
/**
 * Each game's watchability at every 10 seconds of scenario time, folded as the Hub folds it each poll. Keys are game
 * ids; values are [second, watchability] pairs.
 */
function watched(scenario: Scenario, seconds: number) {
  const history = new Map<string, Array<readonly [number, Watchability]>>()
  let previous: ReadonlyArray<GameSnapshot> = []
  for (let second = 0; second <= seconds; second += 10) {
    const now = DateTime.makeUnsafe(DateTime.toEpochMillis(scenario.origin) + second * 1000)
    const slate = scenario.slateAt(scenario.origin, Duration.seconds(second))
    for (const game of slate) {
      const before = previous.find((candidate) => candidate.id === game.id)
      const last = history.get(game.id)?.at(-1)?.[1]
      const next = before === undefined || last === undefined ? Watchability.initial(game, now) : last.next(before, game, now)
      history.set(game.id, [...(history.get(game.id) ?? []), [second, next] as const])
    }
    previous = slate
  }
  return (id: string, second: number) => history.get(id)?.find(([at]) => at === second)?.[1]
}

describe("watchability through the scenarios", () => {
  it("two-minute-drill-tie: the tied game ranks first until it is final, with no lull before 3:00", () => {
    const at = watched(twoMinuteDrillTie, 240)
    for (let second = 0; second < 220; second += 10) {
      const tie = at("tie-uga-ala", second)
      for (const other of ["tie-osu-mich", "tie-tex-ou", "tie-lsu-miss"])
        assert.isAbove(tie?.score ?? 0, at(other, second)?.score ?? 0, `at ${second}s vs ${other}`)
      if (second < 180) assert.isFalse(tie?.lull, `lull at ${second}s`)
    }
  })

  it("three-red-zones-at-once: at 1:00 the one-score fourth beats the tied third beats the blowout", () => {
    const at = watched(threeRedZonesAtOnce, 60)
    const psu = at("rz-psu-iowa", 60)?.score ?? 0
    const fsu = at("rz-fsu-clem", 60)?.score ?? 0
    const ore = at("rz-ore-wash", 60)?.score ?? 0
    assert.isAbove(psu, fsu)
    assert.isAbove(fsu, ore)
  })

  it("all-lulls-but-one: for two minutes every game but AUB–ARK is in a lull, and AUB–ARK ranks first", () => {
    const at = watched(allLullsButOne, 120)
    for (let second = 0; second <= 120; second += 10) {
      assert.isFalse(at("lull-aub-ark", second)?.lull, `AUB–ARK at ${second}s`)
      for (const other of ["lull-tenn-uk", "lull-wisc-minn", "lull-unc-duke", "lull-hou-rice"]) {
        assert.isTrue(at(other, second)?.lull, `${other} at ${second}s`)
        assert.isAbove(at("lull-aub-ark", second)?.score ?? 0, at(other, second)?.score ?? 0)
      }
    }
  })

  it("blowout-and-upset-brewing: the upset outranks the blowout and says so", () => {
    const at = watched(blowoutAndUpsetBrewing, 330)
    for (let second = 0; second <= 330; second += 10)
      assert.isAbove(at("upset-ala-van", second)?.score ?? 0, at("upset-osu-akr", second)?.score ?? 0)
    assert.include(at("upset-ala-van", 0)?.reasons.join(" | ") ?? "", "upset brewing: VAN leads #3 ALA")
  })

  it("kickoff-window: a game scores 0 until it kicks off", () => {
    const at = watched(kickoffWindow, 130)
    assert.strictEqual(at("ko-mia-unc", 110)?.score, 0)
    assert.isAbove(at("ko-mia-unc", 130)?.score ?? 0, 0)
  })
})
```

- [ ] **Step 2: Run them**

Run: `pnpm vitest run packages/domain/src/scenarios/Scenarios.test.ts`
Expected: PASS. If one fails, print the scores and reasons at the failing second and decide from them: a scenario whose data contradicts its own story (fix the scenario data and say so), or weights that rank wrongly (adjust the named constants in `Watchability.ts`, re-run Task 2's tests, and record before and after numbers in your report). Never loosen an assertion.

- [ ] **Step 3: Check and commit**

Run: `pnpm check`

```bash
git add packages/domain/src/scenarios/Scenarios.test.ts packages/domain/src/Watchability.ts packages/domain/src/scenarios
git commit -m "test(domain): watchability ranks each written scenario as its story says"
```

---

### Task 4: The Watch service, on the wire

**Files:**
- Create: `apps/hub/src/watch/Watch.ts`
- Test: `apps/hub/src/watch/Watch.test.ts`
- Modify: `packages/api/src/LiveMessage.ts`, `apps/hub/src/http/HubServer.ts:102-123`, `apps/hub/src/http/HubServer.test.ts:240-250`, `apps/hub/src/main.ts`, `apps/web/src/hub/Live.ts`, `apps/web/src/hub/Live.test.ts`

**Interfaces:**
- Consumes: `Ingest` (`changes: Stream<ReadonlyArray<GameSnapshot>>`), `Watchability` (Task 2).
- Produces:
  - `class Watch extends Context.Service` with `readonly latest: Effect<{ slate: ReadonlyArray<GameSnapshot>; watchability: ReadonlyArray<Watchability> }>` and `readonly changes: Stream<{ slate; watchability }>` (current value first, like Ingest's), and `static readonly layer: Layer<Watch, never, Ingest>`.
  - `LiveMessage` `SlateChanged { slate, watchability: ReadonlyArray<Watchability> }`.
  - Web `useLive()` state gains `watchability: ReadonlyArray<Watchability>`.

`watchability` holds one entry per game on the slate (a game that is not live scores 0), so the fold needs no special cases; the web shows badges only for live games.

- [ ] **Step 1: Write the failing test**

`apps/hub/src/watch/Watch.test.ts`:

```ts
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Ingest } from "../ingest/Ingest.ts"
import * as ScenarioProvider from "../scenario/ScenarioProvider.ts"
import { Watch } from "./Watch.ts"

const playing = (name: string) =>
  Watch.layer.pipe(
    Layer.provideMerge(Ingest.layer(["fbs", "nfl"])),
    Layer.provide(ScenarioProvider.layer(name)),
    Layer.provide(NodeServices.layer)
  )

describe("Watch", () => {
  it.effect("folds each game's watchability on every slate, and the tied drive leads", () =>
    Effect.gen(function* () {
      const watch = yield* Watch
      yield* TestClock.adjust("2 minutes")
      const { slate, watchability } = yield* watch.latest
      assert.strictEqual(watchability.length, slate.length)
      const [top] = [...watchability].sort((a, b) => b.score - a.score)
      assert.strictEqual(top?.game, "tie-uga-ala")
      assert.include(top?.reasons.join(" | ") ?? "", "red zone")
    }).pipe(Effect.provide(playing("two-minute-drill-tie")))
  )

  it.effect("tells a lull from play on a recorded game day, and ranks a game's red-zone polls above its others", () =>
    Effect.gen(function* () {
      const watch = yield* Watch
      const seen: Array<{ red: boolean; outside: boolean; score: number; lull: boolean; live: boolean; game: string }> = []
      for (let poll = 0; poll < 6 * 20; poll++) {
        yield* TestClock.adjust("10 seconds")
        const { slate, watchability } = yield* watch.latest
        for (const w of watchability) {
          const game = slate.find((g) => g.id === w.game)
          seen.push({
            game: w.game,
            score: w.score,
            lull: w.lull,
            live: game?.status === "live",
            red: game?.situation?.isRedZone === true,
            outside: game?.situation?.inScoringRange() === false
          })
        }
      }
      const live = seen.filter((s) => s.live)
      const lullShare = live.filter((s) => s.lull).length / live.length
      // Logged so the 60-second window can be tuned against real data; a game day is mostly play.
      yield* Effect.logInfo(`recorded-red-zones: ${Math.round(lullShare * 100)}% of live polls in a lull`)
      assert.isBelow(lullShare, 0.5)
      for (const game of new Set(seen.map((s) => s.game))) {
        const mean = (rows: typeof seen) => rows.reduce((t, r) => t + r.score, 0) / Math.max(1, rows.length)
        const red = seen.filter((s) => s.game === game && s.red)
        const outside = seen.filter((s) => s.game === game && s.outside)
        if (red.length > 0 && outside.length > 0) assert.isAbove(mean(red), mean(outside), game)
      }
    }).pipe(Effect.provide(playing("recorded-red-zones")))
  )
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm vitest run apps/hub/src/watch/Watch.test.ts`
Expected: FAIL, cannot find module `./Watch.ts`.

- [ ] **Step 3: Write `Watch.ts`**

```ts
import type { GameSnapshot } from "@sportal/domain/Game"
import { Watchability } from "@sportal/domain/Watchability"
import { Context, DateTime, Effect, Layer, type Stream, SubscriptionRef } from "effect"
import { Ingest } from "../ingest/Ingest.ts"

/**
 * Every game's watchability, folded forward on each slate Ingest publishes, on Ingest's clock: real time on a game
 * day, scenario time in a scenario. The Director reads it; the live stream carries it.
 */
export class Watch extends Context.Service<
  Watch,
  {
    readonly latest: Effect.Effect<{
      readonly slate: ReadonlyArray<GameSnapshot>
      readonly watchability: ReadonlyArray<Watchability>
    }>
    /** The current slate and watchability first, then each new one. */
    readonly changes: Stream.Stream<{
      readonly slate: ReadonlyArray<GameSnapshot>
      readonly watchability: ReadonlyArray<Watchability>
    }>
  }
>()("sportal/hub/Watch") {
  static readonly layer = Layer.effect(
    Watch,
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const state = yield* SubscriptionRef.make({
        slate: [] as ReadonlyArray<GameSnapshot>,
        watchability: [] as ReadonlyArray<Watchability>
      })
      yield* Effect.forkScoped(
        ingest.changes.pipe(
          Stream.runForEach((slate) =>
            DateTime.now.pipe(
              Effect.flatMap((now) =>
                SubscriptionRef.update(state, (current) => ({ slate, watchability: folded(current, slate, now) }))
              )
            )
          )
        ),
        { startImmediately: true }
      )
      return Watch.of({ latest: SubscriptionRef.get(state), changes: SubscriptionRef.changes(state) })
    })
  )
}

/** Each game on the new slate, its watchability carried on from the last slate, or first seen now. */
function folded(
  current: { readonly slate: ReadonlyArray<GameSnapshot>; readonly watchability: ReadonlyArray<Watchability> },
  slate: ReadonlyArray<GameSnapshot>,
  now: DateTime.Utc
): ReadonlyArray<Watchability> {
  return slate.map((game) => {
    const before = current.slate.find((candidate) => candidate.id === game.id)
    const last = current.watchability.find((candidate) => candidate.game === game.id)
    return before === undefined || last === undefined ? Watchability.initial(game, now) : last.next(before, game, now)
  })
}
```

`Stream` is used as a value (`Stream.runForEach`): import it as a value, not `type`. Fix the import if TypeScript complains.

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm vitest run apps/hub/src/watch/Watch.test.ts`
Expected: PASS, with a log line giving the lull share. Record that number in your report. If the lull share is 50% or more, or a game's red-zone mean is not above its outside-the-40 mean, stop and report the numbers (status DONE_WITH_CONCERNS or BLOCKED) rather than tuning silently: the controller decides with the user.

- [ ] **Step 5: Put it on the wire**

`packages/api/src/LiveMessage.ts`:

```ts
import { GameSnapshot } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { Watchability } from "@sportal/domain/Watchability"
import { Schema } from "effect"

/** A message on the live stream at GET /api/live, sent as one JSON object per server-sent event. */
export const LiveMessage = Schema.Union([
  Schema.TaggedStruct("SlateChanged", { slate: Schema.Array(GameSnapshot), watchability: Schema.Array(Watchability) }),
  Schema.TaggedStruct("StageChanged", { stage: Stage })
])
```

`HubServer.ts` `liveRoute`: take `const watch = yield* Watch` instead of `ingest`, and replace the slate stream with `watch.changes.pipe(Stream.map(({ slate, watchability }) => ({ _tag: "SlateChanged" as const, slate, watchability })))`; update the route's doc comment ("the current slate with its watchability and the stage, then every change"). Import `Watch` from `../watch/Watch.ts`.

`HubServer.test.ts` (`hubUnderTest`, around line 249): add `Layer.provideMerge(Watch.layer),` immediately before `Layer.provideMerge(Ingest.layer(["fbs"])),`.

`main.ts`: put `Watch` beside Ingest in both branches, and build the scenario clock once:

```ts
    const live = Layer.mergeAll(
      Watch.layer.pipe(Layer.provideMerge(Ingest.layer(leagues).pipe(Layer.provide(EspnProvider.layer)))),
      YouTubeTv.layer.pipe(Layer.provide(SqlChannelStore.layer))
    )
    const scripted = (name: string) =>
      Layer.mergeAll(
        // One clock for Ingest, the scenario, and Watch, so they share scenario time.
        Watch.layer.pipe(
          Layer.provideMerge(Ingest.layer(leagues).pipe(Layer.provide(ScenarioProvider.layer(name)))),
          Layer.provide(ScenarioClock.layer(speed))
        ),
        ScenarioSource.layer
      )
```

Update the comment above (`Only Ingest and the scenario run on scenario time` → `Only Ingest, Watch, and the scenario run on scenario time`).

`apps/web/src/hub/Live.ts`: add `watchability: [] as ReadonlyArray<Watchability>` to `disconnected` (import the type), and in `reduce`'s `SlateChanged` case return `{ ...live, slate: message.slate, watchability: message.watchability }`. In `Live.test.ts`, the `SlateChanged` message gains `watchability: []` and the test also asserts `next.watchability` is `[]`.

- [ ] **Step 6: Check and commit**

Run: `pnpm vitest run apps/hub apps/web/src/hub` then `pnpm check`.

```bash
git add apps/hub/src/watch packages/api/src/LiveMessage.ts apps/hub/src/http apps/hub/src/main.ts apps/web/src/hub
git commit -m "feat(hub): Watch folds every game's watchability, and the live stream carries it"
```

---

### Task 5: Showing it

**Files:**
- Modify: `apps/web/src/slate/SlateView.tsx` (`SlateView`, `Card`), `apps/web/src/App.tsx:101`, `apps/web/src/scenario/ScenarioStream.tsx`

**Interfaces:**
- Consumes: `useLive().watchability` (Task 4).

- [ ] **Step 1: Strip badge**

`SlateView` gains a prop `watchability: ReadonlyArray<Watchability>` and passes each card `watch={props.watchability.find((w) => w.game === card.id)}`; `App.tsx` passes `watchability={live.watchability}`. In `Card`, for a live game with a watchability, render after the networks (inside the right-hand `span`, before the place tag):

```tsx
            {game.isLive() && props.watch !== undefined && (
              <span
                title={props.watch.reasons.join(" · ") || "Nothing happening"}
                className={`shrink-0 rounded-sm px-1 text-[9px] tabular-nums ${props.watch.lull ? "text-muted-foreground opacity-60" : "bg-live/15 text-live"}`}
              >
                {props.watch.score}
              </span>
            )}
```

`Card`'s props gain `watch: Watchability | undefined`. The card's `title` stays as it is; the badge carries its own.

- [ ] **Step 2: Stream page line**

In `ScenarioStream`, read `watchability` from `useLive()` and pass `watch={watchability.find((w) => w.game === props.game)}` to `Scorebug`; in `Scorebug`, after the last-play paragraph:

```tsx
      {props.watch !== undefined && (
        <p className="px-[4vmin] text-center font-mono text-[3vmin] opacity-80">
          {props.watch.score}
          {props.watch.lull ? " · lull" : ""}
          {props.watch.reasons.length > 0 ? ` · ${props.watch.reasons.join(" · ")}` : ""}
        </p>
      )}
```

- [ ] **Step 3: Look at it**

Build the web UI (`pnpm --filter @sportal/web build`), then run a Hub on a spare port serving it:

```bash
SPORTAL_DATA_DIR=$(mktemp -d) SPORTAL_PORT=4410 SPORTAL_HOST=127.0.0.1 SPORTAL_WEB_ROOT=$PWD/apps/web/dist SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_SCENARIO_SPEED=2 timeout 120 node apps/hub/src/main.ts
```

and check `curl -s http://127.0.0.1:4410/api/live --max-time 2` shows `watchability` with `tie-uga-ala` highest. A screenshot is optional (headless Chromium's `--screenshot` fires before the live stream delivers; a DevTools-protocol script that waits 5 s works). Stop the Hub (kill only the PID listening on 4410) before finishing. Never use ports 4400/4401.

- [ ] **Step 4: Check and commit**

Run: `pnpm check`

```bash
git add apps/web/src/slate/SlateView.tsx apps/web/src/App.tsx apps/web/src/scenario/ScenarioStream.tsx
git commit -m "feat(web): live strip cards and scenario streams show watchability and its reasons"
```

- [ ] **Step 5: Game-day row**

Append to `docs/game-day-checklist.md` after row 35:

```markdown
| 36 | During a live window, hover the score badges on the strip | Live games carry a score; the closest late game is highest; a game at halftime or in a TV break shows its badge dimmed; the tooltip gives reasons that match the game |
```

Commit: `docs: game-day row for watchability on the strip`.
