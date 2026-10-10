# Break Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The classifier calls a stopped live game a `Break` sooner and from more signals (media-timeout spots, play text, a quiet feed), says roughly when it will be back, and keeps what was at stake.

**Architecture:** All in the pure domain fold plus the web badge. `Play` learns which plays change possession and which mention an injury or a review. `Moment` grows `BreakReason` to ten reasons with a typical length each, and `Break` carries `expectedEnd` and `during`; Break moves above ScoringThreat and CrunchTime. `Classifier` keeps when each game last got a play, so a stall shows up through the existing `nextExpiry` timer; the Hub needs no change.

**Tech Stack:** TypeScript 7 (tsgo), Effect 4 (`Schema`, `DateTime`, `Duration`, `Option`), `@effect/vitest`, React 19.

**Spec:** `docs/specs/2026-10-10-break-detection-design.md`.

## Global Constraints

- Inferred from the data, never the video; ESPN's play `wallclock` is not decoded.
- Precedence for live games: BigPlay → Break → ScoringThreat → CrunchTime → Live, then Upcoming, Final.
- Stall: no new play for 90 s (`Classifier.stallAfter`), measured by arrival (`now` of the take), not feed time.
- Leaving a `Break` never waits the 20 s `momentHold`.
- Score unchanged: the `Break` moment bonus stays −0.20.
- Typical lengths (NFL / college): halftime 13:00 / 20:00, delay 10:00, periodEnd 2:00, twoMinuteWarning 2:15, timeout 1:00, review 2:30, injury 2:00, afterScore 2:15, afterKickoff 2:00, possessionChange 2:00, stall 1:30.
- Text words, case-insensitive: injury "injur", "shaken up"; review "challenge", "review", "replay".
- Tests: one thing per test, "should …" descriptions, arrange / act / assert; ranking-style statements, never raw scores.
- Comments: doc comments on exports; inline comments only for an unclear why. Match the surrounding prose style.
- `exactOptionalPropertyTypes` is on: build optional fields with a conditional spread.
- Run `pnpm check` (biome, typecheck, structure, tests) green before each commit.

## Setup (before Task 1)

Work in a worktree on branch `break-detection`:

```bash
cd /home/chazzy/development/projects/sportal
git worktree add ../sportal-break-detection -b break-detection
cp docs/specs/2026-10-10-break-detection-design.md ../sportal-break-detection/docs/specs/
cp docs/plans/2026-10-10-break-detection.md ../sportal-break-detection/docs/plans/
cd ../sportal-break-detection && pnpm install
git add docs/specs/2026-10-10-break-detection-design.md docs/plans/2026-10-10-break-detection.md
git commit -m "docs: break detection design and plan"
```

Then remove the two untracked copies from the main checkout (`rm` them there) so the merge does not collide.

## File Structure

- `packages/domain/src/Play.ts`: `Play.changesPossession`, `Play.stopInText`, `StopInText`.
- `packages/domain/src/Moment.ts`: ten `BreakReason`s with `BreakReason.typicalLength`, `Stakes`, the `Break` case's `expectedEnd` and `during`, the new precedence.
- `packages/domain/src/Classifier.ts`: `lastPlayAt`, the stall deadline, `momentOf` reordered, `breakReason` with the new reasons, `settled` letting go of a break at once and keeping a break's `expectedEnd`.
- `apps/web/src/game/MomentBadge.tsx`: `BRK · RZ`, the reason and "back about" in the title.
- `CONTEXT.md`: glossary rows.

---

### Task 1: Plays that change possession or name a stop

**Files:**
- Modify: `packages/domain/src/Play.ts` (the `FootballPlay` object near line 170, new functions after `bigPlay`)
- Test: `packages/domain/src/Play.test.ts` (two new `describe` blocks at the end)

**Interfaces:**
- Produces:
  - `Play.changesPossession(play: Play): boolean`
  - `Play.stopInText(play: Play): Option.Option<StopInText>`
  - `export type StopInText = "injury" | "review"` (also `export const StopInText = Schema.Literals(["injury", "review"])`)

- [ ] **Step 1: Write the failing tests**

Append to `packages/domain/src/Play.test.ts` (it already imports `Punt`, `Interception`, `Sack`, `Fumble`, `FieldGoal`, `Incompletion`, `Rush`, `Option`, `fields`, `home`):

```ts
describe("FootballPlay.changesPossession", () => {
  it.each([
    ["a punt", new Punt({ ...fields, team: home, yards: 40, return: "none" })],
    ["an interception", new Interception({ ...fields, team: home, yards: 0, return: "none" })],
    ["a sack the defense recovers a fumble from", new Sack({ ...fields, team: home, yards: -7, fumbleLost: true })],
    ["a fumble the other side recovers", new Fumble({ ...fields, team: home, yards: 3, recovery: "opponent" })],
    ["a missed field goal", new FieldGoal({ ...fields, team: home, yards: 0, result: "missed" })],
    ["a blocked field goal", new FieldGoal({ ...fields, team: home, yards: 0, result: "blocked" })],
    [
      "a fourth-down run short of the line to gain",
      new Rush({ ...fields, start: { ...fields.start, down: 4, distance: 2 }, team: home, yards: 1, touchdown: false })
    ],
    [
      "a fourth-down incompletion",
      new Incompletion({ ...fields, start: { ...fields.start, down: 4, distance: 5 }, team: home, yards: 0 })
    ]
  ])("should say %s changes possession", (_, given) => {
    const changes = Play.changesPossession(given)

    assert.isTrue(changes)
  })

  it.each([
    ["a first-down run", play()],
    ["a good field goal", new FieldGoal({ ...fields, team: home, yards: 0, result: "good" })],
    ["a fumble its own side recovers", new Fumble({ ...fields, team: home, yards: 3, recovery: "own" })],
    [
      "a fourth-down run that gains the line to gain",
      new Rush({ ...fields, start: { ...fields.start, down: 4, distance: 2 }, team: home, yards: 3, touchdown: false })
    ]
  ])("should say %s keeps possession", (_, given) => {
    const changes = Play.changesPossession(given)

    assert.isFalse(changes)
  })
})

describe("FootballPlay.stopInText", () => {
  it.each([
    ["Smith rush for 3 yards. Jones was injured during the play.", "injury"],
    ["Pass complete for 8 yards. Brown was shaken up on the play.", "injury"],
    ["The ruling on the field was challenged by DAL.", "review"],
    ["The play is under review.", "review"],
    ["After further REPLAY, the ruling stands.", "review"]
  ] as const)("should find %j a stop for %s", (text, stop) => {
    const found = Play.stopInText(play({ text }))

    assert.deepStrictEqual(found, Option.some(stop))
  })

  it("should find no stop in a play that names none", () => {
    const found = Play.stopInText(play({ text: "Smith rush for 3 yards" }))

    assert.isTrue(Option.isNone(found))
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run packages/domain/src/Play.test.ts`
Expected: FAIL, `Play.changesPossession is not a function` / `Play.stopInText is not a function`.

- [ ] **Step 3: Implement**

In `packages/domain/src/Play.ts`, after `BigPlayKind`:

```ts
/** A stop a play's text names: see `FootballPlay.stopInText`. */
export const StopInText = Schema.Literals(["injury", "review"])
export type StopInText = typeof StopInText.Type
```

Add both to the `FootballPlay` object and its doc comment's list:

```ts
export const FootballPlay = Object.assign(cases, {
  /** By `sequence`. */
  order: Order.mapInput(Order.Number, (play: typeof cases.Type) => play.sequence),
  gainsYards,
  offense,
  lostYards,
  bigPlay,
  changesPossession,
  stopInText
})
```

After `bigPlay` (before the constants at the bottom):

```ts
/**
 * Whether the ball goes to the other team after `play`: a punt, a turnover, a field goal missed or blocked, or a
 * fourth-down snap short of the line to gain. A touchdown or a good kick changes it by a kickoff instead.
 */
function changesPossession(play: typeof cases.Type): boolean {
  const shortOnFourth = (yards: number) =>
    play.start.down === 4 && play.start.distance !== undefined && yards < play.start.distance

  return cases.match(play, {
    Rush: ({ touchdown, yards }) => !touchdown && shortOnFourth(yards),
    Completion: ({ touchdown, yards }) => !touchdown && shortOnFourth(yards),
    Incompletion: ({ yards }) => shortOnFourth(yards),
    Interception: () => true,
    Sack: ({ fumbleLost, yards }) => fumbleLost || shortOnFourth(yards),
    Fumble: ({ recovery }) => recovery === "opponent",
    TwoPointTry: () => false,
    Kickoff: () => false,
    Punt: () => true,
    FieldGoal: ({ result }) => result !== "good",
    ExtraPoint: () => false,
    Safety: () => false,
    Penalty: () => false,
    Timeout: () => false,
    Stoppage: () => false,
    PeriodEnd: () => false,
    Other: () => false
  })
}

/** The stop `play`'s text names, if it names one: a player hurt, or a challenge or review. */
function stopInText(play: typeof cases.Type): Option.Option<StopInText> {
  const text = play.text.toLowerCase()
  const found = (Object.keys(stopWords) as ReadonlyArray<StopInText>).find((stop) =>
    stopWords[stop].some((word) => text.includes(word))
  )
  return Option.fromUndefinedOr(found)
}
```

With the constants at the bottom:

```ts
/** The words, lower case, that name each stop in a play's text. */
const stopWords: Record<StopInText, ReadonlyArray<string>> = {
  injury: ["injur", "shaken up"],
  review: ["challenge", "review", "replay"]
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run packages/domain/src/Play.test.ts`
Expected: PASS.

- [ ] **Step 5: Glossary, check, commit**

In `CONTEXT.md`, after the **Big play** row, add:

```md
| **Possession change** | A play after which the other team has the ball: a punt, a turnover, a field goal missed or blocked, or a fourth-down snap short of the line to gain; `FootballPlay.changesPossession`. | turnover |
```

Run: `pnpm check`
Expected: all green.

```bash
git add packages/domain/src/Play.ts packages/domain/src/Play.test.ts CONTEXT.md
git commit -m "feat(domain): plays that change possession, and stops a play's text names"
```

---

### Task 2: Break moments: ten reasons, an expected end, the stakes, a stall

**Files:**
- Modify: `packages/domain/src/Moment.ts` (whole file)
- Modify: `packages/domain/src/Classifier.ts` (`Classifier` statics, `Followed`, `followed`, `momentOf`, `breakReason`, `settled`)
- Modify: `packages/domain/src/Moment.test.ts`, `packages/domain/src/Classifier.test.ts`, `packages/domain/src/Classification.test.ts:75`
- Modify: `CONTEXT.md` (the **Moment** and **Break** rows, new **Stall** and **Double dip** rows)

**Interfaces:**
- Consumes: `Play.changesPossession`, `Play.stopInText` (Task 1).
- Produces:
  - `BreakReason` literals `"halftime" | "delay" | "periodEnd" | "twoMinuteWarning" | "timeout" | "review" | "injury" | "afterScore" | "afterKickoff" | "possessionChange" | "stall"` and `BreakReason.typicalLength(reason: BreakReason, league: LeagueId): Duration.Duration`
  - `Stakes`: tagged union of `ScoringThreat { team: TeamId, yardsToGo: Int }` and `CrunchTime { margin: Int, secondsLeft: Int }`
  - `Moment` case `Break { reason: BreakReason, expectedEnd: DateTime.Utc (encoded as an ISO string), during?: Stakes }`
  - `Classifier.stallAfter: Duration.Duration` (90 s)

- [ ] **Step 1: Write the failing tests**

`packages/domain/src/Moment.test.ts`: replace the test body (the moment list needs `expectedEnd`, the order changes):

```ts
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration } from "effect"
import { BreakReason, Moment } from "./Moment.ts"
import { PlayId } from "./Play.ts"
import { team } from "./TestGame.ts"

describe("Moment.precedence", () => {
  it("should put a big play before a break, a scoring threat, crunch time, and live play, in that order", () => {
    const moments: ReadonlyArray<Moment> = [
      { _tag: "Live" },
      { _tag: "CrunchTime", margin: 3, secondsLeft: 100 },
      { _tag: "ScoringThreat", team: team("HOME").id, yardsToGo: 8 },
      { _tag: "Break", reason: "timeout", expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z") },
      { _tag: "BigPlay", play: PlayId.make("1"), kind: "sack" }
    ]

    const ordered = moments.toSorted(Moment.precedence).map(({ _tag }) => _tag)

    assert.deepStrictEqual(ordered, ["BigPlay", "Break", "ScoringThreat", "CrunchTime", "Live"])
  })
})

describe("BreakReason.typicalLength", () => {
  it("should give a college halftime longer than an NFL one", () => {
    const [college, nfl] = [BreakReason.typicalLength("halftime", "fbs"), BreakReason.typicalLength("halftime", "nfl")]

    assert.isTrue(Duration.isGreaterThan(college, nfl))
  })

  it("should give a team timeout less time than a media break after a change of possession", () => {
    const [timeout, media] = [
      BreakReason.typicalLength("timeout", "nfl"),
      BreakReason.typicalLength("possessionChange", "nfl")
    ]

    assert.isTrue(Duration.isLessThan(timeout, media))
  })
})
```

`packages/domain/src/Classification.test.ts:75`: the break moment needs its end. Replace

```ts
    const resting = scoreOf(game, { moment: { _tag: "Break", reason: "timeout" } })
```

with

```ts
    const resting = scoreOf(game, {
      moment: { _tag: "Break", reason: "timeout", expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z") }
    })
```

(add `DateTime` to its `effect` import if it is not there).

`packages/domain/src/Classifier.test.ts`:

Add to the imports: `type Classification` from `./Classification.ts`; `Punt`, `Stoppage` from `./Play.ts`.

Replace the four `assert.deepStrictEqual(classified.get(id)?.moment, { _tag: "Break", reason: … })` lines (timeout, two afterScore, periodEnd) with `assert.strictEqual(reasonOf(classified), "<reason>")`, keeping each test's reason.

Add these tests to `describe("Classifier#step, moments", …)`, after the end-of-period test:

```ts
  it("should call a game a break after the two-minute warning", () => {
    const warning = new Stoppage({ ...playFields, kind: "twoMinuteWarning" })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [warning]), [], at)

    assert.strictEqual(reasonOf(classified), "twoMinuteWarning")
  })

  it("should call a game a break after a punt", () => {
    const punt = new Punt({ ...playFields, team: home, yards: 40, return: "none" })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [punt]), [], at)

    assert.strictEqual(reasonOf(classified), "possessionChange")
  })

  it("should end a break when the next snap arrives", () => {
    const punt = new Punt({ ...playFields, team: home, yards: 40, return: "none" })
    const snap = play({ id: playId(2), sequence: 2 })
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [punt]), [], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [punt, snap]), [played(snap)], later(5))

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should call a game a break after the kickoff that follows a score", () => {
    const touchdown = play({ yards: 2, touchdown: true, scoring: true })
    const kickoff = new Kickoff({ ...playFields, id: playId(2), sequence: 2, yards: 40, returnTouchdown: false })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [touchdown, kickoff]), [], at)

    assert.strictEqual(reasonOf(classified), "afterKickoff")
  })

  it("should call the opening kickoff live play", () => {
    const kickoff = new Kickoff({ ...playFields, yards: 40, returnTouchdown: false })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [kickoff]), [], at)

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should call a game a break after a play a player was hurt on", () => {
    const hurt = play({ text: "Smith rush for 3 yards. Jones was injured during the play." })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [hurt]), [], at)

    assert.strictEqual(reasonOf(classified), "injury")
  })

  it("should call a timeout in the red zone a break during a scoring threat", () => {
    const [, classified] = Classifier.empty.step(
      slateOf(liveSnapshot({ id, situation: situation({ yardLine: 15 }) }), [timeout()]),
      [],
      at
    )

    const moment = classified.get(id)?.moment
    assert.strictEqual(moment?._tag === "Break" ? moment.during?._tag : undefined, "ScoringThreat")
  })

  it("should put a touchdown's big play before the break after the score", () => {
    const touchdown = play({ yards: 2, touchdown: true, scoring: true })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [touchdown]), [played(touchdown)], at)

    assert.strictEqual(classified.get(id)?.moment._tag, "BigPlay")
  })

  it("should expect a break back after its reason's typical length for the game's league", () => {
    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id, league: "nfl" }), [timeout()]), [], at)

    const moment = classified.get(id)?.moment
    const expected = DateTime.addDuration(at, BreakReason.typicalLength("timeout", "nfl"))
    assert.isTrue(moment?._tag === "Break" && DateTime.Equivalence(moment.expectedEnd, expected))
  })
```

Add a new `describe` after it:

```ts
describe("Classifier#step, a stall", () => {
  it("should call a game a break when no play has arrived for ninety seconds", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [play()]), [played(play())], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [play()]), [], later(90))

    assert.strictEqual(reasonOf(classified), "stall")
  })

  it("should not call a game stalled at eighty-nine seconds", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [play()]), [played(play())], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [play()]), [], later(89))

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })
})
```

In `describe("Classifier#step, holding a moment", …)` add:

```ts
  it("should leave a break at once when play resumes", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [timeout()]), [], at)
    const snap = play({ id: playId(2), sequence: 2 })

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [timeout(), snap]), [played(snap)], later(1))

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should keep a break's expected end while it holds", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [timeout()]), [], at)
    const expected = DateTime.addDuration(at, BreakReason.typicalLength("timeout", "fbs"))

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [timeout()]), [], later(30))

    const moment = classified.get(id)?.moment
    assert.isTrue(moment?._tag === "Break" && DateTime.Equivalence(moment.expectedEnd, expected))
  })
```

In `describe("Classifier#nextExpiry", …)` replace "should be none with nothing held" (a live game now always has a stall deadline) with:

```ts
  it("should be none for a game not yet live", () => {
    const [classifier] = Classifier.empty.step(slateOf(snapshot({ id })), [], at)

    assert.isTrue(Option.isNone(classifier.nextExpiry()))
  })

  it("should be when a live game with no new play would stall", () => {
    const [classifier] = Classifier.empty.step(slateOf(liveSnapshot({ id })), [], at)

    assert.deepStrictEqual(classifier.nextExpiry(), Option.some(later(90)))
  })
```

At the bottom, with the other helpers (and import `BreakReason` from `./Moment.ts`, `team` from `./TestGame.ts`):

```ts
const home = team("HOME").id

/** Game `id`'s break reason, if it is in a break. */
function reasonOf(classified: ReadonlyMap<GameId, Classification>) {
  const moment = classified.get(id)?.moment
  return moment?._tag === "Break" ? moment.reason : undefined
}
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run packages/domain/src`
Expected: FAIL: type errors on `expectedEnd`, `BreakReason.typicalLength` undefined, the new reasons missing.

- [ ] **Step 3: Implement `Moment.ts`**

Replace `packages/domain/src/Moment.ts` with:

```ts
import { Duration, Order, Schema } from "effect"
import type { LeagueId } from "./League.ts"
import { BigPlayKind, PlayId } from "./Play.ts"
import { TeamId } from "./Team.ts"

const reasons = Schema.Literals([
  "halftime",
  "delay",
  "periodEnd",
  "twoMinuteWarning",
  "timeout",
  "review",
  "injury",
  "afterScore",
  "afterKickoff",
  "possessionChange",
  "stall"
])

/** Why a live game has stopped, with how long each kind of stop typically lasts. */
export const BreakReason = Object.assign(reasons, {
  /** How long a break for `reason` typically lasts in `league`: a guess, tuned on game days. */
  typicalLength: (reason: typeof reasons.Type, league: LeagueId): Duration.Duration =>
    Duration.seconds(reason === "halftime" && league === "fbs" ? collegeHalftime : typicalSeconds[reason])
})
export type BreakReason = typeof reasons.Type

const typicalSeconds = {
  halftime: 13 * 60,
  delay: 10 * 60,
  periodEnd: 120,
  twoMinuteWarning: 135,
  timeout: 60,
  review: 150,
  injury: 120,
  afterScore: 135,
  afterKickoff: 120,
  possessionChange: 120,
  stall: 90
} satisfies Record<BreakReason, number>

const collegeHalftime = 20 * 60

const ScoringThreat = { team: TeamId, yardsToGo: Schema.Int }
const CrunchTime = { margin: Schema.Int, secondsLeft: Schema.Int }

/** What was at stake when a game stopped: a scoring threat or crunch time. */
export const Stakes = Schema.TaggedUnion({ ScoringThreat, CrunchTime })
export type Stakes = typeof Stakes.Type

const cases = Schema.TaggedUnion({
  /** The team with the ball is in the red zone. */
  ScoringThreat,
  /** The fourth quarter's last five minutes, or overtime, within one score. */
  CrunchTime,
  /** A big play, for a while after it. */
  BigPlay: { play: PlayId, kind: BigPlayKind },
  Live: {},
  /** A live game stopped, when it is likely back, and what was at stake when it stopped. */
  Break: { reason: reasons, expectedEnd: Schema.DateTimeUtcFromString, during: Schema.optional(Stakes) },
  Upcoming: {},
  Final: {}
})

/**
 * What kind of thing is happening in a game now: one case per game, the one highest in `precedence` of those that
 * hold, with what commentary and prompts need of it.
 */
export const Moment = Object.assign(cases, {
  /** Higher precedence first: a big play, a break, a scoring threat, crunch time, live play, then not live. */
  precedence: Order.mapInput(Order.Number, (moment: typeof cases.Type) => rank[moment._tag])
})
export type Moment = typeof cases.Type

const rank = {
  BigPlay: 0,
  Break: 1,
  ScoringThreat: 2,
  CrunchTime: 3,
  Live: 4,
  Upcoming: 5,
  Final: 6
} satisfies Record<Moment["_tag"], number>
```

If `Schema.TaggedUnion` rejects a field record shared between two unions, inline the fields in both places instead; the case types stay the same.

- [ ] **Step 4: Implement `Classifier.ts`**

Imports: add `Stakes` to the `./Moment.ts` import and `GameSnapshot` to the `./Game.ts` type import.

Statics, after `momentHold`:

```ts
  /** How long a live game goes without a new play before it counts as stopped. */
  static readonly stallAfter = Duration.seconds(90)
```

Update the class doc comment's list of what it keeps: "…a big play while it lasts, when each game last got a play, and the moment shown and since when…".

`Followed` gains:

```ts
  readonly lastPlayAt: DateTime.Utc
```

`followed` becomes:

```ts
function followed(
  had: Followed | undefined,
  game: Game,
  plays: ReadonlyArray<Play>,
  now: DateTime.Utc
): Followed {
  const { snapshot } = game
  const odds = snapshot.odds ?? had?.odds
  const lasting =
    had?.bigPlay !== undefined && DateTime.isLessThan(now, had.bigPlay.until) ? had.bigPlay : undefined
  const bigPlay = latestBigPlay(plays, now) ?? lasting
  const lastPlayAt = plays.length > 0 || had === undefined ? now : had.lastPlayAt
  const stallAt = DateTime.addDuration(lastPlayAt, Classifier.stallAfter)
  const [moment, since, heldBack] = settled(
    had?.classification,
    momentOf(game, bigPlay, stallAt, now),
    now
  )

  const winProbabilities = game.plays
    .flatMap(({ homeWinProbability }) => (homeWinProbability === undefined ? [] : [homeWinProbability]))
    .slice(-swingPlays)
  const classification = Classification.of({ snapshot, odds, winProbabilities }, moment, since)
  const held = heldBack ? DateTime.addDuration(since, Classifier.momentHold) : undefined
  const stalling = snapshot.progress() === "live" && DateTime.isLessThan(now, stallAt) ? stallAt : undefined
  const expiry = Option.getOrUndefined(earliest([bigPlay?.until, held, stalling]))
  return { odds, bigPlay, lastPlayAt, classification, expiry }
}
```

`momentOf` and `breakReason` become:

```ts
/** The highest moment that holds of `game` at `now`, which stalls at `stallAt` without a new play. */
function momentOf(game: Game, bigPlay: Followed["bigPlay"], stallAt: DateTime.Utc, now: DateTime.Utc): Moment {
  const { snapshot } = game
  const progress = snapshot.progress()
  if (progress === "upcoming") return { _tag: "Upcoming" }
  if (progress === "over") return { _tag: "Final" }
  if (bigPlay !== undefined) return { _tag: "BigPlay", play: bigPlay.play, kind: bigPlay.kind }

  const stakes = stakesOf(snapshot)
  const reason = breakReason(game, DateTime.isGreaterThanOrEqualTo(now, stallAt))
  if (reason === undefined) return stakes ?? { _tag: "Live" }
  const expectedEnd = DateTime.addDuration(now, BreakReason.typicalLength(reason, snapshot.league))
  return { _tag: "Break", reason, expectedEnd, ...(stakes === undefined ? {} : { during: stakes }) }
}

/** What is at stake in `snapshot`: the team with the ball in the red zone, else crunch time. */
function stakesOf(snapshot: GameSnapshot): Stakes | undefined {
  const { situation } = snapshot
  if (situation?.possession !== undefined && situation.yardLine !== undefined && situation.inRedZone())
    return { _tag: "ScoringThreat", team: situation.possession, yardsToGo: situation.yardLine }
  if (snapshot.inCrunchTime())
    return { _tag: "CrunchTime", margin: snapshot.margin(), secondsLeft: snapshot.secondsLeft() }
  return undefined
}

/**
 * Why a live game has stopped, if it has, the first that holds: halftime, a delay, its period ended, the two-minute
 * warning, a timeout, a review or an injury its latest play names, a score not yet kicked off from, the kickoff after
 * a score, a change of possession, or no new play for a while (`stalled`).
 */
function breakReason(game: Game, stalled: boolean): BreakReason | undefined {
  const { snapshot, plays } = game
  if (snapshot.status === "halftime") return "halftime"
  if (snapshot.status === "delayed") return "delay"
  const last = plays.at(-1)
  if (!snapshot.inPlay() || (last !== undefined && Play.guards.PeriodEnd(last))) return "periodEnd"
  if (last === undefined) return stalled ? "stall" : undefined
  if (Play.guards.Stoppage(last) && last.kind === "twoMinuteWarning") return "twoMinuteWarning"
  if (Play.guards.Timeout(last) || (Play.guards.Stoppage(last) && last.kind === "officialTimeout")) return "timeout"
  const stop = Option.getOrUndefined(Play.stopInText(last))
  if (stop !== undefined) return stop

  const scored = plays.findLastIndex(({ scoring }) => scoring)
  const kickedOff = plays.findLastIndex((play) => Play.guards.Kickoff(play))
  if (scored !== -1 && kickedOff <= scored) return "afterScore"
  if (Play.guards.Kickoff(last)) {
    const kickedOffBefore = plays.slice(0, -1).findLastIndex((play) => Play.guards.Kickoff(play))
    if (scored > kickedOffBefore) return "afterKickoff"
  }
  if (Play.changesPossession(last)) return "possessionChange"
  return stalled ? "stall" : undefined
}
```

`BreakReason` is now used as a value: change the import to `import { BreakReason, Moment, type Stakes } from "./Moment.ts"`.

`settled` becomes (doc comment updated):

```ts
/**
 * The moment to show, since when, and whether `candidate` was held back: the moment held, while it is the same kind or
 * outranks `candidate` and has held less than `momentHold`; otherwise `candidate`, from `now`. Leaving a break or
 * going not live never waits. A break for the same reason keeps its expected end; a new reason is a new break.
 */
function settled(
  had: Classification | undefined,
  candidate: Moment,
  now: DateTime.Utc
): readonly [Moment, DateTime.Utc, boolean] {
  if (had === undefined) return [candidate, now, false]
  const { moment } = had
  if (moment._tag === "Break" && candidate._tag === "Break")
    return moment.reason === candidate.reason
      ? [{ ...candidate, expectedEnd: moment.expectedEnd }, had.since, false]
      : [candidate, now, false]
  if (moment._tag === candidate._tag) return [candidate, had.since, false]

  const lower = Moment.precedence(candidate, moment) > 0
  const free = candidate._tag === "Upcoming" || candidate._tag === "Final" || moment._tag === "Break"
  const holding = DateTime.isLessThan(now, DateTime.addDuration(had.since, Classifier.momentHold))
  return lower && !free && holding ? [moment, had.since, true] : [candidate, now, false]
}
```

- [ ] **Step 5: Run the domain tests**

Run: `pnpm vitest run packages/domain/src`
Expected: PASS. If an older test in `Classifier.test.ts` now fails, read why before changing it: the only intended behaviour changes are the new precedence, the stall deadline in `nextExpiry`, and `expectedEnd`/`during` on breaks.

- [ ] **Step 6: Glossary**

In `CONTEXT.md`, replace the **Moment** and **Break** rows and add two rows after **Break**:

```md
| **Moment** | What kind of thing is happening in a game now — a big play, a break, a scoring threat (red zone), crunch time, live play, upcoming, or final — one per game, the highest in precedence of those that hold, in that order; `Moment` in `packages/domain/src/Moment.ts`. | event, state |
| **Break** | A live game stopped: halftime, a delay, the end of a period, the two-minute warning, a timeout, a review or an injury its latest play names, the gap from a score to the next kickoff, the kickoff after a score (the double dip), a possession change, or a stall; the `Break` moment, with its `BreakReason`, when it is likely back (`expectedEnd`, from the reason's typical length), and what was at stake when it stopped (`during`). Inferred from the data, never the video. | commercial, lull |
| **Stall** | A live game in play with no new play for 90 s, by when plays reach the Hub; a break of last resort. | lull |
| **Double dip** | The break after the kickoff that follows a score, the second of the two the score brings. | |
```

- [ ] **Step 7: Check and commit**

Run: `pnpm check`
Expected: all green (the Hub's `Director` only reads `moment._tag`; the web badge matches on tags and still compiles).

```bash
git add packages/domain/src CONTEXT.md
git commit -m "feat(domain): breaks from more signals, with an expected end and the stakes, above the red zone"
```

---

### Task 3: The badge shows the stakes, the reason, and when it is likely back

**Files:**
- Modify: `apps/web/src/game/MomentBadge.tsx`
- Create: `apps/web/src/game/MomentBadge.test.ts`

**Interfaces:**
- Consumes: `Moment` `Break { reason, expectedEnd, during? }`, `BreakReason` (Task 2); `localTime(at: DateTime.Utc): string` from `apps/web/src/game/GameStatus.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/game/MomentBadge.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Classification } from "@sportal/domain/Classification"
import type { Moment } from "@sportal/domain/Moment"
import { liveSnapshot, team } from "@sportal/domain/TestGame"
import { DateTime } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { localTime } from "./GameStatus.tsx"
import { MomentBadge } from "./MomentBadge.tsx"

describe("MomentBadge", () => {
  it("should mark a break in the red zone BRK · RZ", () => {
    const markup = badgeOf({
      _tag: "Break",
      reason: "timeout",
      expectedEnd,
      during: { _tag: "ScoringThreat", team: team("HOME").id, yardsToGo: 8 }
    })

    assert.include(markup.replace(/<[^>]*>/g, ""), "BRK · RZ")
  })

  it("should title a break with its reason and when it is likely back", () => {
    const markup = badgeOf({ _tag: "Break", reason: "possessionChange", expectedEnd })

    assert.include(markup, `change of possession, back about ${localTime(expectedEnd)}`)
  })
})

const expectedEnd = DateTime.makeUnsafe("2026-10-10T20:02:00Z")

/** The markup `MomentBadge` renders for a live game in `moment`. */
function badgeOf(moment: Moment): string {
  const classification = Classification.of(
    { snapshot: liveSnapshot(), odds: undefined, winProbabilities: [] },
    moment,
    DateTime.makeUnsafe("2026-10-10T20:00:00Z")
  )
  return renderToStaticMarkup(createElement(MomentBadge, { classification }))
}
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run apps/web/src/game/MomentBadge.test.ts`
Expected: FAIL: no "BRK · RZ", no reason in the title.

- [ ] **Step 3: Implement**

In `apps/web/src/game/MomentBadge.tsx`:

Imports: add `import type { BreakReason } from "@sportal/domain/Moment"` (merge with the existing `Moment` import) and `import { localTime } from "./GameStatus.tsx"`.

Update the doc comment: "…BRK in a break, with what was at stake — titled with its score, the points each part gave it, and for a break its reason and when it is likely back."

Build the title with the break's part:

```ts
  const { prior, closeness, swing, upset, momentBonus } = classification.breakdown
  const { moment } = classification
  const stopped = moment._tag === "Break" ? ` — ${reasonText[moment.reason]}, back about ${localTime(moment.expectedEnd)}` : ""
  const title = `Score ${classification.score}: matchup ${points(prior)}, closeness ${points(closeness)}, swing ${points(swing)}, upset ${points(upset)}, moment ${points(momentBonus)}${stopped}`
```

The Break mark:

```tsx
    Break: ({ during }) => (
      <span className="label-caps text-[9px] text-muted-foreground">
        {during === undefined ? "BRK" : `BRK · ${during._tag === "ScoringThreat" ? "RZ" : "CT"}`}
      </span>
    ),
```

After `points`:

```ts
const reasonText: Record<BreakReason, string> = {
  halftime: "halftime",
  delay: "delay",
  periodEnd: "end of the quarter",
  twoMinuteWarning: "two-minute warning",
  timeout: "timeout",
  review: "review",
  injury: "injury",
  afterScore: "after the score",
  afterKickoff: "after the kickoff",
  possessionChange: "change of possession",
  stall: "no play for a while"
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run apps/web/src/game/MomentBadge.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

Run: `pnpm check`
Expected: all green.

```bash
git add apps/web/src/game/MomentBadge.tsx apps/web/src/game/MomentBadge.test.ts
git commit -m "feat(web): a break's badge shows what was at stake, and its title the reason and when it is likely back"
```

---

## After the tasks

- Final review of the branch against the spec, then merge to `main` with `--no-ff` ("Merge branch 'break-detection': …"), remove the worktree and branch.
- Open after merge: the live eye-check on a game day (the user runs `pnpm dev`): do punts, injuries and stalls show as breaks, and are the "back about" times plausible?
