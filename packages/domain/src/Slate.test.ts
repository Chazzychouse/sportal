import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, DateTime, Option } from "effect"
import { Game, GameId, type GameSnapshot } from "./Game.ts"
import type { LeagueId } from "./League.ts"
import { type Play, PlayId } from "./Play.ts"
import { Slate, SlateChange } from "./Slate.ts"
import {
  broadcast,
  footballDetail,
  play,
  playsIn,
  situation,
  snapshot,
  snapshotIn,
  team
} from "./TestGame.ts"

const t0 = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
const one = GameId.make("1")
const two = GameId.make("2")
const three = GameId.make("3")

describe("Slate.empty", () => {
  it("should hold no game", () => {
    assert.deepStrictEqual(Slate.empty.games, [])
  })
})

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

describe("Slate#relisted", () => {
  it("should take each game it names", () => {
    const game = live(one, 600)

    const next = Slate.empty.relisted("fbs", [game])[0]

    assert.strictEqual(snapshotIn(next, one), game)
  })

  it("should keep the listing's games in its order", () => {
    const games = [live(three, 600), live(one, 600), live(two, 600)]

    const next = Slate.empty.relisted("fbs", games)[0]

    assert.deepStrictEqual(idsIn(next, "fbs"), [three, one, two])
  })

  it("should take a game it names however far it is from its start", () => {
    const later = snapshot({ id: two, startsAt: DateTime.add(t0, { hours: 3 }) })

    const next = Slate.empty.relisted("fbs", [later])[0]

    assert.deepStrictEqual(idsIn(next, "fbs"), [two])
    assert.strictEqual(snapshotIn(next, two), later)
  })

  it("should forget the league's games it no longer names, with their plays", () => {
    const slate = listed(live(one, 600), live(two, 300)).playsTaken(two, playsOf(2))[0]

    const next = slate.relisted("fbs", [live(one, 540)])[0]

    assert.deepStrictEqual(idsIn(next, "fbs"), [one])
    assert.isUndefined(snapshotIn(next, two))
    assert.deepStrictEqual(playsIn(next, two), [])
  })

  it("should keep another league's games", () => {
    const nfl = snapshot({ id: two, league: "nfl", status: "live", period: 1 })
    const slate = listed(live(one, 600)).relisted("nfl", [nfl])[0]

    const next = slate.relisted("fbs", [])[0]

    assert.strictEqual(snapshotIn(next, two), nfl)
    assert.deepStrictEqual(idsIn(next, "nfl"), [two])
  })

  it("should take a named game ahead of the slate's", () => {
    const slate = listed(live(one, 600))
    const ahead = live(one, 540)

    const next = slate.relisted("fbs", [ahead])[0]

    assert.strictEqual(snapshotIn(next, one), ahead)
  })

  it("should keep the slate's game over a named one behind it, still listing it", () => {
    const slate = listed(snapshot({ id: one, status: "live", period: 2 }))

    const next = slate.relisted("fbs", [live(one, 600)])[0]

    assert.strictEqual(snapshotIn(next, one), snapshotIn(slate, one))
    assert.deepStrictEqual(idsIn(next, "fbs"), [one])
  })

  it("should take a later listing at the same clock and score, for its new down and ball", () => {
    const slate = listed(withBall(live(one, 600), 60))

    const next = slate.relisted("fbs", [withBall(live(one, 600), 45)])[0]

    assert.deepStrictEqual(next.games[0]?.snapshot.situation, situation({ yardLine: 45 }))
  })

  it("should take an upcoming game named at the same game time", () => {
    const slate = listed(snapshot({ id: one }))
    const televised = snapshot({ id: one, broadcasts: [broadcast("ESPN")] })

    const next = slate.relisted("fbs", [televised])[0]

    assert.strictEqual(snapshotIn(next, one), televised)
  })

  it("should give back the slate itself for the same listing again", () => {
    const game = live(one, 600)
    const slate = listed(game)

    const next = slate.relisted("fbs", [game])[0]

    assert.strictEqual(next, slate)
  })

  it("should hold no plays for a game just listed", () => {
    const next = Slate.empty.relisted("fbs", [live(one, 600)])[0]

    assert.deepStrictEqual(playsIn(next, one), [])
  })

  it("should keep a game's plays when it takes its snapshot", () => {
    const first = play()
    const slate = listed(live(one, 600)).playsTaken(one, [first])[0]

    const next = slate.relisted("fbs", [live(one, 540)])[0]

    assert.deepStrictEqual(playsIn(next, one), [first])
  })
})

describe("Slate#relisted, a later listing", () => {
  it("should take one at its game's game time with more points", () => {
    const slate = listed(scoredAt(252, 13))

    const next = slate.relisted("fbs", [scoredAt(252, 14)])[0]

    assert.strictEqual(snapshotIn(next, one)?.home.score, 14)
  })

  it("should take a poll at the same game time with fewer points as behind, giving back the slate itself", () => {
    const slate = listed(scoredAt(252, 14))

    const next = slate.relisted("fbs", [scoredAt(252, 13)])[0]

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
    clock: 39,
    home: home(26)
  })
  const final = snapshot({ ...playing, status: "final", clock: 0 })
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
    const overtime = snapshot({ ...playing, period: 5, clock: 900 })

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
    const resumed = live(two, 900)

    const next = slate.relisted("fbs", [resumed])[0]

    assert.strictEqual(snapshotIn(next, two), resumed)
  })
})

describe("Slate#playsTaken", () => {
  const first = play()
  const second = play({
    id: PlayId.make("2"),
    sequence: 2,
    scoring: true,
    homeScore: 7,
    detail: footballDetail({ kind: "pass" })
  })
  const withFirst = listed(live(one, 600)).playsTaken(one, [first])[0]

  it("should replace the list, in Play.order", () => {
    const next = withFirst.playsTaken(one, [second, first])[0]

    assert.deepStrictEqual(playsIn(next, one), [first, second])
  })

  it("should keep the snapshot when plays are taken", () => {
    const next = withFirst.playsTaken(one, [first, second])[0]

    assert.deepStrictEqual(snapshotIn(next, one), live(one, 600))
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
  const listedFbs = snapshot({ id: one, status: "live", period: 1, clock: 600 })
  const listedNfl = snapshot({ id: two, league: "nfl", startsAt: DateTime.add(t0, { hours: 3 }) })
  const later = live(one, 540)

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
    const game = live(one, 600)

    const [next, changes] = Slate.empty.relisted("fbs", [game])

    assert.deepStrictEqual(changes, [SlateChange.Progressed({ game: gameIn(next, one) })])
  })

  it("should give a listed game whose snapshot it takes as Progressed", () => {
    const slate = listed(live(one, 600))

    const [next, changes] = slate.relisted("fbs", [live(one, 540)])

    assert.deepStrictEqual(changes, [SlateChange.Progressed({ game: gameIn(next, one) })])
  })

  it("should give a game its league's listing no longer names as Delisted", () => {
    const slate = listed(live(one, 600), live(two, 600))

    const [, changes] = slate.relisted("fbs", [live(one, 600)])

    assert.deepStrictEqual(changes, [SlateChange.Delisted({ game: gameIn(slate, two) })])
  })

  it("should give no change for a listing that changes nothing", () => {
    const game = live(one, 600)
    const slate = listed(game)

    const [, changes] = slate.relisted("fbs", [game])

    assert.deepStrictEqual(changes, [])
  })
})

describe("Slate#playsTaken, its changes", () => {
  it("should give each play it adds as Played, in Play.order", () => {
    const slate = listed(live(one, 600))

    const [next, changes] = slate.playsTaken(one, playsOf(2))

    const game = gameIn(next, one)
    assert.deepStrictEqual(
      changes,
      game.plays.map((play) => SlateChange.Played({ game, play }))
    )
  })

  it("should give no Progressed for a game whose plays alone change", () => {
    const slate = listed(live(one, 600))

    const [, changes] = slate.playsTaken(one, playsOf(1))

    assert.isTrue(changes.some(SlateChange.$is("Played")))
    assert.isFalse(changes.some(SlateChange.$is("Progressed")))
  })
})

describe("Slate#recent", () => {
  it("should keep each game's last ten plays", () => {
    const slate = listed(live(one, 600)).playsTaken(one, playsOf(12))[0]

    const next = slate.recent()

    assert.deepStrictEqual(
      playsIn(next, one).map(({ sequence }) => sequence),
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    )
  })

  it("should give back the slate itself when no game has more than ten plays", () => {
    const slate = listed(live(one, 600)).playsTaken(one, playsOf(10))[0]

    const next = slate.recent()

    assert.strictEqual(next, slate)
  })
})

/** Game `id`, as `slate` has it; the test fails when the slate lacks it. */
function gameIn(slate: Slate, id: GameId): Game {
  return Option.getOrThrow(Arr.findFirst(slate.games, ({ snapshot }) => snapshot.id === id))
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

function live(id: GameId, clock: number): GameSnapshot {
  return snapshot({ id, status: "live", period: 1, clock })
}

/** Game one live in the second period at `clock`, with `score` for HOME. */
function scoredAt(clock: number, score: number): GameSnapshot {
  return snapshot({ id: one, status: "live", period: 2, clock, home: { team: team("HOME"), score } })
}

/** `game` with the ball `yardLine` yards from the goal. */
function withBall(game: GameSnapshot, yardLine: number): GameSnapshot {
  return snapshot({ ...game, situation: situation({ yardLine }) })
}
