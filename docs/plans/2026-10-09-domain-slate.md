# Domain Slate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the slate one domain type that the Hub folds, the live stream sends, and the web holds.

**Architecture:** `Slate` moves from `apps/hub/src/Slate.ts` to `packages/domain/src/Slate.ts` as a `Schema.Class` with
Delivery-free operations (`relisted`, `playsTaken`, `recent`) and `SlateChange` beside it. The Director reduces each
frame's `Delivery`s onto those operations. `SlateChanged` then carries `{ slate, availability }` and the web keeps both
as decoded.

**Tech Stack:** TypeScript 7 (tsgo), Effect 4 (`Schema`, `Data`, `Record`), `@effect/vitest`, pnpm workspaces.

**Spec:** `docs/specs/2026-10-09-domain-slate-design.md`

## Global Constraints

- Read `AGENTS.md` first. Every rule there applies: module shapes, order inside a file, one spelling per kind, test style
  (`it("should …")`, AAA separated by blank lines, one behaviour per test).
- `packages/domain` imports only Effect.
- `pnpm check` must pass before every commit (format, lint, typecheck, depcruise, knip, tests).
- A rewritten test file keeps every assertion; the commit body maps each old test name to its new one.
- Behaviour, logs, metrics, span names, settling, and replay of the live stream do not change.
- Availability stays evaluated once per published message (frozen at send time).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Task | Change |
|---|---|---|
| `packages/domain/src/Slate.ts` | 1 | Create: `Slate`, `SlateChange` |
| `packages/domain/src/Slate.test.ts` | 1 | Create: moved and rewritten from the Hub's |
| `apps/hub/src/Slate.ts`, `apps/hub/src/Slate.test.ts` | 1 | Delete |
| `apps/hub/src/Director.ts` | 1 | Reduce deliveries onto the domain operations |
| `apps/hub/src/Director.test.ts` | 1 | Import the domain Slate; add the two frame tests |
| `CONTEXT.md`, `docs/technical-spec.md` | 1, 2 | Follow the move, then the wire change |
| `packages/api/src/LiveMessage.ts`, `LiveMessage.test.ts` | 2 | `SlateChanged { slate, availability }` |
| `apps/hub/src/HubServer.ts`, `HubServer.test.ts` | 2 | Build and assert the new message |
| `apps/web/src/hub/LiveStream.ts`, `LiveStream.test.ts`, `TestLiveStream.ts` | 2 | `Live { connection, slate, availability }` |
| `apps/web/src/screen/DisplayScreen.ts`, `DisplayScreen.test.ts` | 2 | Record lookup |
| `apps/web/src/display/DisplayView.tsx` | 2 | `live.slate.games` |

---

### Task 1: Slate moves to domain

The domain Slate is unused by production until the Director imports it, and knip fails on an unused file, so the move,
the Director change, and the deletion land in one commit.

**Files:**
- Create: `packages/domain/src/Slate.ts`
- Create: `packages/domain/src/Slate.test.ts`
- Delete: `apps/hub/src/Slate.ts`, `apps/hub/src/Slate.test.ts`
- Modify: `apps/hub/src/Director.ts`
- Modify: `apps/hub/src/Director.test.ts`
- Modify: `CONTEXT.md` (rows **Slate**, **Slate change**)
- Modify: `docs/technical-spec.md` (domain tree, Hub tree, Slate paragraph)

**Interfaces:**
- Produces (Task 2 relies on): `import { Slate, SlateChange } from "@sportal/domain/Slate"`;
  `Slate.empty: Slate`; `slate.games: ReadonlyArray<Game>`;
  `slate.relisted(league: LeagueId, snapshots: ReadonlyArray<GameSnapshot>): readonly [Slate, ReadonlyArray<SlateChange>]`;
  `slate.playsTaken(game: GameId, plays: ReadonlyArray<Play>): readonly [Slate, ReadonlyArray<SlateChange>]`;
  `slate.recent(): Slate`; `new Slate({ games })`.

- [ ] **Step 1: Write the domain tests**

Create `packages/domain/src/Slate.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, DateTime, Option } from "effect"
import { type Game, GameId, type GameSnapshot } from "./Game.ts"
import type { LeagueId } from "./League.ts"
import { type Play, PlayId } from "./Play.ts"
import { Slate, SlateChange } from "./Slate.ts"
import { broadcast, completion, play, situation, snapshot, team } from "./TestGame.ts"

const t0 = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
const one = GameId.make("1")
const two = GameId.make("2")
const three = GameId.make("3")

describe("Slate.empty", () => {
  it("should hold no game", () => {
    assert.deepStrictEqual(Slate.empty.games, [])
  })
})

describe("Slate#relisted", () => {
  it("should take each game it names", () => {
    const game = live(one, "10:00")

    const next = Slate.empty.relisted("fbs", [game])[0]

    assert.strictEqual(snapshotIn(next, one), game)
  })

  it("should keep the listing's games in its order", () => {
    const games = [live(three, "10:00"), live(one, "10:00"), live(two, "10:00")]

    const next = Slate.empty.relisted("fbs", games)[0]

    assert.deepStrictEqual(idsIn(next, "fbs"), [three, one, two])
  })

  it("should take a game it names however far it is from kickoff", () => {
    const later = snapshot({ id: two, kickoff: DateTime.add(t0, { hours: 3 }) })

    const next = Slate.empty.relisted("fbs", [later])[0]

    assert.deepStrictEqual(idsIn(next, "fbs"), [two])
    assert.strictEqual(snapshotIn(next, two), later)
  })

  it("should forget the league's games it no longer names, with their plays", () => {
    const slate = listed(live(one, "10:00"), live(two, "5:00")).playsTaken(two, playsOf(2))[0]

    const next = slate.relisted("fbs", [live(one, "9:00")])[0]

    assert.deepStrictEqual(idsIn(next, "fbs"), [one])
    assert.isUndefined(snapshotIn(next, two))
    assert.deepStrictEqual(playsIn(next, two), [])
  })

  it("should keep another league's games", () => {
    const nfl = snapshot({ id: two, league: "nfl", status: "live", period: 1 })
    const slate = listed(live(one, "10:00")).relisted("nfl", [nfl])[0]

    const next = slate.relisted("fbs", [])[0]

    assert.strictEqual(snapshotIn(next, two), nfl)
    assert.deepStrictEqual(idsIn(next, "nfl"), [two])
  })

  it("should take a named game ahead of the slate's", () => {
    const slate = listed(live(one, "10:00"))
    const ahead = live(one, "9:00")

    const next = slate.relisted("fbs", [ahead])[0]

    assert.strictEqual(snapshotIn(next, one), ahead)
  })

  it("should keep the slate's game over a named one behind it, still listing it", () => {
    const slate = listed(snapshot({ id: one, status: "live", period: 2 }))

    const next = slate.relisted("fbs", [live(one, "10:00")])[0]

    assert.strictEqual(snapshotIn(next, one), snapshotIn(slate, one))
    assert.deepStrictEqual(idsIn(next, "fbs"), [one])
  })

  it("should take a later listing at the same clock and score, for its new down and ball", () => {
    const slate = listed(withBall(live(one, "10:00"), 60))

    const next = slate.relisted("fbs", [withBall(live(one, "10:00"), 45)])[0]

    assert.strictEqual(next.games[0]?.snapshot.situation?.yardLine, 45)
  })

  it("should take an upcoming game named at the same game time", () => {
    const slate = listed(snapshot({ id: one }))
    const televised = snapshot({ id: one, broadcasts: [broadcast("ESPN")] })

    const next = slate.relisted("fbs", [televised])[0]

    assert.strictEqual(snapshotIn(next, one), televised)
  })

  it("should give back the slate itself for the same listing again", () => {
    const game = live(one, "10:00")
    const slate = listed(game)

    const next = slate.relisted("fbs", [game])[0]

    assert.strictEqual(next, slate)
  })

  it("should hold no plays for a game just listed", () => {
    const next = Slate.empty.relisted("fbs", [live(one, "10:00")])[0]

    assert.deepStrictEqual(playsIn(next, one), [])
  })

  it("should keep a game's plays when it takes its snapshot", () => {
    const first = play()
    const slate = listed(live(one, "10:00")).playsTaken(one, [first])[0]

    const next = slate.relisted("fbs", [live(one, "9:00")])[0]

    assert.deepStrictEqual(playsIn(next, one), [first])
  })
})

describe("Slate#relisted, a later listing", () => {
  it("should take one at its game's game time with more points", () => {
    const slate = listed(scoredAt("4:12", 13))

    const next = slate.relisted("fbs", [scoredAt("4:12", 14)])[0]

    assert.strictEqual(snapshotIn(next, one)?.home.score, 14)
  })

  it("should take a poll at the same game time with fewer points as behind, giving back the slate itself", () => {
    const slate = listed(scoredAt("4:12", 14))

    const next = slate.relisted("fbs", [scoredAt("4:12", 13)])[0]

    assert.strictEqual(next, slate)
  })
})

describe("Slate#relisted, a game the slate has over", () => {
  const home = (score: number) => ({ team: team("HOME"), score })
  const playing = snapshot({
    id: one,
    league: "nfl",
    status: "live",
    period: 4,
    clock: "0:39",
    home: home(26)
  })
  const final = snapshot({ ...playing, status: "final", clock: "0:00" })
  const finished = Slate.empty.relisted("nfl", [playing])[0].relisted("nfl", [final])[0]

  it("should keep its final over a lagging listing", () => {
    const next = finished.relisted("nfl", [playing])[0]

    assert.deepStrictEqual(snapshotsIn(next, "nfl"), [final])
    assert.strictEqual(next, finished)
  })

  it("should give back the slate itself when the listing catches up to its final", () => {
    const lagged = finished.relisted("nfl", [playing])[0]

    const next = lagged.relisted("nfl", [final])[0]

    assert.strictEqual(next, lagged)
    assert.deepStrictEqual(snapshotsIn(next, "nfl"), [final])
  })

  it("should take overtime after the final", () => {
    const overtime = snapshot({ ...playing, period: 5, clock: "15:00" })

    const next = finished.relisted("nfl", [overtime])[0]

    assert.deepStrictEqual(snapshotsIn(next, "nfl"), [overtime])
    assert.strictEqual(snapshotIn(next, one)?.progress(), "live")
  })

  it("should take a corrected score of its final", () => {
    const corrected = snapshot({ ...final, home: home(27) })

    const next = finished.relisted("nfl", [corrected])[0]

    assert.deepStrictEqual(snapshotsIn(next, "nfl"), [corrected])
  })

  it("should take a postponed game resuming", () => {
    const slate = listed(snapshot({ id: two, status: "postponed" }))
    const resumed = live(two, "15:00")

    const next = slate.relisted("fbs", [resumed])[0]

    assert.strictEqual(snapshotIn(next, two), resumed)
  })
})

describe("Slate#playsTaken", () => {
  const first = play()
  const second = completion({
    id: PlayId.make("2"),
    sequence: 2,
    scoring: true,
    homeScore: 7,
    touchdown: true
  })
  const withFirst = listed(live(one, "10:00")).playsTaken(one, [first])[0]

  it("should replace the list, in Play.order", () => {
    const next = withFirst.playsTaken(one, [second, first])[0]

    assert.deepStrictEqual(playsIn(next, one), [first, second])
  })

  it("should keep the snapshot when plays are taken", () => {
    const next = withFirst.playsTaken(one, [first, second])[0]

    assert.deepStrictEqual(snapshotIn(next, one), live(one, "10:00"))
  })

  it("should give back the slate itself for an identical list", () => {
    const next = withFirst.playsTaken(one, [first])[0]

    assert.strictEqual(next, withFirst)
  })

  it("should give back the slate itself for an equal list of equal plays", () => {
    const next = withFirst.playsTaken(one, [play()])[0]

    assert.strictEqual(next, withFirst)
  })

  it("should drop a play removed from the list", () => {
    const both = withFirst.playsTaken(one, [first, second])[0]

    const next = both.playsTaken(one, [first])[0]

    assert.deepStrictEqual(playsIn(next, one), [first])
  })

  it("should drop plays of a game no listing names, giving back the slate itself", () => {
    const next = Slate.empty.playsTaken(one, [play()])[0]

    assert.strictEqual(next, Slate.empty)
  })
})

describe("Slate#games", () => {
  const listedFbs = snapshot({ id: one, status: "live", period: 1, clock: "10:00" })
  const listedNfl = snapshot({ id: two, league: "nfl", kickoff: DateTime.add(t0, { hours: 3 }) })
  const later = live(one, "9:00")

  it("should hold each game as the slate has it in place of the listed one", () => {
    const slate = listed(listedFbs).relisted("fbs", [later])[0]

    assert.deepStrictEqual(snapshotsIn(slate, "fbs"), [later])
  })

  it("should keep the leagues in their order, whatever order they were listed in", () => {
    const slate = listed(listedFbs).relisted("nfl", [listedNfl])[0]

    const ids = slate.games.map(({ snapshot }) => snapshot.id)

    assert.deepStrictEqual(ids, [two, one])
  })

  it("should keep the same game for one an operation does not change", () => {
    const slate = listed(listedFbs).relisted("nfl", [listedNfl])[0]

    const next = slate.relisted("fbs", [later])[0]

    assert.strictEqual(next.games[0], slate.games[0])
  })
})

describe("Slate#relisted, its changes", () => {
  it("should give a game a listing names for the first time as Progressed", () => {
    const game = live(one, "10:00")

    const [next, changes] = Slate.empty.relisted("fbs", [game])

    assert.deepStrictEqual(changes, [SlateChange.Progressed({ game: gameIn(next, one) })])
  })

  it("should give a listed game whose snapshot it takes as Progressed", () => {
    const slate = listed(live(one, "10:00"))

    const [next, changes] = slate.relisted("fbs", [live(one, "9:00")])

    assert.deepStrictEqual(changes, [SlateChange.Progressed({ game: gameIn(next, one) })])
  })

  it("should give a game its league's listing no longer names as Delisted", () => {
    const slate = listed(live(one, "10:00"), live(two, "10:00"))

    const [, changes] = slate.relisted("fbs", [live(one, "10:00")])

    assert.deepStrictEqual(changes, [SlateChange.Delisted({ game: gameIn(slate, two) })])
  })

  it("should give no change for a listing that changes nothing", () => {
    const game = live(one, "10:00")
    const slate = listed(game)

    const [, changes] = slate.relisted("fbs", [game])

    assert.deepStrictEqual(changes, [])
  })
})

describe("Slate#playsTaken, its changes", () => {
  it("should give each play it adds as Played, in Play.order", () => {
    const slate = listed(live(one, "10:00"))

    const [next, changes] = slate.playsTaken(one, playsOf(2))

    const game = gameIn(next, one)
    assert.deepStrictEqual(
      changes,
      game.plays.map((play) => SlateChange.Played({ game, play }))
    )
  })

  it("should give no Progressed for a game whose plays alone change", () => {
    const slate = listed(live(one, "10:00"))

    const [, changes] = slate.playsTaken(one, playsOf(1))

    assert.isTrue(changes.some(SlateChange.$is("Played")))
    assert.isFalse(changes.some(SlateChange.$is("Progressed")))
  })
})

describe("Slate#recent", () => {
  it("should keep each game's last ten plays", () => {
    const slate = listed(live(one, "10:00")).playsTaken(one, playsOf(12))[0]

    const next = slate.recent()

    assert.deepStrictEqual(
      playsIn(next, one).map(({ sequence }) => sequence),
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    )
  })

  it("should give back the slate itself when no game has more than ten plays", () => {
    const slate = listed(live(one, "10:00")).playsTaken(one, playsOf(10))[0]

    const next = slate.recent()

    assert.strictEqual(next, slate)
  })
})

/** Game `id`'s snapshot, as `slate` has it. */
function snapshotIn(slate: Slate, id: GameId): GameSnapshot | undefined {
  return slate.games.find(({ snapshot }) => snapshot.id === id)?.snapshot
}

/** Game `id`, as `slate` has it; the test fails when the slate lacks it. */
function gameIn(slate: Slate, id: GameId): Game {
  return Option.getOrThrow(Arr.findFirst(slate.games, ({ snapshot }) => snapshot.id === id))
}

/** Game `id`'s plays, as `slate` has them; none for a game it does not have. */
function playsIn(slate: Slate, id: GameId): ReadonlyArray<Play> {
  return slate.games.find(({ snapshot }) => snapshot.id === id)?.plays ?? []
}

/** League `league`'s games, as `slate` has them, in order. */
function snapshotsIn(slate: Slate, league: LeagueId): ReadonlyArray<GameSnapshot> {
  return slate.games.filter(({ snapshot }) => snapshot.league === league).map(({ snapshot }) => snapshot)
}

/** The ids of league `league`'s games, in order. */
function idsIn(slate: Slate, league: LeagueId): ReadonlyArray<GameId> {
  return snapshotsIn(slate, league).map(({ id }) => id)
}

/** The empty slate taking an FBS listing of `games`. */
function listed(...games: ReadonlyArray<GameSnapshot>) {
  return Slate.empty.relisted("fbs", games)[0]
}

/** `count` plays, sequenced from 1 and handed over out of order. */
function playsOf(count: number): ReadonlyArray<Play> {
  return Array.from({ length: count }, (_, index) =>
    play({ id: PlayId.make(`p${index + 1}`), sequence: index + 1 })
  ).toReversed()
}

function live(id: GameId, clock: string): GameSnapshot {
  return snapshot({ id, status: "live", period: 1, clock })
}

/** Game one live in the second period at `clock`, with `score` for HOME. */
function scoredAt(clock: string, score: number): GameSnapshot {
  return snapshot({ id: one, status: "live", period: 2, clock, home: { team: team("HOME"), score } })
}

/** `game` with the ball `yardLine` yards from the goal. */
function withBall(game: GameSnapshot, yardLine: number): GameSnapshot {
  return snapshot({ ...game, situation: situation({ yardLine }) })
}
```

- [ ] **Step 2: Run the domain tests to see them fail**

Run: `pnpm vitest run packages/domain/src/Slate.test.ts`
Expected: FAIL, `Cannot find module './Slate.ts'` (or the equivalent resolve error).

- [ ] **Step 3: Write the domain Slate**

Create `packages/domain/src/Slate.ts`:

```ts
import { Data, Schema } from "effect"
import { Game, type GameId, type GameSnapshot } from "./Game.ts"
import { LeagueId } from "./League.ts"
import type { Play } from "./Play.ts"

/**
 * The slate: the games each league's last listing names, in its order, each with its latest snapshot not behind the one
 * before it and its plays. Pure: each operation returns the next slate and what it changed; one that changes nothing
 * gives back this slate itself and no change, and a game it does not change stays the same `Game`.
 */
export class Slate extends Schema.Class<Slate>("sportal/Slate")({
  /** The listed games: leagues in `LeagueId.literals` order, each league's in its listing's order. */
  games: Schema.Array(Game)
}) {
  static readonly empty: Slate = new Slate({ games: [] })

  /**
   * League `league` listing `snapshots`: its games, in their order, each taken into the game the slate had
   * (`Game#snapshotTaken`) or new; each game it no longer names is delisted.
   */
  relisted(league: LeagueId, snapshots: ReadonlyArray<GameSnapshot>): Taken {
    const had = this.games.filter((game) => game.snapshot.league === league)
    const taken = snapshots.map((snapshot) => {
      const before = had.find((each) => each.snapshot.id === snapshot.id)
      return { before, game: before === undefined ? Game.of(snapshot) : before.snapshotTaken(snapshot) }
    })
    const listed = taken.map(({ game }) => game)
    if (listed.length === had.length && listed.every((game, index) => game === had[index])) return [this, []]

    const games = LeagueId.literals.flatMap((each) =>
      each === league ? listed : this.games.filter((game) => game.snapshot.league === each)
    )
    const delisted = had
      .filter((game) => !listed.some((each) => each.snapshot.id === game.snapshot.id))
      .map((game) => SlateChange.Delisted({ game }))
    const changed = taken.flatMap(({ before, game }) => changesOf(before, game))
    return [new Slate({ games }), [...delisted, ...changed]]
  }

  /** Game `id`'s whole list of plays, `plays`, taken into it (`Game#playsTaken`); dropped when the slate lacks it. */
  playsTaken(id: GameId, plays: ReadonlyArray<Play>): Taken {
    const index = this.games.findIndex((game) => game.snapshot.id === id)
    const had = this.games[index]
    if (had === undefined) return [this, []]

    const next = had.playsTaken(plays)
    if (next === had) return [this, []]

    return [new Slate({ games: this.games.with(index, next) }), changesOf(had, next)]
  }

  /** This slate with each game's recent plays only (`Game#recent`): what the live stream sends. */
  recent(): Slate {
    const games = this.games.map((game) => game.recent())
    if (games.every((game, index) => game === this.games[index])) return this

    return new Slate({ games })
  }
}

/** One thing an operation changed: a game's snapshot, a game no listing names any more, or a play a game did not have. */
export type SlateChange = Data.TaggedEnum<{
  /** A listed game's snapshot changed, or a listing named it for the first time. */
  Progressed: { readonly game: Game }
  /** No listing of its league names it any more. */
  Delisted: { readonly game: Game }
  /** A play its game did not have before. */
  Played: { readonly game: Game; readonly play: Play }
}>
export const SlateChange = Data.taggedEnum<SlateChange>()

/** The next slate, and what an operation changed to reach it. */
type Taken = readonly [Slate, ReadonlyArray<SlateChange>]

/** What `next` changed of `had`, none when the slate did not have it: its snapshot, then each play it added. */
function changesOf(had: Game | undefined, next: Game): ReadonlyArray<SlateChange> {
  if (had === next) return []

  const progressed = had?.snapshot === next.snapshot ? [] : [SlateChange.Progressed({ game: next })]
  const played = next
    .playsAfter(had ?? Game.of(next.snapshot))
    .map((play) => SlateChange.Played({ game: next, play }))
  return [...progressed, ...played]
}
```

- [ ] **Step 4: Run the domain tests to see them pass**

Run: `pnpm vitest run packages/domain/src/Slate.test.ts`
Expected: PASS, 37 tests.

- [ ] **Step 5: Add the Director's frame tests**

In `apps/hub/src/Director.test.ts`, change the import `import { Slate } from "./Slate.ts"` to
`import { Slate } from "@sportal/domain/Slate"` (keep import order: it goes after `@sportal/domain/Play`). Then add this
`describe` directly after the `describe("Director#slate", …)` block:

```ts
describe("Director, a frame", () => {
  it.effect("should take two deliveries in one frame as the same two in two frames", () =>
    Effect.gen(function* () {
      const feed = yield* ProviderFeed
      const first = [liveSnapshot({ id: one }), liveSnapshot({ id: two, clock: "5:00" })]
      const second = [liveSnapshot({ id: one, clock: "9:00" })]
      const apart = Slate.empty.relisted("fbs", first)[0].relisted("fbs", second)[0]

      yield* feed.deliver([listingOf(first), listingOf(second)])
      const together = yield* TestDirector.latest

      assert.deepStrictEqual(together.games, apart.games)
    }).pipe(Effect.provide(TestDirector.directorOver))
  )

  it.effect("should give back the slate itself for a frame with no deliveries", () =>
    Effect.gen(function* () {
      const feed = yield* ProviderFeed
      const before = yield* listing([liveSnapshot({ id: one })])

      yield* feed.deliver([])
      const current = yield* TestDirector.latest

      assert.strictEqual(current, before)
    }).pipe(Effect.provide(TestDirector.directorOver))
  )
})
```

- [ ] **Step 6: Point the Director at the domain Slate**

In `apps/hub/src/Director.ts`:

1. Replace the imports
   `import { type Delivery, Provider } from "./provider/Provider.ts"` and
   `import { Slate, SlateChange } from "./Slate.ts"` with
   `import { Slate, SlateChange } from "@sportal/domain/Slate"` (after the `@sportal/domain/Play` import) and
   `import { Delivery, Provider } from "./provider/Provider.ts"`.
2. In `take`, replace `const [next, changes] = before.take(deliveries)` with
   `const [next, changes] = taken(before, deliveries)`.
3. Add this helper directly below the `Director` class, above `observed` (first-use order):

```ts
/** `slate` after each of a frame's deliveries in order, and what each changed, in order. */
function taken(slate: Slate, deliveries: ReadonlyArray<Delivery>): readonly [Slate, ReadonlyArray<SlateChange>] {
  return deliveries.reduce<readonly [Slate, ReadonlyArray<SlateChange>]>(
    ([current, changes], delivery) => {
      const [next, changed] = Delivery.$match(delivery, {
        Listing: ({ league, games }) => current.relisted(league, games),
        Plays: ({ game, plays }) => current.playsTaken(game, plays)
      })
      return [next, [...changes, ...changed]]
    },
    [slate, []]
  )
}
```

- [ ] **Step 7: Delete the Hub's Slate**

Run: `git rm apps/hub/src/Slate.ts apps/hub/src/Slate.test.ts`

- [ ] **Step 8: Update the docs**

`CONTEXT.md`, row **Slate**: replace the definition cell with:

> The domain `Slate` (`packages/domain/src/Slate.ts`): an ordered list of games: each league's last listing, leagues in `LeagueId` order, each game with its latest snapshot and its plays. `relisted` takes a league's listing and `playsTaken` a game's whole list of plays; the Director takes each frame's deliveries onto them in arrival order. A snapshot behind its game (earlier in game time, or at the same game time with fewer points) is ignored, except that an over game takes one ahead of its end (overtime after a spurious final, a postponed game resuming); plays of a game no listing names are dropped. Pure; each operation returns the next slate and its slate changes, or this one and none when nothing changed.

Row **Slate change**: replace `` `SlateChange` in `apps/hub/src/Slate.ts`, given by `Slate#take` beside the next slate `` with
`` `SlateChange` in `packages/domain/src/Slate.ts`, given by `Slate#relisted` and `Slate#playsTaken` beside the next slate ``,
and `One thing a take changed` with `One thing a slate operation changed`.

`docs/technical-spec.md`:
- Domain tree: after the `Game.ts` line add
  `│   │       ├── Slate.ts        Slate (the listed games, from listings and play lists), SlateChange`
- Hub tree: delete the `├── Slate.ts            The fold: …` line.
- Replace the paragraph starting ``- The `Slate` (`Slate.ts`) is the fold`` with:

> - The `Slate` (`packages/domain/src/Slate.ts`) is the fold: an ordered list of `Game`s, leagues in `LeagueId` order and each league's in its listing's order, each with its latest `GameSnapshot` and its plays. `relisted(league, snapshots)` and `playsTaken(game, plays)` on it are pure and return the next slate and its slate changes; one that changes nothing gives back the same slate. The Director takes each frame's deliveries onto them in order.

- [ ] **Step 9: Run the full check**

Run: `pnpm check`
Expected: PASS, with 2 more tests than before (37 Hub Slate tests out; 37 domain Slate tests and 2 Director frame
tests in).

- [ ] **Step 10: Commit**

```bash
git add packages/domain/src/Slate.ts packages/domain/src/Slate.test.ts apps/hub/src/Director.ts apps/hub/src/Director.test.ts CONTEXT.md docs/technical-spec.md
git commit -F - <<'EOF'
refactor: move the Slate to domain

The slate's fold is a domain operation: relisted and playsTaken on the
domain Slate, SlateChange beside it. The Director takes each frame's
deliveries onto them; Delivery stays on the Provider port.

apps/hub/src/Slate.test.ts -> packages/domain/src/Slate.test.ts:
- Slate.empty "should hold no game": same name.
- "Slate#take, a listing", each test -> "Slate#relisted", same name.
- "Slate#take, a later listing", each test -> "Slate#relisted, a later
  listing", same name.
- "Slate#take, a game the slate has over", each test -> "Slate#relisted,
  a game the slate has over", same name.
- "Slate#take, plays" "should hold none for a game just listed" ->
  "Slate#relisted" "should hold no plays for a game just listed".
- "Slate#take, plays" "should keep the plays when it takes a snapshot"
  -> "Slate#relisted" "should keep a game's plays when it takes its
  snapshot".
- "Slate#take, plays", every other test -> "Slate#playsTaken", same name.
- "Slate#games", each test, same names; "should keep the same game for
  one a take does not change" -> "… one an operation does not change".
- "Slate#take, its changes": Progressed, Delisted and "no change" tests
  -> "Slate#relisted, its changes" (the last as "should give no change
  for a listing that changes nothing"); Played and "no Progressed" tests
  -> "Slate#playsTaken, its changes", same names.
- "Slate#take, a frame" "should take two deliveries in one frame as the
  same two in two frames" -> Director.test.ts "Director, a frame", same
  name.
- "Slate#take, a frame" "should give back the slate itself for a frame
  with no deliveries" -> Director.test.ts "Director, a frame", same name.
- New: "Slate#recent" "should keep each game's last ten plays", "should
  give back the slate itself when no game has more than ten plays".

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: SlateChanged carries the slate

**Files:**
- Modify: `packages/api/src/LiveMessage.ts`, `packages/api/src/LiveMessage.test.ts`
- Modify: `apps/hub/src/HubServer.ts:138-147`, `apps/hub/src/HubServer.test.ts`
- Modify: `apps/web/src/hub/LiveStream.ts`, `apps/web/src/hub/LiveStream.test.ts`, `apps/web/src/hub/TestLiveStream.ts`
- Modify: `apps/web/src/screen/DisplayScreen.ts`, `apps/web/src/screen/DisplayScreen.test.ts`
- Modify: `apps/web/src/display/DisplayView.tsx`
- Modify: `CONTEXT.md` (rows **Slate changed**, **Recent plays**), `docs/technical-spec.md` (live route paragraph)

**Interfaces:**
- Consumes: `Slate`, `Slate.empty`, `slate.recent()`, `new Slate({ games })` from Task 1.
- Produces: `SlateChanged = { _tag: "SlateChanged"; slate: Slate; availability: { readonly [game: GameId]: ReadonlyArray<ChannelAvailability> } }`;
  web `Live = { connection, slate: Slate, availability: SlateChanged["availability"] }`;
  `TestLiveStream.slateMessage(entries)` keeps its signature.

- [ ] **Step 1: Update the API test**

Replace the test in `packages/api/src/LiveMessage.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Slate } from "@sportal/domain/Slate"
import { Schema } from "effect"
import { type LiveMessage, LiveMessageJson } from "./LiveMessage.ts"

describe("LiveMessage", () => {
  it("should encode SlateChanged as {_tag, slate, availability}", () => {
    const message: LiveMessage = { _tag: "SlateChanged", slate: Slate.empty, availability: {} }

    const json = Schema.encodeSync(LiveMessageJson)(message)

    assert.strictEqual(json, '{"_tag":"SlateChanged","slate":{"games":[]},"availability":{}}')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run packages/api/src/LiveMessage.test.ts`
Expected: FAIL (type error on `slate`, or the encoded JSON still has `games`).

- [ ] **Step 3: Change the message**

Replace `packages/api/src/LiveMessage.ts`'s imports and `SlateChanged` case:

```ts
import { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId } from "@sportal/domain/Game"
import { Slate } from "@sportal/domain/Slate"
import { Schema } from "effect"

/** A message on the live stream at GET /api/live, sent as one JSON object per server-sent event. */
export const LiveMessage = Schema.TaggedUnion({
  /** The slate, each game with its recent plays, and each listed game's availability from every source, by its id. */
  SlateChanged: {
    slate: Slate,
    availability: Schema.Record(GameId, Schema.Array(ChannelAvailability))
  }
})
```

The rest of the file is unchanged.

- [ ] **Step 4: Run the API test to see it pass**

Run: `pnpm vitest run packages/api/src/LiveMessage.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the message in the live route**

In `apps/hub/src/HubServer.ts`, add `Record` to the `effect` import (alphabetical, after `PlatformError`… keep the
existing order: `DateTime, Effect, type FileSystem, Layer, Option, type Path, type PlatformError, Record, Schema, Sink, Stream`).
Replace the `Stream.mapEffect` in `liveEvents`:

```ts
    Stream.mapEffect(([slate, availabilityOf]) =>
      Effect.map(DateTime.now, (now): SlateChanged => {
        const availability = Record.fromEntries(
          slate.games.map(({ snapshot }) => [snapshot.id, availabilityOf(snapshot, now)] as const)
        )
        return { _tag: "SlateChanged", slate: slate.recent(), availability }
      })
    ),
```

Update the doc comment of `liveRoute` and `liveEvents` only where they say "each game beside its availability": write
"the slate, and each game's availability".

- [ ] **Step 6: Update the live-route tests**

In `apps/hub/src/HubServer.test.ts`, make these replacements (each keeps its assertion):

| Test | Old | New |
|---|---|---|
| should stream the current slate first | `message.games.map(({ game }) => game.plays)` | `message.slate.games.map((game) => game.plays)` |
| should stream each change after the current slate; should give a connection that joins later the latest slate at once; should send a burst of slate changes once; should send nothing when the source changes but no game's availability does | `message.games.map(({ game }) => game.snapshot.period)` | `message.slate.games.map((game) => game.snapshot.period)` |
| should publish the listing order with leagues in their order | `message.games.map(({ game }) => game.snapshot.id)` | `message.slate.games.map((game) => game.snapshot.id)` |
| should publish the accepted snapshot rather than the original listing | `message.games[0]?.game.snapshot.period` | `message.slate.games[0]?.snapshot.period` |
| should publish each listed game's plays | `message.games[0]?.game.plays` | `message.slate.games[0]?.plays` |
| should publish only the last ten plays in sequence order | `message.games[0]?.game.plays.map(` | `message.slate.games[0]?.plays.map(` |
| should publish a listed final game | `message.games.map(({ game }) => game.snapshot)` | `message.slate.games.map((game) => game.snapshot)` |
| should publish every source's availability beside each game | `message.games[0]?.availability` | `message.availability[GameId.make("1")]` |
| should send a game as carried once a snapshot says it has kicked off | `message.games[0]?.availability.map(` | `message.availability[game.id]?.map(` |
| should send the slate again when a guide read carries its game | `message.games[0]?.availability` | `message.availability[game.id]` |

Rename "should publish every source's availability beside each game" to "should publish every source's availability
for each game, by its id".

Replace the projection test's name and body (same assertions, over the new shape):

```ts
      it.effect(
        "should send the slate's games as their snapshots and plays, and each one's availability by its id, and nothing else the slate remembers",
        () =>
          Effect.gen(function* () {
            yield* firstSlateOnTestClock()

            const { lines } = yield* TestHubServer.liveLines()
            const line = yield* Queue.take(lines).pipe(
              Effect.repeat({ until: (line) => line.includes("SlateChanged") })
            )

            const message = JSON.parse(line.slice("data: ".length))
            const [entry] = message.slate.games
            assert.strictEqual(entry.snapshot.id, game.id)
            assert.deepStrictEqual(Object.keys(message), ["_tag", "slate", "availability"])
            assert.deepStrictEqual(Object.keys(entry), ["snapshot", "plays"])
            assert.deepStrictEqual(message.availability[game.id], [{ _tag: "NoGuide", source: "YouTube TV" }])
            assert.notMatch(line, /"state"|"updatedAt"|"from"/)
          }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )
```

- [ ] **Step 7: Run the Hub server tests**

Run: `pnpm vitest run apps/hub/src/HubServer.test.ts`
Expected: PASS.

- [ ] **Step 8: Change the web's live state**

In `apps/web/src/hub/LiveStream.ts`:

- Imports: replace
  `import { LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"`,
  `import type { ChannelAvailability } from "@sportal/domain/Channel"` and
  `import type { Game, GameId } from "@sportal/domain/Game"` with
  `import { LiveMessage, LiveMessageJson, type SlateChanged } from "@sportal/api/LiveMessage"` and
  `import { Slate } from "@sportal/domain/Slate"`.
- `Live` and `initial`:

```ts
interface Live {
  readonly connection: Connection
  readonly slate: Slate
  /** Each listed game's availability from every source, by its id. */
  readonly availability: SlateChanged["availability"]
}

function initial(): Live {
  return { connection: Connection.Connecting(), slate: Slate.empty, availability: {} }
}
```

- `received`:

```ts
function received(live: Live, message: LiveMessage): Live {
  return LiveMessage.match(message, {
    SlateChanged: ({ slate, availability }): Live => ({ ...live, slate, availability })
  })
}
```

In `apps/web/src/screen/DisplayScreen.ts`, replace `availability.get(game)` with `availability[game]` in both places.

In `apps/web/src/display/DisplayView.tsx`, replace each `live.slate` with `live.slate.games` (lines 27, 30, 59, 74).

In `apps/web/src/hub/TestLiveStream.ts`, replace `slateMessage`, and add `import { Slate } from "@sportal/domain/Slate"`
and `Record` to the `effect` import:

```ts
/** A slate message's `data`, as the Hub sends it: the slate of `entries`' games, and each one's availability. */
export function slateMessage(
  entries: ReadonlyArray<{ game: Game; availability: ReadonlyArray<ChannelAvailability> }>
) {
  const slate = new Slate({ games: entries.map(({ game }) => game) })
  const availability = Record.fromEntries(
    entries.map(({ game, availability }) => [game.snapshot.id, availability] as const)
  )
  return encodeLiveMessage({ _tag: "SlateChanged", slate, availability })
}
```

- [ ] **Step 9: Update the web tests**

`apps/web/src/hub/LiveStream.test.ts`:
- every `.slate.length` → `.slate.games.length`;
- `state.slate.map(` → `state.slate.games.map(`;
- `state.slate[0]?.plays` → `state.slate.games[0]?.plays` (both lines);
- `state.availability.get(GameId.make("401"))` → `state.availability[GameId.make("401")]`;
- the malformed message `JSON.stringify({ _tag: "SlateChanged", games: "nope" })` →
  `JSON.stringify({ _tag: "SlateChanged", slate: "nope", availability: {} })`.

`apps/web/src/screen/DisplayScreen.test.ts`: every `live.slate.length` → `live.slate.games.length`.

- [ ] **Step 10: Update the docs**

`CONTEXT.md`:
- Row **Slate changed**, definition: replace `The live message that carries the listed games as the slate has them, each with its recent plays and beside its availability from every source,` with
  `` The live message that carries the slate, each game with its recent plays (`Slate#recent`), and each listed game's availability from every source by its id, ``.
- Row **Recent plays**: replace `` what each game on `SlateChanged` carries (`Game#recent`) `` with
  `` what each game on `SlateChanged` carries (`Game#recent`, over the slate `Slate#recent`) ``.

`docs/technical-spec.md`, the live-route paragraph: replace
`each listed game as the slate has it, carrying only its last ten plays (`Game#recent`), beside its availability from every source.` with
``the slate with each game carrying only its last ten plays (`Slate#recent`), and each listed game's availability from every source, by its id.``

- [ ] **Step 11: Run the full check**

Run: `pnpm check`
Expected: PASS, same test count as after Task 1.

- [ ] **Step 12: Commit**

```bash
git add packages/api/src/LiveMessage.ts packages/api/src/LiveMessage.test.ts apps/hub/src/HubServer.ts apps/hub/src/HubServer.test.ts apps/web/src/hub/LiveStream.ts apps/web/src/hub/LiveStream.test.ts apps/web/src/hub/TestLiveStream.ts apps/web/src/screen/DisplayScreen.ts apps/web/src/screen/DisplayScreen.test.ts apps/web/src/display/DisplayView.tsx CONTEXT.md docs/technical-spec.md
git commit -F - <<'EOF'
feat: send the slate itself on the live stream

SlateChanged carries the domain Slate, trimmed to recent plays, and an
availability record by game id; the web keeps both as decoded.

packages/api/src/LiveMessage.test.ts: "should encode SlateChanged as
{_tag, games}" -> "should encode SlateChanged as {_tag, slate,
availability}".

apps/hub/src/HubServer.test.ts: "should send each listed game as its
snapshot and plays, beside its availability, and nothing else the slate
remembers" -> "should send the slate's games as their snapshots and
plays, and each one's availability by its id, and nothing else the
slate remembers"; "should publish every source's availability beside
each game" -> "should publish every source's availability for each
game, by its id". Every other test keeps its name.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 13: Eye-check**

Ask the user to run `pnpm dev` (agent-launched Electron misreports rendering on this machine) and confirm the strip,
the slate panel, and channel availability on tiles look as before.
