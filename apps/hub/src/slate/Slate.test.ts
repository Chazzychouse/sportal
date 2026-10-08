import { assert, describe, it } from "@effect/vitest"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { type Play, PlayId } from "@sportal/domain/Play"
import { broadcast, completion, play, situation, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime } from "effect"
import { Delivery } from "./Delivery.ts"
import { Slate } from "./Slate.ts"

const t0 = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
const one = GameId.make("1")
const two = GameId.make("2")
const three = GameId.make("3")

describe("Slate.empty", () => {
  it("should hold no listing", () => {
    const games = Slate.empty.listedGames(["fbs", "nfl"])

    assert.strictEqual(Slate.empty.listed.size, 0)
    assert.deepStrictEqual(games, [])
  })

  it("should hold no game", () => {
    assert.strictEqual(Slate.empty.games.size, 0)
    assert.strictEqual(Slate.empty.plays.size, 0)
  })
})

describe("Slate#take, a listing", () => {
  it("should take each game it names", () => {
    const game = live(one, "10:00")

    const next = Slate.empty.take([listing("fbs", [game])])

    assert.strictEqual(next.games.get(one), game)
  })

  it("should keep the listing's games in its order", () => {
    const games = [live(three, "10:00"), live(one, "10:00"), live(two, "10:00")]

    const next = Slate.empty.take([listing("fbs", games)])

    assert.deepStrictEqual(next.listed.get("fbs"), [three, one, two])
  })

  it("should take a game it names however far it is from kickoff", () => {
    const later = snapshot({ id: two, kickoff: DateTime.add(t0, { hours: 3 }) })

    const next = Slate.empty.take([listing("fbs", [later])])

    assert.deepStrictEqual(next.listed.get("fbs"), [two])
    assert.strictEqual(next.games.get(two), later)
  })

  it("should forget the league's games it no longer names, with their plays", () => {
    const slate = Slate.empty.take([listing("fbs", [live(one, "10:00"), live(two, "5:00")]), playsOf(two, 2)])

    const next = slate.take([listing("fbs", [live(one, "9:00")])])

    assert.deepStrictEqual(next.listed.get("fbs"), [one])
    assert.isFalse(next.games.has(two))
    assert.isFalse(next.plays.has(two))
  })

  it("should keep another league's games", () => {
    const nfl = snapshot({ id: two, league: "nfl", status: "live", period: 1 })
    const slate = Slate.empty.take([listing("fbs", [live(one, "10:00")]), listing("nfl", [nfl])])

    const next = slate.take([listing("fbs", [])])

    assert.strictEqual(next.games.get(two), nfl)
    assert.deepStrictEqual(next.listed.get("nfl"), [two])
  })

  it("should take a named game ahead of the slate's", () => {
    const slate = listed(live(one, "10:00"))
    const ahead = live(one, "9:00")

    const next = slate.take([listing("fbs", [ahead])])

    assert.strictEqual(next.games.get(one), ahead)
  })

  it("should keep the slate's game over a named one behind it, still listing it", () => {
    const slate = listed(snapshot({ id: one, status: "live", period: 2 }))

    const next = slate.take([listing("fbs", [live(one, "10:00")])])

    assert.strictEqual(next.games.get(one), slate.games.get(one))
    assert.deepStrictEqual(next.listed.get("fbs"), [one])
  })

  it("should keep a live game's pushed snapshot over a named one at the same game time, giving back the slate itself", () => {
    const slate = listed(live(one, "10:00")).take([snapshotOf(withBall(live(one, "10:00"), 45))])

    const next = slate.take([listing("fbs", [withBall(live(one, "10:00"), 60)])])

    assert.strictEqual(next, slate)
  })

  it("should take an upcoming game named at the same game time", () => {
    const slate = listed(snapshot({ id: one }))
    const televised = snapshot({ id: one, broadcasts: [broadcast("ESPN")] })

    const next = slate.take([listing("fbs", [televised])])

    assert.strictEqual(next.games.get(one), televised)
  })

  it("should give back the slate itself for the same listing again", () => {
    const game = live(one, "10:00")
    const slate = listed(game)

    const next = slate.take([listing("fbs", [game])])

    assert.strictEqual(next, slate)
  })
})

describe("Slate#take, a snapshot", () => {
  it("should take one ahead of a listed game", () => {
    const slate = listed(live(one, "10:00"))
    const ahead = live(one, "9:00")

    const next = slate.take([snapshotOf(ahead)])

    assert.strictEqual(next.games.get(one), ahead)
  })

  it("should give back the slate itself for one behind its game", () => {
    const slate = listed(snapshot({ id: one, status: "live", period: 2 }))
    const behind = snapshotOf(snapshot({ id: one, status: "live", period: 1 }))

    const next = slate.take([behind])

    assert.strictEqual(next, slate)
  })

  it("should give back the slate itself for one equal to its game", () => {
    const slate = listed(live(one, "10:00"))

    const next = slate.take([snapshotOf(live(one, "10:00"))])

    assert.strictEqual(next, slate)
  })

  it("should take one at its game's game time with more points", () => {
    const slate = listed(scoredAt("4:12", 13))

    const next = slate.take([snapshotOf(scoredAt("4:12", 14))])

    assert.strictEqual(next.games.get(one)?.home.score, 14)
  })

  it("should take a poll at the same game time with fewer points as behind, giving back the slate itself", () => {
    const slate = listed(scoredAt("4:12", 14))

    const next = slate.take([snapshotOf(scoredAt("4:12", 13))])

    assert.strictEqual(next, slate)
  })

  it("should take a pushed snapshot at the same game time over a polled one", () => {
    const slate = listed(withBall(live(one, "10:00"), 60))
    const pushed = withBall(live(one, "10:00"), 45)

    const next = slate.take([snapshotOf(pushed)])

    assert.strictEqual(next.games.get(one), pushed)
  })

  it("should drop one of a game no listing names, giving back the slate itself", () => {
    const slate = listed(live(one, "10:00"))

    const next = slate.take([snapshotOf(live(two, "5:00"))])

    assert.strictEqual(next, slate)
  })
})

describe("Slate#take, a frame", () => {
  it("should take its deliveries in order, so a snapshot of a game just listed is taken", () => {
    const listedGame = live(one, "10:00")
    const pushedGame = live(one, "9:00")

    const next = Slate.empty.take([listing("fbs", [listedGame]), snapshotOf(pushedGame)])

    assert.strictEqual(next.games.get(one), pushedGame)
  })

  it("should take two deliveries in one frame as the same two in two frames", () => {
    const deliveries = [
      listing("fbs", [live(one, "10:00"), live(two, "5:00")]),
      snapshotOf(live(one, "9:00"))
    ]

    const together = Slate.empty.take(deliveries)
    const apart = deliveries.reduce((slate, delivery) => slate.take([delivery]), Slate.empty)

    assert.deepStrictEqual(together.games, apart.games)
    assert.deepStrictEqual(together.plays, apart.plays)
    assert.deepStrictEqual(together.listed, apart.listed)
  })

  it("should give back the slate itself for a frame with no deliveries", () => {
    const slate = listed(live(one, "10:00"))

    const next = slate.take([])

    assert.strictEqual(next, slate)
  })
})

describe("Slate#take, a game the slate has over", () => {
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
  const finished = Slate.empty.take([listing("nfl", [playing]), snapshotOf(final)])

  it("should keep its final over a lagging listing", () => {
    const next = finished.take([listing("nfl", [playing])])

    assert.deepStrictEqual(next.listedGames(["nfl"]), [final])
  })

  it("should give back the slate itself for a lagging snapshot", () => {
    const next = finished.take([snapshotOf(playing)])

    assert.strictEqual(next, finished)
  })

  it("should give back the slate itself when the listing catches up to its final", () => {
    const lagged = finished.take([listing("nfl", [playing])])

    const next = lagged.take([listing("nfl", [final])])

    assert.strictEqual(next, lagged)
    assert.deepStrictEqual(next.listedGames(["nfl"]), [final])
  })

  it("should take overtime after the final", () => {
    const overtime = snapshot({ ...playing, period: 5, clock: "15:00" })

    const next = finished.take([listing("nfl", [overtime])])

    assert.deepStrictEqual(next.listedGames(["nfl"]), [overtime])
    assert.strictEqual(next.games.get(one)?.progress(), "live")
  })

  it("should take a corrected score of its final", () => {
    const corrected = snapshot({ ...final, home: home(27) })

    const next = finished.take([snapshotOf(corrected)])

    assert.deepStrictEqual(next.listedGames(["nfl"]), [corrected])
  })

  it("should take a postponed game resuming", () => {
    const slate = listed(snapshot({ id: two, status: "postponed" }))
    const resumed = live(two, "15:00")

    const next = slate.take([snapshotOf(resumed)])

    assert.strictEqual(next.games.get(two), resumed)
  })
})

describe("Slate#take, plays", () => {
  const first = play()
  const second = completion({
    id: PlayId.make("2"),
    sequence: 2,
    scoring: true,
    homeScore: 7,
    touchdown: true
  })
  const withFirst = listed(live(one, "10:00")).take([playsFor(one, [first])])

  it("should hold none for a game just listed", () => {
    const next = Slate.empty.take([listing("fbs", [live(one, "10:00")])])

    assert.isFalse(next.plays.has(one))
  })

  it("should replace the list, in Play.order", () => {
    const next = withFirst.take([playsFor(one, [second, first])])

    assert.deepStrictEqual(next.plays.get(one), [first, second])
  })

  it("should keep the snapshot when plays are taken", () => {
    const next = withFirst.take([playsFor(one, [first, second])])

    assert.deepStrictEqual(next.games.get(one), live(one, "10:00"))
  })

  it("should keep the plays when it takes a snapshot", () => {
    const next = withFirst.take([snapshotOf(live(one, "9:00"))])

    assert.deepStrictEqual(next.plays.get(one), [first])
  })

  it("should give back the slate itself for an identical list", () => {
    const next = withFirst.take([playsFor(one, [first])])

    assert.strictEqual(next, withFirst)
  })

  it("should give back the slate itself for an equal list of equal plays", () => {
    const next = withFirst.take([playsFor(one, [play()])])

    assert.strictEqual(next, withFirst)
  })

  it("should drop a play removed from the list", () => {
    const both = withFirst.take([playsFor(one, [first, second])])

    const next = both.take([playsFor(one, [first])])

    assert.deepStrictEqual(next.plays.get(one), [first])
  })

  it("should drop plays of a game no listing names, giving back the slate itself", () => {
    const next = Slate.empty.take([playsFor(one, [play()])])

    assert.strictEqual(next, Slate.empty)
  })
})

describe("Slate#listedGames", () => {
  const listedFbs = snapshot({ id: one, status: "live", period: 1, clock: "10:00" })
  const listedNfl = snapshot({ id: two, league: "nfl", kickoff: DateTime.add(t0, { hours: 3 }) })
  const later = live(one, "9:00")
  const slate = Slate.empty.take([
    listing("fbs", [listedFbs]),
    listing("nfl", [listedNfl]),
    snapshotOf(later)
  ])

  it("should show each game as the slate has it in place of the listed one", () => {
    const games = slate.listedGames(["fbs"])

    assert.deepStrictEqual(games, [later])
  })

  it("should keep the leagues' order", () => {
    const games = slate.listedGames(["nfl", "fbs"])

    assert.deepStrictEqual(games, [listedNfl, later])
  })
})

describe("Slate#recentPlays", () => {
  const withPlays = Slate.empty.take([
    listing("fbs", [live(one, "10:00"), live(three, "9:00")]),
    listing("nfl", [snapshot({ id: two, league: "nfl", status: "live", period: 1, clock: "5:00" })]),
    playsOf(one, 12),
    playsOf(two, 3)
  ])

  it("should keep the last ten plays", () => {
    const recent = withPlays.recentPlays(withPlays.listedGames(["fbs"]))

    assert.deepStrictEqual(
      recent[one]?.map(({ sequence }) => sequence),
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    )
  })

  it("should keep sequence order", () => {
    const recent = withPlays.recentPlays(withPlays.listedGames(["nfl"]))

    assert.deepStrictEqual(
      recent[two]?.map(({ sequence }) => sequence),
      [1, 2, 3]
    )
  })

  it("should leave out a game with no plays", () => {
    const recent = withPlays.recentPlays(withPlays.listedGames(["fbs"]))

    assert.deepStrictEqual(Object.keys(recent), [one])
  })

  it("should answer only for the games asked for", () => {
    const nfl = withPlays.recentPlays(withPlays.listedGames(["nfl"]))
    const both = withPlays.recentPlays(withPlays.listedGames(["fbs", "nfl"]))

    assert.deepStrictEqual(Object.keys(nfl), [two])
    assert.deepStrictEqual(Object.keys(both).toSorted(), [one, two])
  })
})

describe("Slate#published", () => {
  it("should keep the listing's order, leagues in their order", () => {
    const slate = Slate.empty.take([
      listing("fbs", [live(three, "10:00"), live(one, "10:00"), live(two, "10:00")]),
      listing("nfl", [snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })])
    ])

    const ids = slate.published().games.map((game) => game.id)

    assert.deepStrictEqual(ids, ["9", "3", "1", "2"])
  })

  it("should publish a game's latest snapshot over its listing's", () => {
    const slate = Slate.empty.take([
      listing("fbs", [live(one, "10:00")]),
      snapshotOf(snapshot({ id: one, status: "live", period: 2 }))
    ])

    const { games } = slate.published()

    assert.strictEqual(games[0]?.period, 2)
  })

  it("should carry each listed game's plays beside it", () => {
    const recordedPlay = play({ id: PlayId.make("p1"), sequence: 1 })
    const slate = Slate.empty.take([listing("fbs", [live(one, "10:00")]), playsFor(one, [recordedPlay])])

    const { games, recentPlays } = slate.published()
    const ids = games.map((game) => game.id)

    assert.deepStrictEqual(ids, [one])
    assert.deepStrictEqual(recentPlays, { [one]: [recordedPlay] })
  })

  it("should publish a final game a listing names", () => {
    const final = snapshot({ id: one, status: "final" })
    const slate = listed(final)

    const { games } = slate.published()

    assert.deepStrictEqual(games, [final])
  })

  it("should leave off a game no listing has", () => {
    const slate = Slate.empty.take([
      listing("fbs", [live(one, "10:00")]),
      snapshotOf(live(GameId.make("9"), "10:00"))
    ])

    const ids = slate.published().games.map((game) => game.id)

    assert.deepStrictEqual(ids, ["1"])
  })
})

/** The empty slate taking an FBS listing of `games`. */
function listed(...games: ReadonlyArray<GameSnapshot>) {
  return Slate.empty.take([listing("fbs", games)])
}

function listing(league: LeagueId, games: ReadonlyArray<GameSnapshot>) {
  return Delivery.cases.Listing.make({ league, games })
}

function snapshotOf(game: GameSnapshot) {
  return Delivery.cases.Snapshot.make({ snapshot: game })
}

/** A `Plays` delivery of game `id`'s whole list of plays, `plays`. */
function playsFor(id: GameId, plays: ReadonlyArray<Play>) {
  return Delivery.cases.Plays.make({ game: id, plays })
}

/** A `Plays` delivery of `count` plays for game `id`, sequenced from 1 and handed over out of order. */
function playsOf(id: GameId, count: number) {
  return playsFor(
    id,
    Array.from({ length: count }, (_, index) =>
      play({ id: PlayId.make(`p${index + 1}`), sequence: index + 1 })
    ).toReversed()
  )
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
