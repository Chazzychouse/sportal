# Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Hub classifies every listed game's moment and scores how worth watching it is, publishes that beside the
slate, and Displays sort their Live strip by it and badge each game.

**Architecture:** Pure domain first: new feed data on `GameSnapshot` (records, odds), `Play.bigPlay`, the `Moment` wire
union, `Classification.of` (the scoring), and the `Classifier` fold (moments, hysteresis, expiry). The Director runs
the fold after each take and on a timer at its next expiry, and offers `classifications` beside `slate`. Broadcast
joins them into `SlateChanged`; the web keeps them in its live state, orders the strip and draws a `MomentBadge`.

**Tech Stack:** Effect 4 (`Schema`, `Data`, `Stream`, `SubscriptionRef`, `Semaphore`), `@effect/vitest`, React +
`@effect/atom-react`, lucide-react.

Spec: `docs/specs/2026-10-10-classification-design.md`.

## Global Constraints

- Read `AGENTS.md` first. Every rule there applies: module shapes, order inside a file, one `yield*` per line, no
  `any`/casts/non-null assertions, `Effect.fn("Module.f")`, tests `it("should …")` with Arrange/Act/Assert separated by
  blank lines, one behaviour per test.
- Effect 4 is newer than training data: check `node_modules/effect/ai-docs/src/` before writing an API you are unsure
  of. APIs this plan relies on were checked in `effect@4.0.0`: `Semaphore.make(1)` / `semaphore.withPermits(1)`,
  `Stream.switchMap`, `Stream.never`, `DateTime.distance` (returns a `Duration`), `DateTime.addDuration`,
  `DateTime.isLessThan`, `DateTime.Order`, `Duration.max`, `Option.fromUndefinedOr`.
- Every exported type name is a `CONTEXT.md` term; each task adds its glossary rows in its own commit.
- `pnpm check` must pass before every commit.
- Work happens on branch `classification` in the worktree `../sportal-classification`
  (`git worktree add ../sportal-classification -b classification`, then `pnpm install` there).
- Constants from the spec, verbatim: moment hold 20 s; big play hold 60 s; crunch time = 4th quarter or overtime,
  margin ≤ 8, ≤ 5:00 left (any overtime); long gain ≥ 25 yards; spread cap 21; swing cap 0.30 worth up to +0.3; upset
  +0.15 in the second half; upcoming = 0.6 × prior; moment bonus ScoringThreat +0.15, CrunchTime +0.10, BigPlay +0.10,
  Live 0, Break −0.20; closeness without win probability `max(0, 1 − margin / 17)`; `L = c × (0.4 + 0.6·t)`.

### Where this plan departs from the spec (and why)

- The record schema is **`TeamRecord`**, not `Record`: `Record` is Effect's module name and is imported beside domain
  types in the Hub.
- `Odds.favorite` is the **side** (`"home" | "away"`), optional (a pick'em marks neither), not a `TeamId`: the
  classifier asks "is the underdog ahead", which is a side question, and ESPN marks the favorite per side.
- A **return** is big when the kick ends past the receiving team's 45 (`end.yardsToEndzone ≤ 55`), or is returned for
  a touchdown, not "30+ yards": ESPN's yards on a kick are the kick's, not the return's.
- `bigPlay` is **`Play.bigPlay(play)`**, a function on the `FootballPlay` object like `Play.offense`, because `Play` is
  a union, not a class.
- `Moment.precedence` is an `Order` attached with `Object.assign`, as `Hotkey` does.
- The classifier reads win probabilities straight from `game.plays` (the Hub keeps every play), so it does not keep
  them itself.
- A batch of more than 3 new plays (a game first seen, a backfill) raises no `BigPlay`.

---

### Task 1: Records, odds, and game-time helpers on the snapshot

**Files:**
- Modify: `packages/domain/src/Game.ts`
- Modify: `packages/domain/src/TestGame.ts`
- Test: `packages/domain/src/Game.test.ts`
- Modify: `CONTEXT.md` (Competition table)

**Interfaces:**
- Produces: `TeamRecord` (`{ wins: number; losses: number }`), `Odds` (`{ favorite?: "home" | "away"; spread: number;
  overUnder?: number }`), `Side.record?: TeamRecord`, `GameSnapshot.odds?: Odds`, `GameSnapshot#margin(): number`,
  `GameSnapshot#timePlayed(): number` (0–1), `GameSnapshot#inCrunchTime(): boolean`; TestGame `playFields`,
  `odds(overrides)`, `sides(home, away, rankings?)`.

- [ ] **Step 1: Write the failing tests** (append to `Game.test.ts`; reuse its imports, adding `sides` from
  `./TestGame.ts`)

```ts
describe("GameSnapshot#margin", () => {
  it("should be the points between the teams, whoever leads", () => {
    const game = liveSnapshot(sides(10, 17))

    assert.strictEqual(game.margin(), 7)
  })
})

describe("GameSnapshot#timePlayed", () => {
  it("should be none before the first snap", () => {
    const game = liveSnapshot({ period: 1, clock: "15:00" })

    assert.strictEqual(game.timePlayed(), 0)
  })

  it("should be half at the end of the second quarter", () => {
    const game = liveSnapshot({ period: 2, clock: "0:00" })

    assert.strictEqual(game.timePlayed(), 0.5)
  })

  it("should be all of it in overtime", () => {
    const game = liveSnapshot({ period: 5, clock: "8:00" })

    assert.strictEqual(game.timePlayed(), 1)
  })
})

describe("GameSnapshot#inCrunchTime", () => {
  it("should hold in the fourth quarter within one score under five minutes", () => {
    const game = liveSnapshot({ period: 4, clock: "4:59", ...sides(14, 21) })

    assert.isTrue(game.inCrunchTime())
  })

  it("should not hold with more than five minutes left", () => {
    const game = liveSnapshot({ period: 4, clock: "5:01", ...sides(14, 21) })

    assert.isFalse(game.inCrunchTime())
  })

  it("should not hold beyond one score", () => {
    const game = liveSnapshot({ period: 4, clock: "2:00", ...sides(14, 23) })

    assert.isFalse(game.inCrunchTime())
  })

  it("should hold in any overtime within one score", () => {
    const game = liveSnapshot({ league: "fbs", period: 5, clock: "0:00", ...sides(24, 24) })

    assert.isTrue(game.inCrunchTime())
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/domain/src/Game.test.ts`
Expected: FAIL — `sides` is not exported, `margin`/`timePlayed`/`inCrunchTime` do not exist.

- [ ] **Step 3: Add the schemas and fields to `Game.ts`**

Above `const Side = …` (they are schemas `Side` and `GameSnapshot` read when defined):

```ts
/** A team's wins and losses this season, as the scoreboard gives them; ties are left out. */
export const TeamRecord = Schema.Struct({ wins: Schema.Int, losses: Schema.Int })
export type TeamRecord = typeof TeamRecord.Type

/**
 * The pregame betting line: the side favored, if either, by how many points (`spread`, never negative), and the
 * total points expected. The scoreboard sends it only before kickoff.
 */
export const Odds = Schema.Struct({
  favorite: Schema.optional(Schema.Literals(["home", "away"])),
  spread: Schema.Finite,
  overUnder: Schema.optional(Schema.Finite)
})
export type Odds = typeof Odds.Type
```

Change `Side` and add the snapshot field:

```ts
const Side = Schema.Struct({
  team: Team,
  score: Schema.Int,
  ranking: Schema.optional(Schema.Int),
  record: Schema.optional(TeamRecord)
})
```

```ts
  situation: Schema.optional(Situation),
  odds: Schema.optional(Odds)
}) {
```

- [ ] **Step 4: Add the methods** (in `GameSnapshot`, after `inOvertime()`)

```ts
  /** The points between the two teams, whoever leads. */
  margin(): number {
    return Math.abs(this.home.score - this.away.score)
  }

  /** How much of regulation has been played, from 0 before the first snap to 1 at its end; overtime is 1. */
  timePlayed(): number {
    if (this.inOvertime()) return 1
    const played = (Math.max(1, this.period) - 1) * quarterSeconds + (quarterSeconds - this.secondsLeft())
    return Math.min(1, Math.max(0, played / (4 * quarterSeconds)))
  }

  /** The fourth quarter with five minutes or less left, or any overtime, with the game within one score. */
  inCrunchTime(): boolean {
    const late = this.inOvertime() || (this.period === 4 && this.secondsLeft() <= crunchSeconds)
    return late && this.margin() <= oneScore
  }
```

At the end of the file, beside `quarterSeconds`:

```ts
/** Seconds left in the fourth quarter at which a close game is in crunch time. */
const crunchSeconds = 5 * 60

/** The most points one possession can score: a touchdown and a two-point try. */
const oneScore = 8
```

- [ ] **Step 5: Add the test builders to `TestGame.ts`**

Replace the `oneYardPlay` block with:

```ts
/** What every play in a test carries: the home team's first snap, at 15:00 of the first quarter. */
export const playFields = {
  id: PlayId.make("1"),
  sequence: 1,
  period: 1,
  clock: "15:00",
  text: "Play",
  scoring: false,
  homeScore: 0,
  awayScore: 0,
  start: { down: 1, distance: 10, yardsToEndzone: 75, team: home },
  end: { down: 2, distance: 9, yardsToEndzone: 74, team: home }
}

/** The fields a one-yard first-quarter play by the home team shares, whichever way it was made. */
const oneYardPlay = { ...playFields, team: home, yards: 1, touchdown: false }
```

Add at the end (import `type Odds` from `./Game.ts`):

```ts
/** A pregame line for a test: the home team favored by 3, unless the overrides say otherwise. */
export function odds(overrides: Partial<Odds> = {}): Odds {
  return { favorite: "home", spread: 3, ...overrides }
}

/** A snapshot's two sides for a test: the home and away teams with these scores, ranked when `rankings` says. */
export function sides(home: number, away: number, rankings: { home?: number; away?: number } = {}) {
  return {
    home: { team: team("HOME"), score: home, ...(rankings.home === undefined ? {} : { ranking: rankings.home }) },
    away: { team: team("AWAY"), score: away, ...(rankings.away === undefined ? {} : { ranking: rankings.away }) }
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/domain/src/Game.test.ts`
Expected: PASS.

- [ ] **Step 7: Glossary** — in `CONTEXT.md`'s Competition table, after **Ranking**, add:

```
| **Team record** | A team's wins and losses this season, as the scoreboard gives them, ties left out: `TeamRecord`, `record` on a snapshot's side. | standing |
| **Odds** | A game's pregame betting line: the favored side, the spread in points, and the total expected; `Odds` on `GameSnapshot`. ESPN sends it only before kickoff. | line, betting |
```

- [ ] **Step 8: Check and commit**

```bash
pnpm check
git add packages/domain/src/Game.ts packages/domain/src/Game.test.ts packages/domain/src/TestGame.ts CONTEXT.md
git commit -m "feat(domain): records and odds on a snapshot; margin, time played, crunch time"
```

---

### Task 2: Decode records and odds from ESPN's scoreboard

**Files:**
- Modify: `apps/hub/src/provider/espn/EspnPayload.ts` (`Competitor`, `SiteEvent`)
- Modify: `apps/hub/src/provider/espn/EspnEvent.ts`
- Modify: `apps/hub/src/provider/espn/fixtures/decoded-snapshots.json` (regenerated)
- Test: `apps/hub/src/provider/espn/EspnEvent.test.ts`

**Interfaces:**
- Consumes: `TeamRecord`, `Odds` (Task 1).
- Produces: listings whose snapshots carry `record` and `odds` when ESPN sends them.

- [ ] **Step 1: Write the failing tests** (in `EspnEvent.test.ts`, inside `describe("EspnEvent.listingOf", …)`; add
  `GameId` to the `@sportal/domain/Game` import)

```ts
  it.effect("should read each team's overall record", () =>
    Effect.gen(function* () {
      const games = yield* EspnEvent.listingOf("fbs", fixture("fbs-scoreboard-2026-10-03T2024Z.json"))
      const game = games.find(({ id }) => id === GameId.make("401860899"))

      assert.deepStrictEqual(game?.home.record, { wins: 2, losses: 2 })
      assert.deepStrictEqual(game?.away.record, { wins: 2, losses: 2 })
    })
  )

  it.effect("should read the pregame line, its spread unsigned and the favored side", () =>
    Effect.gen(function* () {
      const games = yield* EspnEvent.listingOf("fbs", fixture("fbs-scoreboard-2026-10-03T2024Z.json"))
      const game = games.find(({ id }) => id === GameId.make("401860899"))

      assert.deepStrictEqual(game?.odds, { favorite: "away", spread: 7, overUnder: 62.5 })
    })
  )

  it.effect("should leave out odds the scoreboard does not send", () =>
    Effect.gen(function* () {
      const games = yield* EspnEvent.listingOf("fbs", fixture("fbs-scoreboard-2026-10-03T2024Z.json"))
      const game = games.find(({ id }) => id === GameId.make("401866431"))

      assert.isUndefined(game?.odds)
    })
  )
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/hub/src/provider/espn/EspnEvent.test.ts`
Expected: the three new tests FAIL (`record` and `odds` undefined).

- [ ] **Step 3: Read them in the payload** (`EspnPayload.ts`)

In `Competitor`, after `curatedRank`:

```ts
  records: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String), summary: Schema.String }))),
```

Above `SiteEvent`:

```ts
/** A competition's betting line: ESPN's spread is the home team's, and each side says whether it is favored. */
export const EspnOdds = Schema.Struct({
  spread: Schema.optional(Schema.Finite),
  overUnder: Schema.optional(Schema.Finite),
  homeTeamOdds: Schema.optional(Schema.Struct({ favorite: Schema.optional(Schema.Boolean) })),
  awayTeamOdds: Schema.optional(Schema.Struct({ favorite: Schema.optional(Schema.Boolean) }))
})
export type EspnOdds = typeof EspnOdds.Type
```

In `SiteEvent`'s competition struct, after `situation`:

```ts
      odds: Schema.optional(Schema.Array(EspnOdds)),
```

- [ ] **Step 4: Carry them through `EspnEvent.ts`**

In `espnEvent`, the competitors map and the event:

```ts
          competitors: competition.competitors.map(({ homeAway, score, curatedRank, records, team }) => ({
            ...team,
            homeAway,
            score,
            rank: curatedRank?.current,
            record: (records?.find(({ type }) => type === "total") ?? records?.[0])?.summary
          })),
```

```ts
          situation: competition.situation,
          odds: competition.odds?.[0]
```

In `snapshot`'s parameter type, add `readonly record?: string | undefined` to a competitor and
`readonly odds: EspnOdds | undefined` to the event (import `type EspnOdds`). In `side`, after the ranking spread:

```ts
    ...recordOf(competitor.record)
```

In the `new GameSnapshot({ … })`, after the situation spread:

```ts
    ...oddsOf(event.odds)
```

Below `scoreOf` (import `type Odds, type TeamRecord` from `@sportal/domain/Game`):

```ts
// A record reads "wins-losses", or "wins-losses-ties" in the NFL; the ties are left out.
function recordOf(summary: string | undefined): { record?: TeamRecord } {
  const [wins, losses] = (summary ?? "").split("-").map((part) => Number.parseInt(part, 10))
  if (wins === undefined || losses === undefined || !Number.isInteger(wins) || !Number.isInteger(losses)) return {}
  return { record: { wins, losses } }
}

// ESPN's spread is signed for the home team; the domain keeps its size and the side each team's odds mark favored.
function oddsOf(odds: EspnOdds | undefined): { odds?: Odds } {
  if (odds?.spread === undefined) return {}
  const favorite =
    odds.homeTeamOdds?.favorite === true ? "home" : odds.awayTeamOdds?.favorite === true ? "away" : undefined
  return {
    odds: {
      spread: Math.abs(odds.spread),
      ...(favorite === undefined ? {} : { favorite }),
      ...(odds.overUnder === undefined ? {} : { overUnder: odds.overUnder })
    }
  }
}
```

- [ ] **Step 5: Run the new tests**

Run: `pnpm vitest run apps/hub/src/provider/espn/EspnEvent.test.ts -t "record|line|odds"`
Expected: PASS. The golden test "should decode each listing" now FAILS: the snapshots gained fields.

- [ ] **Step 6: Regenerate the golden file.** Add this test temporarily at the end of the `describe`, run it once, then
  delete it:

```ts
  it.effect("regenerate decoded-snapshots.json", () =>
    Effect.gen(function* () {
      const fbs = yield* EspnEvent.listingOf("fbs", fixture("fbs-scoreboard-live.json"))
      const nfl = yield* EspnEvent.listingOf("nfl", scoreboardBody)
      const deliveries = [
        { league: "fbs", games: fbs.map((game) => encode(game)) },
        { league: "nfl", games: nfl.map((game) => encode(game)) }
      ]
      writeFileSync(
        new URL("./fixtures/decoded-snapshots.json", import.meta.url),
        `${JSON.stringify({ deliveries: encoded(deliveries) }, null, 2)}\n`
      )
    })
  )
```

(`import { readFileSync, writeFileSync } from "node:fs"` while it exists.) Run
`pnpm vitest run apps/hub/src/provider/espn/EspnEvent.test.ts -t regenerate`, delete the test and the import, then check
the diff only adds `record` and `odds` keys:

Run: `git diff --stat apps/hub/src/provider/espn/fixtures/decoded-snapshots.json && git diff apps/hub/src/provider/espn/fixtures/decoded-snapshots.json | grep '^[-+] ' | grep -v -E '"(record|odds|wins|losses|favorite|spread|overUnder)"|^\+\s*[}\]],?$|^\+\s*\{$' | head`
Expected: no output from the second command (only additions of those keys). If the file's existing formatting differs
(for example it was not pretty-printed), match its formatting instead of `null, 2`.

- [ ] **Step 7: Run the whole adapter suite**

Run: `pnpm vitest run apps/hub/src/provider/espn`
Expected: PASS.

- [ ] **Step 8: Check and commit**

```bash
pnpm check
git add apps/hub/src/provider/espn
git commit -m "feat(hub): decode each team's record and the pregame line from ESPN's scoreboard"
```

---

### Task 3: Big plays

**Files:**
- Modify: `packages/domain/src/Play.ts`
- Test: `packages/domain/src/Play.test.ts`
- Modify: `CONTEXT.md` (Play table, beside **Play outcome**)

**Interfaces:**
- Consumes: TestGame `playFields`, `play`, `completion` (Task 1).
- Produces: `BigPlayKind` (`"touchdown" | "turnover" | "sack" | "return" | "longGain"`, a `Schema.Literals`) and
  `Play.bigPlay(play: Play): Option.Option<BigPlayKind>`.

- [ ] **Step 1: Write the failing tests** (append to `Play.test.ts`; import `Option` from `effect`, the case classes
  from `./Play.ts`, and `playFields`, `play`, `completion` from `./TestGame.ts`)

```ts
describe("FootballPlay.bigPlay", () => {
  it("should call a touchdown run a touchdown", () => {
    const run = play({ yards: 3, touchdown: true, scoring: true })

    assert.deepStrictEqual(Play.bigPlay(run), Option.some("touchdown"))
  })

  it("should call a 25-yard catch a long gain", () => {
    const catch25 = completion({ yards: 25 })

    assert.deepStrictEqual(Play.bigPlay(catch25), Option.some("longGain"))
  })

  it("should not call a 24-yard catch a big play", () => {
    const catch24 = completion({ yards: 24 })

    assert.deepStrictEqual(Play.bigPlay(catch24), Option.none())
  })

  it("should call any sack a sack", () => {
    const sack = new Sack({ ...playFields, team: playFields.start.team, yards: -2, fumbleLost: false })

    assert.deepStrictEqual(Play.bigPlay(sack), Option.some("sack"))
  })

  it("should call a strip sack a turnover", () => {
    const sack = new Sack({ ...playFields, team: playFields.start.team, yards: -8, fumbleLost: true })

    assert.deepStrictEqual(Play.bigPlay(sack), Option.some("turnover"))
  })

  it("should call an interception a turnover", () => {
    const pick = new Interception({ ...playFields, team: playFields.start.team, yards: 0, return: "returned" })

    assert.deepStrictEqual(Play.bigPlay(pick), Option.some("turnover"))
  })

  it("should call a pick-six a touchdown", () => {
    const pick = new Interception({ ...playFields, team: playFields.start.team, yards: 0, return: "touchdown" })

    assert.deepStrictEqual(Play.bigPlay(pick), Option.some("touchdown"))
  })

  it("should call a fumble the defense recovers a turnover", () => {
    const fumble = new Fumble({ ...playFields, team: playFields.start.team, yards: 2, recovery: "opponent" })

    assert.deepStrictEqual(Play.bigPlay(fumble), Option.some("turnover"))
  })

  it("should not call a fumble the offense recovers a big play", () => {
    const fumble = new Fumble({ ...playFields, team: playFields.start.team, yards: 2, recovery: "own" })

    assert.deepStrictEqual(Play.bigPlay(fumble), Option.none())
  })

  it("should call a kickoff returned past the receiving team's 45 a return", () => {
    const kick = new Kickoff({
      ...playFields,
      yards: 60,
      returnTouchdown: false,
      end: { yardsToEndzone: 52, team: playFields.start.team }
    })

    assert.deepStrictEqual(Play.bigPlay(kick), Option.some("return"))
  })

  it("should not call a touchback a big play", () => {
    const kick = new Kickoff({
      ...playFields,
      yards: 65,
      returnTouchdown: false,
      end: { yardsToEndzone: 75, team: playFields.start.team }
    })

    assert.deepStrictEqual(Play.bigPlay(kick), Option.none())
  })

  it("should call a punt returned for a touchdown a touchdown", () => {
    const punt = new Punt({ ...playFields, yards: 45, return: "touchdown" })

    assert.deepStrictEqual(Play.bigPlay(punt), Option.some("touchdown"))
  })

  it("should not call a punt nobody returned a big play, wherever it ended", () => {
    const punt = new Punt({
      ...playFields,
      yards: 30,
      return: "none",
      end: { yardsToEndzone: 50, team: playFields.start.team }
    })

    assert.deepStrictEqual(Play.bigPlay(punt), Option.none())
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/domain/src/Play.test.ts`
Expected: FAIL — `Play.bigPlay` does not exist.

- [ ] **Step 3: Implement it in `Play.ts`**

Above `const cases` (it is a wire value read by `Moment` and the classifier):

```ts
/** What kind of big play a play is: see `FootballPlay.bigPlay`. */
export const BigPlayKind = Schema.Literals(["touchdown", "turnover", "sack", "return", "longGain"])
export type BigPlayKind = typeof BigPlayKind.Type
```

Add `bigPlay` to the `FootballPlay` object and its doc comment's list:

```ts
export const FootballPlay = Object.assign(cases, {
  /** By `sequence`. */
  order: Order.mapInput(Order.Number, (play: typeof cases.Type) => play.sequence),
  gainsYards,
  offense,
  lostYards,
  bigPlay
})
```

Below `lostYards` (add `Option` to the `effect` import):

```ts
/**
 * The kind of big play `play` is, if it is one, the first that holds of: a touchdown, a turnover, a sack, a kick
 * returned past the receiving team's 45, a run or catch of 25 yards or more.
 */
function bigPlay(play: typeof cases.Type): Option.Option<BigPlayKind> {
  const none = Option.none<BigPlayKind>()
  const kind = (found: BigPlayKind) => Option.some(found)
  const long = (yards: number) => (yards >= longGain ? kind("longGain") : none)
  const returned = (end: typeof play.end) =>
    end.yardsToEndzone !== undefined && end.yardsToEndzone <= bigReturnEnd ? kind("return") : none

  return cases.match(play, {
    Rush: ({ touchdown, yards }) => (touchdown ? kind("touchdown") : long(yards)),
    Completion: ({ touchdown, yards }) => (touchdown ? kind("touchdown") : long(yards)),
    Incompletion: () => none,
    Interception: (pick) => kind(pick.return === "touchdown" ? "touchdown" : "turnover"),
    Sack: ({ fumbleLost }) => kind(fumbleLost ? "turnover" : "sack"),
    Fumble: ({ recovery }) =>
      recovery === "touchdown" ? kind("touchdown") : recovery === "opponent" ? kind("turnover") : none,
    TwoPointTry: () => none,
    Kickoff: ({ returnTouchdown, end }) => (returnTouchdown ? kind("touchdown") : returned(end)),
    Punt: (punt) =>
      punt.return === "touchdown" ? kind("touchdown") : punt.return === "returned" ? returned(punt.end) : none,
    FieldGoal: () => none,
    ExtraPoint: () => none,
    Safety: () => none,
    Penalty: () => none,
    Timeout: () => none,
    Stoppage: () => none,
    PeriodEnd: () => none,
    Other: () => none
  })
}

/** Yards from scrimmage at which a run or a catch is a big play. */
const longGain = 25

/** Yards to the end zone at which a returned kick has passed the receiving team's 45. */
const bigReturnEnd = 55
```

(If `cases.match` is not the data-first form in this Effect version, use the form `LiveMessage.match(message, {…})`
uses in `apps/web/src/hub/LiveStream.ts`, which is the same `toTaggedUnion` API.)

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/domain/src/Play.test.ts`
Expected: PASS.

- [ ] **Step 5: Glossary** — in `CONTEXT.md`, after **Play outcome**:

```
| **Big play** | A play worth a look by itself: a touchdown, a turnover, a sack, a kick returned past the receiving team's 45, or a run or catch of 25 yards or more; `FootballPlay.bigPlay` gives its `BigPlayKind`. | highlight |
```

- [ ] **Step 6: Check and commit**

```bash
pnpm check
git add packages/domain/src/Play.ts packages/domain/src/Play.test.ts CONTEXT.md
git commit -m "feat(domain): big plays, by kind"
```

---

### Task 4: Moment and Classification: the score

**Files:**
- Create: `packages/domain/src/Moment.ts`
- Create: `packages/domain/src/Classification.ts`
- Test: `packages/domain/src/Moment.test.ts`, `packages/domain/src/Classification.test.ts`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `GameSnapshot#margin/timePlayed`, `Odds`, `TeamRecord` (Task 1); `BigPlayKind`, `PlayId` (Task 3).
- Produces:
  - `Moment` — `Schema.TaggedUnion` with cases `ScoringThreat { team: TeamId; yardsToGo: number }`,
    `CrunchTime { margin: number; secondsLeft: number }`, `BigPlay { play: PlayId; kind: BigPlayKind }`, `Live {}`,
    `Break { reason: BreakReason }`, `Upcoming {}`, `Final {}`; plus `Moment.precedence: Order.Order<Moment>`
    (higher precedence sorts first). `BreakReason` = `"timeout" | "periodEnd" | "halftime" | "delay" | "afterScore"`.
  - `Classification` (`Schema.Class`): `{ moment: Moment; score: number; since: DateTime.Utc; breakdown: { prior;
    closeness; swing; upset; momentBonus } }` and
    `Classification.of(game: { snapshot: GameSnapshot; odds: Odds | undefined; winProbabilities: ReadonlyArray<number> }, moment: Moment, since: DateTime.Utc): Classification`.

- [ ] **Step 1: Write the failing Moment test** (`Moment.test.ts`)

```ts
import { assert, describe, it } from "@effect/vitest"
import { Moment } from "./Moment.ts"

describe("Moment.precedence", () => {
  it("should put a scoring threat before crunch time, a big play, live play, and a break, in that order", () => {
    const moments: ReadonlyArray<Moment> = [
      { _tag: "Break", reason: "timeout" },
      { _tag: "Live" },
      { _tag: "CrunchTime", margin: 3, secondsLeft: 100 },
      { _tag: "ScoringThreat", team: team("HOME").id, yardsToGo: 8 }
    ]

    const ordered = moments.toSorted(Moment.precedence).map(({ _tag }) => _tag)

    assert.deepStrictEqual(ordered, ["ScoringThreat", "CrunchTime", "Live", "Break"])
  })
})
```

(import `team` from `./TestGame.ts`.)

- [ ] **Step 2: Write `Moment.ts`**

```ts
import { Order, Schema } from "effect"
import { BigPlayKind, PlayId } from "./Play.ts"
import { TeamId } from "./Team.ts"

/** Why a live game has stopped. */
export const BreakReason = Schema.Literals(["timeout", "periodEnd", "halftime", "delay", "afterScore"])
export type BreakReason = typeof BreakReason.Type

const cases = Schema.TaggedUnion({
  /** The team with the ball is in the red zone. */
  ScoringThreat: { team: TeamId, yardsToGo: Schema.Int },
  /** The fourth quarter's last five minutes, or overtime, within one score. */
  CrunchTime: { margin: Schema.Int, secondsLeft: Schema.Int },
  /** A big play, for a while after it. */
  BigPlay: { play: PlayId, kind: BigPlayKind },
  Live: {},
  Break: { reason: BreakReason },
  Upcoming: {},
  Final: {}
})

/**
 * What kind of thing is happening in a game now: one case per game, the one highest in `precedence` of those that
 * hold, with what commentary and prompts need of it.
 */
export const Moment = Object.assign(cases, {
  /** Higher precedence first: a scoring threat, crunch time, a big play, live play, a break, then not live. */
  precedence: Order.mapInput(Order.Number, (moment: typeof cases.Type) => rank[moment._tag])
})
export type Moment = typeof cases.Type

const rank = {
  ScoringThreat: 0,
  CrunchTime: 1,
  BigPlay: 2,
  Live: 3,
  Break: 4,
  Upcoming: 5,
  Final: 6
} satisfies Record<Moment["_tag"], number>
```

- [ ] **Step 3: Run the Moment test**

Run: `pnpm vitest run packages/domain/src/Moment.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing Classification tests** (`Classification.test.ts`). These are the spec's ranking
  statements; they compare scores, never assert a raw number, except that a final game scores 0.

```ts
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { Classification } from "./Classification.ts"
import type { GameSnapshot, Odds } from "./Game.ts"
import type { Moment } from "./Moment.ts"
import { PlayId } from "./Play.ts"
import { liveSnapshot, odds, sides, snapshot, team } from "./TestGame.ts"

describe("Classification.of, ranking", () => {
  it("should rank a tie late in the fourth above a tie in the first", () => {
    const late = scoreOf(liveSnapshot({ period: 4, clock: "1:30" }))
    const early = scoreOf(liveSnapshot({ period: 1, clock: "10:00" }))

    assert.isAbove(late, early)
  })

  it("should rank a fourth-quarter blowout below a one-score game in the fourth", () => {
    const blowout = scoreOf(liveSnapshot({ period: 4, clock: "8:00", ...sides(28, 7) }))
    const close = scoreOf(liveSnapshot({ period: 4, clock: "8:00", ...sides(14, 7) }))

    assert.isBelow(blowout, close)
  })

  it("should rank two top-10 teams before kickoff above an unranked 21–0 game in the second quarter", () => {
    const topTen = scoreOf(snapshot(sides(0, 0, { home: 3, away: 8 })), { moment: upcoming })
    const lopsided = scoreOf(liveSnapshot({ period: 2, clock: "7:30", ...sides(21, 0) }))

    assert.isAbove(topTen, lopsided)
  })

  it("should rank a ranked team against an unranked one before kickoff below a tie in the third quarter", () => {
    const pregame = scoreOf(snapshot(sides(0, 0, { home: 10 })), {
      moment: upcoming,
      odds: odds({ favorite: "home", spread: 10 })
    })
    const tied = scoreOf(liveSnapshot({ period: 3, clock: "7:30", ...sides(17, 17) }))

    assert.isBelow(pregame, tied)
  })

  it("should rank the better matchup higher of two ties in the third quarter", () => {
    const better = scoreOf(liveSnapshot({ period: 3, clock: "7:30", ...sides(17, 17, { home: 5, away: 12 }) }))
    const worse = scoreOf(liveSnapshot({ period: 3, clock: "7:30", ...sides(17, 17) }))

    assert.isAbove(better, worse)
  })

  it("should rank a late sack that swings the game above a sack in the first quarter of a 28–0 game", () => {
    const late = scoreOf(liveSnapshot({ period: 4, clock: "1:40", ...sides(17, 20) }), {
      moment: sack,
      winProbabilities: [0.45, 0.3]
    })
    const early = scoreOf(liveSnapshot({ period: 1, clock: "5:00", ...sides(28, 0) }), {
      moment: sack,
      winProbabilities: [0.97, 0.98]
    })

    assert.isAbove(late, early)
  })

  it("should rank a game in the red zone above the same game at midfield", () => {
    const game = liveSnapshot({ period: 2, clock: "6:00", ...sides(7, 3) })

    const threat = scoreOf(game, { moment: { _tag: "ScoringThreat", team: team("HOME").id, yardsToGo: 12 } })
    const midfield = scoreOf(game)

    assert.isAbove(threat, midfield)
  })

  it("should rank a game in a break below the same game live", () => {
    const game = liveSnapshot({ period: 3, clock: "7:30", ...sides(17, 17) })

    const resting = scoreOf(game, { moment: { _tag: "Break", reason: "timeout" } })
    const live = scoreOf(game)

    assert.isBelow(resting, live)
  })

  it("should rank the pregame underdog leading in the fourth above the favorite leading by as much", () => {
    const game = liveSnapshot({ period: 4, clock: "6:00", ...sides(10, 17) })

    const upset = scoreOf(game, { odds: odds({ favorite: "home", spread: 7 }) })
    const expected = scoreOf(game, { odds: odds({ favorite: "away", spread: 7 }) })

    assert.isAbove(upset, expected)
  })

  it("should score a final game 0", () => {
    const final = scoreOf(snapshot({ status: "final", period: 4, ...sides(21, 20) }), { moment: { _tag: "Final" } })

    assert.strictEqual(final, 0)
  })
})

describe("Classification.of, the matchup prior", () => {
  it("should leave out an input the game lacks, not count it as none", () => {
    const records = { wins: 3, losses: 1 }
    const game = snapshot({
      league: "nfl",
      home: { team: team("HOME", "nfl"), score: 0, record: records },
      away: { team: team("AWAY", "nfl"), score: 0, record: records }
    })

    const withoutLine = Classification.of({ snapshot: game, odds: undefined, winProbabilities: [] }, upcoming, at)
    const pickEm = Classification.of(
      { snapshot: game, odds: odds({ spread: 0 }), winProbabilities: [] },
      upcoming,
      at
    )

    assert.isAbove(withoutLine.score, 0)
    assert.isAbove(pickEm.score, withoutLine.score)
  })

  it("should give each part's points in the breakdown, adding up to the score", () => {
    const game = liveSnapshot({ period: 3, clock: "7:30", ...sides(17, 14, { home: 4 }) })

    const { score, breakdown } = Classification.of(
      { snapshot: game, odds: odds(), winProbabilities: [0.5, 0.6] },
      { _tag: "Live" },
      at
    )

    const total = breakdown.prior + breakdown.closeness + breakdown.swing + breakdown.upset + breakdown.momentBonus
    assert.strictEqual(score, Math.round(total))
  })
})

const at = DateTime.makeUnsafe("2026-10-10T20:00:00Z")

const upcoming: Moment = { _tag: "Upcoming" }

const sack: Moment = { _tag: "BigPlay", play: PlayId.make("1"), kind: "sack" }

/** `game`'s score, live with no line and no win probability unless `given` says otherwise. */
function scoreOf(
  game: GameSnapshot,
  given: { moment?: Moment; odds?: Odds; winProbabilities?: ReadonlyArray<number> } = {}
): number {
  const moment = given.moment ?? { _tag: "Live" }
  return Classification.of({ snapshot: game, odds: given.odds, winProbabilities: given.winProbabilities ?? [] }, moment, at)
    .score
}
```

- [ ] **Step 5: Run them to see them fail**

Run: `pnpm vitest run packages/domain/src/Classification.test.ts`
Expected: FAIL — `./Classification.ts` does not exist.

- [ ] **Step 6: Write `Classification.ts`**

```ts
import { type DateTime, Schema } from "effect"
import type { GameSnapshot, Odds } from "./Game.ts"
import { Moment } from "./Moment.ts"

const Breakdown = Schema.Struct({
  prior: Schema.Finite,
  closeness: Schema.Finite,
  swing: Schema.Finite,
  upset: Schema.Finite,
  momentBonus: Schema.Finite
})

/**
 * How worth watching a game is now: its moment and since when, and a score from 0 to 100 with the points each part
 * gave it (`breakdown`, which adds up to the score before it is rounded and kept within 0–100).
 */
export class Classification extends Schema.Class<Classification>("sportal/Classification")({
  moment: Moment,
  score: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  since: Schema.DateTimeUtcFromString,
  breakdown: Breakdown
}) {
  /**
   * `game` in `moment` since `since`, scored. Before kickoff the score is the matchup prior alone; once live, the prior
   * fades as the game is played and the live value takes over: closeness weighted by time played, the largest recent
   * swing in win probability, an upset brewing, and the moment's bonus. A game that is over scores 0.
   */
  static of(
    game: {
      readonly snapshot: GameSnapshot
      readonly odds: Odds | undefined
      readonly winProbabilities: ReadonlyArray<number>
    },
    moment: Moment,
    since: DateTime.Utc
  ): Classification {
    const breakdown = breakdownOf(game.snapshot, game.odds, game.winProbabilities, moment)
    const total = breakdown.prior + breakdown.closeness + breakdown.swing + breakdown.upset + breakdown.momentBonus
    const score = Math.round(Math.min(100, Math.max(0, total)))
    return new Classification({ moment, score, since, breakdown })
  }
}

// Every tunable number of the score, in one place.
const weights = {
  /** An upcoming game's share of its prior. */
  upcoming: 0.6,
  /** The spread at which a matchup's line counts for nothing. */
  maxSpread: 21,
  /** The prior of a game with no input to judge it by. */
  unknownPrior: 0.5,
  /** The margin at which a game with no win probability counts as not close at all. */
  closeMargin: 17,
  /** How much a tie counts at kickoff, rising to all of it at the end of regulation. */
  earlyCloseness: 0.4,
  /** The win-probability swing that counts in full, and what it is worth. */
  swingCap: 0.3,
  swing: 0.3,
  /** What an upset brewing in the second half is worth. */
  upset: 0.15
}

const momentBonus = {
  ScoringThreat: 0.15,
  CrunchTime: 0.1,
  BigPlay: 0.1,
  Live: 0,
  Break: -0.2,
  Upcoming: 0,
  Final: 0
} satisfies Record<Moment["_tag"], number>

/** Each part's points. */
function breakdownOf(
  snapshot: GameSnapshot,
  odds: Odds | undefined,
  winProbabilities: ReadonlyArray<number>,
  moment: Moment
): typeof Breakdown.Type {
  const none = { prior: 0, closeness: 0, swing: 0, upset: 0, momentBonus: 0 }
  const progress = snapshot.progress()
  if (progress === "over") return none
  const prior = priorOf(snapshot, odds)
  if (progress === "upcoming") return { ...none, prior: 100 * weights.upcoming * prior }

  const played = snapshot.timePlayed()
  const winProbability = winProbabilities.at(-1)
  const close =
    winProbability === undefined
      ? Math.max(0, 1 - snapshot.margin() / weights.closeMargin)
      : 1 - 2 * Math.abs(winProbability - 0.5)
  const swing = Math.min(largestSwing(winProbabilities), weights.swingCap) / weights.swingCap
  const upset = played >= 0.5 && underdogAhead(snapshot, odds, winProbability) ? weights.upset : 0
  return {
    prior: 100 * (1 - played) * prior,
    closeness: 100 * played * close * (weights.earlyCloseness + (1 - weights.earlyCloseness) * played),
    swing: 100 * played * weights.swing * swing,
    upset: 100 * played * upset,
    momentBonus: 100 * momentBonus[moment._tag]
  }
}

/**
 * The matchup prior, 0–1: the mean of the inputs the game has — how close the line is, how highly the teams are
 * ranked (college only), and how often they have won. A game with none of them is middling.
 */
function priorOf(snapshot: GameSnapshot, odds: Odds | undefined): number {
  const inputs = [
    odds === undefined ? undefined : 1 - Math.min(odds.spread, weights.maxSpread) / weights.maxSpread,
    snapshot.league === "fbs"
      ? (rankShare(snapshot.home.ranking) + rankShare(snapshot.away.ranking)) / 2
      : undefined,
    winShare(snapshot)
  ].filter((input) => input !== undefined)
  return inputs.length === 0 ? weights.unknownPrior : inputs.reduce((sum, input) => sum + input, 0) / inputs.length
}

/** A ranking's share: 1 for first, falling to 0.04 for 25th; 0 unranked. */
function rankShare(ranking: number | undefined): number {
  return ranking === undefined ? 0 : (26 - ranking) / 25
}

/** The two teams' mean share of games won, when both have played. */
function winShare(snapshot: GameSnapshot): number | undefined {
  const [home, away] = [snapshot.home.record, snapshot.away.record].map((record) =>
    record === undefined || record.wins + record.losses === 0 ? undefined : record.wins / (record.wins + record.losses)
  )
  return home === undefined || away === undefined ? undefined : (home + away) / 2
}

/** The largest change in win probability from one play to the next. */
function largestSwing(winProbabilities: ReadonlyArray<number>): number {
  return winProbabilities
    .slice(1)
    .reduce((most, next, index) => Math.max(most, Math.abs(next - (winProbabilities[index] ?? next))), 0)
}

/** Whether the side the line did not favor is ahead: by win probability when there is one, else on the scoreboard. */
function underdogAhead(snapshot: GameSnapshot, odds: Odds | undefined, winProbability: number | undefined): boolean {
  const favorite = odds?.favorite
  if (favorite === undefined) return false
  const underdog = favorite === "home" ? "away" : "home"
  if (winProbability !== undefined) return (underdog === "home" ? winProbability : 1 - winProbability) > 0.5
  return snapshot[underdog].score > snapshot[favorite].score
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run packages/domain/src/Classification.test.ts packages/domain/src/Moment.test.ts`
Expected: PASS. If a ranking test fails, recheck the formula against the spec's Scoring section before touching a
weight; the statements are the spec's.

- [ ] **Step 8: Glossary.** In `CONTEXT.md`, add a new section `### Automation` above `## Planned` with:

```
| Term | Meaning | Not |
| --- | --- | --- |
| **Moment** | What kind of thing is happening in a game now — a scoring threat (red zone), crunch time, a big play, live play, a break, upcoming, or final — one per game, the highest in precedence of those that hold; `Moment` in `packages/domain/src/Moment.ts`. | event, state |
| **Break** | A live game stopped: a timeout, the end of a period, halftime, a delay, or the gap from a score to the next kickoff; the `Break` moment and its `BreakReason`. Inferred from the data, never the video. | commercial, lull |
| **Classification** | A game's moment, since when, and its score 0–100 with the points each part gave it; `Classification` in `packages/domain/src/Classification.ts`. | rating, watchability |
| **Matchup prior** | What a game promises before it starts: the mean of how close its line is, how highly its teams are ranked, and how often they have won. It fades as the game is played. | |
```

In `## Planned`, delete the rows **Game event**, **Trigger**, **Rule** and **Alert** (Moment and Classification
replace them; later pieces add their own words).

- [ ] **Step 9: Check and commit**

```bash
pnpm check
git add packages/domain/src/Moment.ts packages/domain/src/Moment.test.ts packages/domain/src/Classification.ts packages/domain/src/Classification.test.ts CONTEXT.md
git commit -m "feat(domain): moments, and a classification's score from the matchup and the game"
```

---

### Task 5: The Classifier fold

**Files:**
- Create: `packages/domain/src/Classifier.ts`
- Test: `packages/domain/src/Classifier.test.ts`
- Modify: `packages/domain/src/TestGame.ts` (a `timeout` builder)
- Modify: `CONTEXT.md` (Automation section)

**Interfaces:**
- Consumes: `Classification.of`, `Moment` (Task 4); `Play.bigPlay` (Task 3); `GameSnapshot#inCrunchTime/margin`,
  `Odds` (Task 1); `Slate`, `SlateChange` (existing).
- Produces:
  - `Classifier.empty: Classifier`
  - `classifier.step(slate: Slate, changes: ReadonlyArray<SlateChange>, now: DateTime.Utc): readonly [Classifier, ReadonlyMap<GameId, Classification>]`
  - `classifier.nextExpiry(): Option.Option<DateTime.Utc>`
  - `Classifier.bigPlayHold` (60 s), `Classifier.momentHold` (20 s) — `Duration`s.

- [ ] **Step 1: Add a `timeout` builder to `TestGame.ts`** (import `Timeout` from `./Play.ts`)

```ts
/** A timeout for a test: the home team's, at 15:00 of the first quarter, unless the overrides say otherwise. */
export function timeout(overrides: Partial<Timeout> = {}): Timeout {
  return new Timeout({ ...playFields, text: "Timeout", team: home, ...overrides })
}
```

- [ ] **Step 2: Write the failing tests** (`Classifier.test.ts`)

```ts
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Option } from "effect"
import { Classifier } from "./Classifier.ts"
import { Game, GameId, type GameSnapshot } from "./Game.ts"
import { type Play, PlayId } from "./Play.ts"
import { Slate, SlateChange } from "./Slate.ts"
import { completion, liveSnapshot, odds, play, situation, snapshot, sides, timeout } from "./TestGame.ts"

describe("Classifier#step, moments", () => {
  it("should call a scheduled game upcoming", () => {
    const moment = momentOf(Classifier.empty, snapshot({ id }))

    assert.strictEqual(moment, "Upcoming")
  })

  it("should call a final game final", () => {
    const moment = momentOf(Classifier.empty, snapshot({ id, status: "final", period: 4 }))

    assert.strictEqual(moment, "Final")
  })

  it("should call a drive in the red zone a scoring threat", () => {
    const moment = momentOf(Classifier.empty, liveSnapshot({ id, situation: situation({ yardLine: 15 }) }))

    assert.strictEqual(moment, "ScoringThreat")
  })

  it("should call the last five minutes of a one-score game crunch time", () => {
    const moment = momentOf(Classifier.empty, liveSnapshot({ id, period: 4, clock: "3:00", ...sides(20, 17) }))

    assert.strictEqual(moment, "CrunchTime")
  })

  it("should call a game a big play when a play it did not have is one", () => {
    const big = completion({ yards: 40 })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [big]), [played(big)], at)

    assert.strictEqual(classified.get(id)?.moment._tag, "BigPlay")
  })

  it("should call no big play for a batch of more than three new plays", () => {
    const plays = [1, 2, 3, 4].map((sequence) =>
      completion({ id: playId(sequence), sequence, yards: 40 })
    )

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), plays), plays.map(played), at)

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should call a game at halftime a break", () => {
    const moment = momentOf(Classifier.empty, liveSnapshot({ id, status: "halftime", period: 2, clock: "0:00" }))

    assert.strictEqual(moment, "Break")
  })

  it("should call a game a break after a timeout", () => {
    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [timeout()]), [], at)

    assert.deepStrictEqual(classified.get(id)?.moment, { _tag: "Break", reason: "timeout" })
  })

  it("should call a game a break from a score until the next kickoff", () => {
    const touchdown = play({ yards: 2, touchdown: true, scoring: true })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [touchdown]), [], at)

    assert.deepStrictEqual(classified.get(id)?.moment, { _tag: "Break", reason: "afterScore" })
  })

  it("should call a game at the end of a period a break", () => {
    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id, period: 1, clock: "0:00" })), [], at)

    assert.deepStrictEqual(classified.get(id)?.moment, { _tag: "Break", reason: "periodEnd" })
  })

  it("should call a game live with nothing else going on", () => {
    const moment = momentOf(Classifier.empty, liveSnapshot({ id }))

    assert.strictEqual(moment, "Live")
  })
})

describe("Classifier#step, holding a moment", () => {
  it("should keep a moment for twenty seconds before a lower one replaces it", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id, situation: situation({ yardLine: 15 }) })), [], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id })), [], later(19))

    assert.strictEqual(classified.get(id)?.moment._tag, "ScoringThreat")
  })

  it("should let a lower moment replace one held twenty seconds", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id, situation: situation({ yardLine: 15 }) })), [], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id })), [], later(20))

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should let a higher moment replace one at once", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id })), [], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id, situation: situation({ yardLine: 15 }) })), [], later(1))

    assert.strictEqual(classified.get(id)?.moment._tag, "ScoringThreat")
    assert.isTrue(DateTime.Equivalence(classified.get(id)?.since ?? at, later(1)))
  })

  it("should keep when a moment began while it holds", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id })), [], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id, clock: "9:00" })), [], later(30))

    assert.isTrue(DateTime.Equivalence(classified.get(id)?.since ?? later(30), at))
  })

  it("should end a big play a minute after it", () => {
    const big = completion({ yards: 40 })
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [big]), [played(big)], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [big]), [], later(60))

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })
})

describe("Classifier#nextExpiry", () => {
  it("should be none with nothing held", () => {
    const [classifier] = Classifier.empty.step(slateOf(liveSnapshot({ id })), [], at)

    assert.isTrue(Option.isNone(classifier.nextExpiry()))
  })

  it("should be when a big play ends", () => {
    const big = completion({ yards: 40 })

    const [classifier] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [big]), [played(big)], at)

    assert.deepStrictEqual(classifier.nextExpiry(), Option.some(later(60)))
  })

  it("should be when a moment held back from a lower one may give way", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id, situation: situation({ yardLine: 15 }) })), [], at)

    const [classifier] = first.step(slateOf(liveSnapshot({ id })), [], later(5))

    assert.deepStrictEqual(classifier.nextExpiry(), Option.some(later(20)))
  })
})

describe("Classifier#step, what it keeps", () => {
  it("should keep a game's line after the scoreboard stops sending it", () => {
    const [first] = Classifier.empty.step(slateOf(snapshot({ id, odds: odds({ spread: 0 }) })), [], at)
    const kickedOff = liveSnapshot({ id })

    const [, kept] = first.step(slateOf(kickedOff), [], later(1))
    const [, fresh] = Classifier.empty.step(slateOf(kickedOff), [], later(1))

    assert.isAbove(kept.get(id)?.breakdown.prior ?? 0, fresh.get(id)?.breakdown.prior ?? 0)
  })

  it("should forget a game no listing names", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id })), [], at)

    const [, classified] = first.step(Slate.empty, [], later(1))

    assert.isFalse(classified.has(id))
  })
})

const id = GameId.make("1")

const at = DateTime.makeUnsafe("2026-10-10T20:00:00Z")

function later(seconds: number): DateTime.Utc {
  return DateTime.addDuration(at, Duration.seconds(seconds))
}

function playId(sequence: number) {
  return PlayId.make(String(sequence))
}

function slateOf(game: GameSnapshot, plays: ReadonlyArray<Play> = []): Slate {
  return new Slate({ games: [new Game({ snapshot: game, plays })] })
}

function played(play: Play): SlateChange {
  return SlateChange.Played({ game: Game.of(liveSnapshot({ id })), play })
}

/** `game`'s moment's tag, stepped with no changes. */
function momentOf(classifier: Classifier, game: GameSnapshot) {
  const [, classified] = classifier.step(slateOf(game), [], at)
  return classified.get(id)?.moment._tag
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run packages/domain/src/Classifier.test.ts`
Expected: FAIL — `./Classifier.ts` does not exist.

- [ ] **Step 4: Write `Classifier.ts`**

```ts
import { Data, DateTime, Duration, Option } from "effect"
import { Classification } from "./Classification.ts"
import type { Game, GameId, Odds } from "./Game.ts"
import { type BreakReason, Moment } from "./Moment.ts"
import { type BigPlayKind, Play, type PlayId } from "./Play.ts"
import { type Slate, SlateChange } from "./Slate.ts"

/**
 * The fold that classifies the slate's games, one step per take and per expiry. It keeps per game what the slate
 * does not: the pregame line once the scoreboard drops it, a big play while it lasts, and the moment shown and since
 * when, which holds `momentHold` before a lower one replaces it. Pure.
 */
export class Classifier extends Data.Class<{ readonly games: ReadonlyMap<GameId, Followed> }> {
  static readonly empty: Classifier = new Classifier({ games: new Map() })

  /** How long a big play holds its game's moment. */
  static readonly bigPlayHold = Duration.seconds(60)

  /** How long a moment holds before a lower one may replace it. */
  static readonly momentHold = Duration.seconds(20)

  /**
   * Each listed game classified at `now`, `changes` being what the take that made `slate` changed (none for an
   * expiry); a game no listing names is forgotten.
   */
  step(
    slate: Slate,
    changes: ReadonlyArray<SlateChange>,
    now: DateTime.Utc
  ): readonly [Classifier, ReadonlyMap<GameId, Classification>] {
    const games = new Map(
      slate.games.map((game) => {
        const id = game.snapshot.id
        const plays = changes.flatMap((change) =>
          SlateChange.$is("Played")(change) && change.game.snapshot.id === id ? [change.play] : []
        )
        return [id, followed(this.games.get(id), game, plays, now)] as const
      })
    )
    const classifications = new Map([...games].map(([id, { classification }]) => [id, classification] as const))
    return [new Classifier({ games }), classifications]
  }

  /** When the earliest held moment runs out, so the next step can let it go. */
  nextExpiry(): Option.Option<DateTime.Utc> {
    return earliest([...this.games.values()].map(({ expiry }) => expiry))
  }
}

/** What the classifier keeps of one game. */
interface Followed {
  readonly odds: Odds | undefined
  readonly bigPlay: { readonly play: PlayId; readonly kind: BigPlayKind; readonly until: DateTime.Utc } | undefined
  readonly classification: Classification
  readonly expiry: DateTime.Utc | undefined
}

function followed(had: Followed | undefined, game: Game, plays: ReadonlyArray<Play>, now: DateTime.Utc): Followed {
  const { snapshot } = game
  const odds = snapshot.odds ?? had?.odds
  const lasting = had?.bigPlay !== undefined && DateTime.isLessThan(now, had.bigPlay.until) ? had.bigPlay : undefined
  const bigPlay = latestBigPlay(plays, now) ?? lasting
  const [moment, since, heldBack] = settled(had?.classification, momentOf(game, bigPlay), now)

  const winProbabilities = game.plays
    .flatMap(({ homeWinProbability }) => (homeWinProbability === undefined ? [] : [homeWinProbability]))
    .slice(-swingPlays)
  const classification = Classification.of({ snapshot, odds, winProbabilities }, moment, since)
  const held = heldBack ? DateTime.addDuration(since, Classifier.momentHold) : undefined
  const expiry = Option.getOrUndefined(earliest([bigPlay?.until, held]))
  return { odds, bigPlay, classification, expiry }
}

/** The newest big play among a take's new plays, lasting `bigPlayHold`; none for a backfill of many. */
function latestBigPlay(plays: ReadonlyArray<Play>, now: DateTime.Utc): Followed["bigPlay"] {
  if (plays.length > backfill) return undefined
  const until = DateTime.addDuration(now, Classifier.bigPlayHold)
  const found = plays
    .toReversed()
    .flatMap((play) => Option.toArray(Option.map(Play.bigPlay(play), (kind) => ({ play: play.id, kind, until }))))
  return found[0]
}

/** The highest moment that holds of `game`. */
function momentOf(game: Game, bigPlay: Followed["bigPlay"]): Moment {
  const { snapshot } = game
  const progress = snapshot.progress()
  if (progress === "upcoming") return { _tag: "Upcoming" }
  if (progress === "over") return { _tag: "Final" }
  if (snapshot.status === "halftime") return { _tag: "Break", reason: "halftime" }
  if (snapshot.status === "delayed") return { _tag: "Break", reason: "delay" }

  const { situation } = snapshot
  if (situation?.possession !== undefined && situation.yardLine !== undefined && situation.inRedZone())
    return { _tag: "ScoringThreat", team: situation.possession, yardsToGo: situation.yardLine }
  if (snapshot.inCrunchTime())
    return { _tag: "CrunchTime", margin: snapshot.margin(), secondsLeft: snapshot.secondsLeft() }
  if (bigPlay !== undefined) return { _tag: "BigPlay", play: bigPlay.play, kind: bigPlay.kind }

  const reason = breakReason(game)
  return reason === undefined ? { _tag: "Live" } : { _tag: "Break", reason }
}

/** Why a live game in play has stopped, if it has: its period ended, a timeout, or a score not yet kicked off from. */
function breakReason(game: Game): BreakReason | undefined {
  const { snapshot, plays } = game
  const last = plays.at(-1)
  if (!snapshot.inPlay() || (last !== undefined && Play.guards.PeriodEnd(last))) return "periodEnd"
  if (last === undefined) return undefined
  if (Play.guards.Timeout(last) || (Play.guards.Stoppage(last) && last.kind !== "coinToss")) return "timeout"

  const scored = plays.findLastIndex(({ scoring }) => scoring)
  const kickedOff = plays.findLastIndex((play) => Play.guards.Kickoff(play))
  return scored !== -1 && kickedOff < scored ? "afterScore" : undefined
}

/**
 * The moment to show, since when, and whether `candidate` was held back: the moment held, while it is the same kind or
 * outranks `candidate` and has held less than `momentHold`; otherwise `candidate`, from `now`. Not live never waits.
 */
function settled(
  had: Classification | undefined,
  candidate: Moment,
  now: DateTime.Utc
): readonly [Moment, DateTime.Utc, boolean] {
  if (had === undefined) return [candidate, now, false]
  if (had.moment._tag === candidate._tag) return [candidate, had.since, false]

  const lower = Moment.precedence(candidate, had.moment) > 0
  const notLive = candidate._tag === "Upcoming" || candidate._tag === "Final"
  const holding = DateTime.isLessThan(now, DateTime.addDuration(had.since, Classifier.momentHold))
  return lower && !notLive && holding ? [had.moment, had.since, true] : [candidate, now, false]
}

/** The earliest of `times` given. */
function earliest(times: ReadonlyArray<DateTime.Utc | undefined>): Option.Option<DateTime.Utc> {
  const given = times.filter((time) => time !== undefined)
  return Option.fromUndefinedOr(given.toSorted(DateTime.Order)[0])
}

/** How many of a game's latest plays with a win probability its swing is read from. */
const swingPlays = 3

/** More new plays than this in one take is a backfill (a game first seen), not a play just made. */
const backfill = 3
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/domain/src/Classifier.test.ts`
Expected: PASS.

- [ ] **Step 6: Glossary** — in the Automation section of `CONTEXT.md`:

```
| **Classifier** | The pure fold that classifies the slate's games, stepped by the Director after each take and when a held moment runs out; it keeps each game's pregame line, its big play for a minute, and its moment, which holds 20 s before a lower one replaces it. `Classifier` in `packages/domain/src/Classifier.ts`. | analyzer, scorer |
```

- [ ] **Step 7: Check and commit**

```bash
pnpm check
git add packages/domain/src/Classifier.ts packages/domain/src/Classifier.test.ts packages/domain/src/TestGame.ts CONTEXT.md
git commit -m "feat(domain): the classifier fold: moments held, big plays for a minute, the line kept"
```

---

### Task 6: The Director classifies

**Files:**
- Modify: `apps/hub/src/Director.ts`
- Test: `apps/hub/src/Director.test.ts`
- Modify: `CONTEXT.md` (**Director** row)

**Interfaces:**
- Consumes: `Classifier` (Task 5), `Classification` (Task 4).
- Produces: `Director` service member
  `readonly classifications: Stream.Stream<ReadonlyMap<GameId, Classification>>` — the current map, then each change.

- [ ] **Step 1: Write the failing tests** (append to `Director.test.ts`; import `completion` from TestGame, `Classification`
  type, and `TestClock` from `effect/testing`)

```ts
describe("Director#classifications", () => {
  it.effect("should classify each listed game once it is taken", () =>
    fed((frames) =>
      Effect.gen(function* () {
        yield* listing(frames, [liveSnapshot({ id: one })])

        const classified = yield* classifiedNow

        assert.strictEqual(classified.get(one)?.moment._tag, "Live")
      })
    )
  )

  it.effect("should end a big play a minute later with no new delivery", () =>
    fed((frames) =>
      Effect.gen(function* () {
        yield* listing(frames, [liveSnapshot({ id: one })])
        yield* delivered(frames, Delivery.Plays({ game: one, plays: [completion({ yards: 40 })] }))
        const during = yield* classifiedNow

        yield* TestClock.adjust("60 seconds")
        const after = yield* classifiedNow

        assert.strictEqual(during.get(one)?.moment._tag, "BigPlay")
        assert.strictEqual(after.get(one)?.moment._tag, "Live")
      })
    )
  )
})
```

Below `latest`:

```ts
/** The Director's classifications as they are now. */
const classifiedNow = Effect.yieldNow.pipe(
  Effect.andThen(Director.use((director) => Stream.runHead(director.classifications))),
  Effect.map(Option.getOrThrow)
)
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/hub/src/Director.test.ts`
Expected: FAIL — `classifications` does not exist on the Director.

- [ ] **Step 3: Change the Director** (`Director.ts`)

Service shape:

```ts
  {
    readonly slate: Stream.Stream<Slate>
    /** Each listed game's classification, by its id: the current ones, then each time a take or an expiry changes them. */
    readonly classifications: Stream.Stream<ReadonlyMap<GameId, Classification>>
  }
```

In the layer, after `const slate = …`:

```ts
      const classifier = yield* Ref.make(Classifier.empty)
      const classifications = yield* SubscriptionRef.make<ReadonlyMap<GameId, Classification>>(new Map())
      const expiry = yield* SubscriptionRef.make(Option.none<DateTime.Utc>())
      const serial = yield* Semaphore.make(1)

      const classify = Effect.fnUntraced(function* (changes: ReadonlyArray<SlateChange>) {
        const current = yield* SubscriptionRef.get(slate)
        const now = yield* DateTime.now
        const had = yield* Ref.get(classifier)
        const before = yield* SubscriptionRef.get(classifications)
        const [next, classified] = had.step(current, changes, now)

        yield* Ref.set(classifier, next)
        yield* SubscriptionRef.set(classifications, classified)
        yield* SubscriptionRef.set(expiry, next.nextExpiry())
        const moved = current.games.filter(
          ({ snapshot }) => before.get(snapshot.id)?.moment._tag !== classified.get(snapshot.id)?.moment._tag
        )
        yield* Effect.forEach(moved, ({ snapshot }) => loggedMoment(snapshot, classified.get(snapshot.id)), {
          discard: true
        })
      })
```

`take` classifies after it observes, and runs one at a time with the expiry step:

```ts
      const take = Effect.fn("Director.take")(
        function* (delivery: Delivery) {
          const before = yield* SubscriptionRef.get(slate)
          const [next, changes] = Delivery.$match(delivery, {
            Listing: ({ league, games }) => before.relisted(league, games),
            Plays: ({ game, plays }) => before.playsTaken(game, plays)
          })
          if (next === before) return

          yield* SubscriptionRef.set(slate, next)
          yield* Effect.forEach(changes, observed, { discard: true })
          yield* classify(changes)
        },
        serial.withPermits(1),
        Effect.catchDefect((defect) =>
          Effect.logError("Director: a take raised a defect; the slate keeps what it had", Cause.die(defect))
        )
      )

      const expire = Effect.fn("Director.expire")(
        function* () {
          yield* classify([])
        },
        serial.withPermits(1),
        Effect.catchDefect((defect) =>
          Effect.logError("Director: classifying at an expiry raised a defect", Cause.die(defect))
        )
      )
```

After the existing `Effect.forkScoped(provider.deliveries…)`:

```ts
      const expiries = SubscriptionRef.changes(expiry).pipe(
        Stream.switchMap(
          Option.match({ onNone: () => Stream.never, onSome: (at) => Stream.fromEffect(sleptUntil(at)) })
        )
      )
      yield* Effect.forkScoped(Stream.runForEach(expiries, expire), { startImmediately: true })

      return Director.of({
        slate: SubscriptionRef.changes(slate),
        classifications: SubscriptionRef.changes(classifications)
      })
```

Below `observed` (and its helpers), add:

```ts
/** Sleeps until `at`, at once when it has passed. */
const sleptUntil = Effect.fnUntraced(function* (at: DateTime.Utc) {
  const now = yield* DateTime.now

  yield* Effect.sleep(Duration.max(DateTime.distance(now, at), Duration.zero))
})

function loggedMoment(snapshot: GameSnapshot, classification: Classification | undefined) {
  if (classification === undefined) return Effect.void
  const matchup = snapshot.matchup()
  return Effect.logInfo(`Director: ${matchup} ${classification.moment._tag} (${classification.score})`).pipe(
    Effect.annotateLogs({ game: snapshot.id, league: snapshot.league, matchup, moment: classification.moment._tag })
  )
}
```

Imports: `Classification` from `@sportal/domain/Classification`, `Classifier` from `@sportal/domain/Classifier`,
`type GameId` from `@sportal/domain/Game`, and `Duration, Option, Ref, Semaphore` from `effect`.

- [ ] **Step 4: Run the Director, Broadcast and server tests**

Run: `pnpm vitest run apps/hub/src`
Expected: PASS (the two new tests included).

- [ ] **Step 5: Glossary** — in the **Director** row, replace "Automation, planned, will publish a ranking of games."
  with: "It classifies the slate with its Classifier after each take and when a held moment runs out, logs each game's
  new moment, and offers the classifications beside the slate."

- [ ] **Step 6: Check and commit**

```bash
pnpm check
git add apps/hub/src/Director.ts apps/hub/src/Director.test.ts CONTEXT.md
git commit -m "feat(hub): the Director classifies the slate and offers the classifications"
```

---

### Task 7: Classifications on the live stream

**Files:**
- Modify: `packages/api/src/LiveMessage.ts`
- Modify: `apps/hub/src/Broadcast.ts`
- Test: `apps/hub/src/Broadcast.test.ts`
- Modify: `apps/web/src/TestWeb.ts` (`slateMessage`), `apps/web/src/hub/LiveStream.test.ts` (any literal message)
- Modify: `CONTEXT.md` (**Slate changed**, **Live message**)

**Interfaces:**
- Consumes: `Director.classifications` (Task 6).
- Produces: `SlateChanged.classifications: Record<GameId, Classification>` — one entry per listed game.

- [ ] **Step 1: Write the failing test** (in `Broadcast.test.ts`, beside "should publish every source's availability
  for each game, by its id"; follow that test's arrangement exactly, reading its message the same way)

```ts
    it.effect("should publish each listed game's classification, by its id", () =>
      broadcasting((frames) =>
        Effect.gen(function* () {
          const listed = snapshot({ id: GameId.make("1"), status: "live", period: 1, clock: "10:00" })

          const message = yield* publishedAfter(frames, [Delivery.Listing({ league: "fbs", games: [listed] })])

          assert.strictEqual(message.classifications[GameId.make("1")]?.moment._tag, "Live")
        })
      )
    )
```

(`broadcasting`'s second argument, the source layer, has a default in this file; if it does not, pass the same
`Source.layerTest(() => ({ _tag: "NotCarried", why: "StreamingOnly" }))` the sharing test uses.)

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/hub/src/Broadcast.test.ts`
Expected: FAIL — no `classifications` on the message (type error or undefined).

- [ ] **Step 3: Add the field to the wire** (`LiveMessage.ts`)

```ts
  /**
   * The slate, each game with its recent plays, and each listed game's availability from every source and its
   * classification, by its id.
   */
  SlateChanged: {
    slate: Slate,
    availability: Schema.Record(GameId, Schema.Array(ChannelAvailability)),
    classifications: Schema.Record(GameId, Classification)
  }
```

(import `Classification` from `@sportal/domain/Classification`.)

- [ ] **Step 4: Join it in Broadcast** (`Broadcast.ts`)

```ts
      const classified = Stream.zipLatest(director.slate, director.classifications)
      const messages = yield* Stream.zipLatest(settled(classified), Stream.tick("30 seconds")).pipe(
        Stream.mapEffect(([[slate, classifiedNow]]) =>
          Effect.gen(function* () {
            const availabilityOf = yield* source.availability
            const now = yield* DateTime.now

            const availability = Record.fromEntries(
              slate.games.map(({ snapshot }) => [snapshot.id, availabilityOf(snapshot, now)] as const)
            )
            const classifications = Record.fromEntries(
              slate.games.flatMap(({ snapshot }) => {
                const classification = classifiedNow.get(snapshot.id)
                return classification === undefined ? [] : [[snapshot.id, classification] as const]
              })
            )
            return {
              _tag: "SlateChanged",
              slate: slate.recent(),
              availability,
              classifications
            } satisfies SlateChanged
          })
        ),
```

(the rest of the pipe is unchanged.) A game the classifier has not reached yet is left out, so the message never
names a game its slate lacks.

- [ ] **Step 5: Give the web's test messages the field.** In `TestWeb.slateMessage`, add
  `classifications: {}` to the encoded message; in `LiveStream.test.ts`, add `classifications: {}` to any literal
  `SlateChanged` it builds that is meant to decode (leave the deliberately broken `slate: "nope"` one as it is).

- [ ] **Step 6: Run the hub and web tests**

Run: `pnpm vitest run apps/hub/src apps/web/src`
Expected: PASS.

- [ ] **Step 7: Glossary** — **Slate changed**: after "each listed game's availability from every source by its id,"
  add "and its classification by its id,". **Live message**: "the slate changed, each game beside its availability and
  its classification".

- [ ] **Step 8: Check and commit**

```bash
pnpm check
git add packages/api/src/LiveMessage.ts apps/hub/src/Broadcast.ts apps/hub/src/Broadcast.test.ts apps/web/src/TestWeb.ts apps/web/src/hub/LiveStream.test.ts CONTEXT.md
git commit -m "feat: classifications on the live stream, beside availability"
```

---

### Task 8: The web: Live ordered by score, moment badges

**Files:**
- Modify: `apps/web/src/hub/LiveStream.ts`
- Modify: `apps/web/src/slate/StripCard.ts`, `apps/web/src/slate/StripCard.test.ts`
- Modify: `apps/web/src/display/DisplayState.ts` (`cards`), `apps/web/src/display/Display.test.ts` (calls of
  `StripCard.of`)
- Create: `apps/web/src/game/MomentBadge.tsx`
- Modify: `apps/web/src/slate/SlateView.tsx` (`Card`), `apps/web/src/screen/TileChrome.tsx`,
  `apps/web/src/screen/ScreenView.tsx`
- Modify: `CONTEXT.md` (**Strip card**)

**Interfaces:**
- Consumes: `SlateChanged.classifications` (Task 7), `Classification` (Task 4).
- Produces: `Live.classifications`; `StripCard.classification: Classification | undefined`;
  `StripCard.of(screen: Screen, slate: Slate, classifications: SlateChanged["classifications"])`;
  `<MomentBadge classification={…} className?={…} />`.

- [ ] **Step 1: Write the failing StripCard tests** (append to `StripCard.test.ts`; import `Classification` and
  `DateTime`; use `TestWeb.slate`'s live games)

```ts
describe("StripCard.of, ordering", () => {
  it("should order the live games by score, highest first", () => {
    const live = TestWeb.slate.games.filter(({ snapshot }) => snapshot.progress() === "live").map(({ snapshot }) => snapshot.id)
    const scores = Object.fromEntries(live.map((id, index) => [id, scored(10 + index * 10)]))

    const ordered = StripCard.of(Screen.initial, TestWeb.slate, scores)
      .filter(({ section }) => section === "Live")
      .map(({ id }) => id)

    assert.deepStrictEqual(ordered, live.toReversed())
  })

  it("should keep the upcoming games in kickoff order whatever their scores", () => {
    const next = StripCard.of(Screen.initial, TestWeb.slate, {}).filter(({ section }) => section === "Next").map(({ id }) => id)
    const scores = Object.fromEntries(next.map((id, index) => [id, scored(90 - index * 10)]))

    const ordered = StripCard.of(Screen.initial, TestWeb.slate, scores)
      .filter(({ section }) => section === "Next")
      .map(({ id }) => id)

    assert.deepStrictEqual(ordered, next)
  })
})

function scored(score: number): Classification {
  return new Classification({
    moment: { _tag: "Live" },
    score,
    since: DateTime.makeUnsafe("2026-10-10T20:00:00Z"),
    breakdown: { prior: 0, closeness: score, swing: 0, upset: 0, momentBonus: 0 }
  })
}
```

If `TestWeb.slate` has fewer than two live games, add one to it (a second `liveSnapshot` with its own id) in
`TestWeb.ts` first, and check the existing StripCard and Display tests still pass.

Update the existing `StripCard.of(…, TestWeb.slate)` calls in `StripCard.test.ts` and `Display.test.ts` to pass `{}`
as the third argument.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/web/src/slate/StripCard.test.ts`
Expected: FAIL — `StripCard.of` takes two arguments, and the live cards are in watch order.

- [ ] **Step 3: StripCard carries and orders by its classification** (`StripCard.ts`)

Add the field and the order (import `Classification` type, `Order` from `effect`, `SlateChanged` type from
`@sportal/api/LiveMessage`):

```ts
export class StripCard extends Data.Class<{
  readonly id: GameId
  readonly game: GameSnapshot | undefined
  readonly place: Place | undefined
  readonly section: "Bench" | "Live" | "Next" | "Final"
  readonly classification: Classification | undefined
}> {
  /**
   * The strip's cards, in order: the bench, then the slate live by score (highest first), upcoming, and over. A
   * benched game shows once, on the bench, even when it has left the slate. A game on screen keeps its place in the
   * slate, marked with its slot.
   */
  static of(
    screen: Screen,
    slate: Slate,
    classifications: SlateChanged["classifications"]
  ): ReadonlyArray<StripCard> {
```

Set `classification: classifications[game]` on bench cards and `classification: classifications[game.id]` on the
rest, and sort the rest after mapping:

```ts
      .map((game) => {
        const slot = screen.slotOf(game.id)
        const place = slot === undefined ? undefined : Place.Slot({ slot })
        const classification = classifications[game.id]
        return new StripCard({ id: game.id, game, place, section: sections[game.progress()], classification })
      })
      .toSorted(liveByScore)
```

Below `sections`:

```ts
// Live cards by score, highest first; the sort is stable, so every other card keeps the watch order.
const liveByScore = Order.mapInput(Order.flip(Order.Number), (card: StripCard) =>
  card.section === "Live" ? (card.classification?.score ?? 0) : 0
)
```

This is one consistent key per card (a live card's score, every other card 0), so the sort is well defined.
`GameSnapshot.watchOrder` already put the live cards first; a live card scoring above 0 stays ahead of every non-live
card, and the stable sort keeps any ties (including a live card scoring 0) in watch order.

In `DisplayState.ts`:

```ts
export const cards: Atom.Atom<ReadonlyArray<StripCard>> = Atom.make((get) => {
  const live = get(LiveStream.live)
  return StripCard.of(get(DisplayScreen.screen), live.slate, live.classifications)
})
```

In `LiveStream.ts`: add `readonly classifications: SlateChanged["classifications"]` (doc comment: "Each listed game's
classification, by its id.") to `Live`, `classifications: {}` to `initial()`, and take it in `received`:

```ts
    SlateChanged: ({ slate, availability, classifications }): Live => ({ ...live, slate, availability, classifications })
```

- [ ] **Step 4: Run the web tests**

Run: `pnpm vitest run apps/web/src`
Expected: PASS.

- [ ] **Step 5: The badge** (`apps/web/src/game/MomentBadge.tsx`)

```tsx
import type { Classification } from "@sportal/domain/Classification"
import { Flag, Timer, Zap } from "lucide-react"
import { cn } from "@/design/ClassName"

/**
 * A game's moment as a small mark — a flag in the red zone, a clock in crunch time, a bolt after a big play, BRK in a
 * break — titled with its score and the points each part gave it. Nothing for plain live play or a game not live.
 */
export function MomentBadge(props: { classification: Classification | undefined; className?: string }) {
  const { classification } = props
  if (classification === undefined) return null
  const mark = markOf(classification)
  if (mark === null) return null

  const { prior, closeness, swing, upset, momentBonus } = classification.breakdown
  const title = `Score ${classification.score}: matchup ${points(prior)}, closeness ${points(closeness)}, swing ${points(swing)}, upset ${points(upset)}, moment ${points(momentBonus)}`
  return (
    <span title={title} className={cn("inline-flex shrink-0 items-center", props.className)}>
      {mark}
    </span>
  )
}

function markOf(classification: Classification) {
  switch (classification.moment._tag) {
    case "ScoringThreat":
      return <Flag aria-label="Red zone" className="size-3 text-on-air" />
    case "CrunchTime":
      return <Timer aria-label="Crunch time" className="size-3 text-on-air" />
    case "BigPlay":
      return <Zap aria-label="Big play" className="size-3 text-on-air" />
    case "Break":
      return <span className="label-caps text-[9px] text-muted-foreground">BRK</span>
    case "Live":
    case "Upcoming":
    case "Final":
      return null
  }
}

function points(value: number): string {
  return `${value >= 0 ? "+" : ""}${Math.round(value)}`
}
```

AGENTS.md bans `_tag ===`; a `switch` on `_tag` is how the web's components already branch where `$match` would need a
`Data.taggedEnum`. If `pnpm check` (Biome/tsgo) objects, use `Moment.match(classification.moment, {…})` from
`@sportal/domain/Moment` instead, with the same cases.

- [ ] **Step 6: Show it.** In `SlateView.tsx`'s `Card`, destructure `classification` from `props.card` and put
  `<MomentBadge classification={classification} />` just before the networks `<span>` inside the last column. In
  `TileChrome.tsx`, add a `classification: Classification | undefined` prop and render
  `<MomentBadge classification={props.classification} className="ml-1" />` right after `<GameStatus … />`. In
  `ScreenView.tsx`, read `const { slate, classifications } = useAtomValue(LiveStream.live)` and pass
  `classification={game === undefined ? undefined : classifications[game.snapshot.id]}` to `TileChrome`.

- [ ] **Step 7: Glossary** — **Strip card**: after "in its section (Bench, Live, Next, Final)," add "the Live section
  ordered by classification score, highest first, each card with its moment badge,".

- [ ] **Step 8: Check and commit**

```bash
pnpm check
git add apps/web/src CONTEXT.md
git commit -m "feat(web): live games ordered by score, each with its moment badge"
```

- [ ] **Step 9: Eye-check on the live slate.** Run `pnpm dev`, wait for the first poll, and confirm in the Hub log
  lines like `Director: OSU at IOWA ScoringThreat (71)` and in the web strip that Live is ordered by score and badges
  show. Hover a badge to see the breakdown. Report what you saw; do not claim it works without looking.

---

## Self-review notes

- Spec coverage: new feed data (Tasks 1–2), Moment and precedence (4), big plays (3), Classification and scoring (4),
  Classifier with hysteresis, expiry and the kept line (5), Director with timer and log (6), wire (7), web (8),
  glossary in each, ranking statements (4), tests per the spec's Testing section. Tuning is a game-day activity, not a
  task.
- The breakdown is in score points and adds up to the score before rounding and clamping, as the spec says.
