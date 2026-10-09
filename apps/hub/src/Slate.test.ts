import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { type Game, GameId, type GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { type Play, PlayId } from "@sportal/domain/Play"
import { broadcast, completion, play, situation, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Option } from "effect"
import { Delivery } from "./provider/Provider.ts"
import { Slate, SlateChange } from "./Slate.ts"

const t0 = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
const one = GameId.make("1")
const two = GameId.make("2")
const three = GameId.make("3")
const noAnswers = () => []
const streamingOnly = ChannelAvailability.cases.NotCarried.make({ why: "StreamingOnly" })

describe("Slate.empty", () => {
  it("should hold no game", () => {
    assert.deepStrictEqual(Slate.empty.games, [])
  })
})

describe("Slate#take, a listing", () => {
  it("should take each game it names", () => {
    const game = live(one, "10:00")

    const next = Slate.empty.take([listing("fbs", [game])])[0]

    assert.strictEqual(snapshotIn(next, one), game)
  })

  it("should keep the listing's games in its order", () => {
    const games = [live(three, "10:00"), live(one, "10:00"), live(two, "10:00")]

    const next = Slate.empty.take([listing("fbs", games)])[0]

    assert.deepStrictEqual(idsIn(next, "fbs"), [three, one, two])
  })

  it("should take a game it names however far it is from kickoff", () => {
    const later = snapshot({ id: two, kickoff: DateTime.add(t0, { hours: 3 }) })

    const next = Slate.empty.take([listing("fbs", [later])])[0]

    assert.deepStrictEqual(idsIn(next, "fbs"), [two])
    assert.strictEqual(snapshotIn(next, two), later)
  })

  it("should forget the league's games it no longer names, with their plays", () => {
    const slate = Slate.empty.take([
      listing("fbs", [live(one, "10:00"), live(two, "5:00")]),
      playsOf(two, 2)
    ])[0]

    const next = slate.take([listing("fbs", [live(one, "9:00")])])[0]

    assert.deepStrictEqual(idsIn(next, "fbs"), [one])
    assert.isUndefined(snapshotIn(next, two))
    assert.deepStrictEqual(playsIn(next, two), [])
  })

  it("should keep another league's games", () => {
    const nfl = snapshot({ id: two, league: "nfl", status: "live", period: 1 })
    const slate = Slate.empty.take([listing("fbs", [live(one, "10:00")]), listing("nfl", [nfl])])[0]

    const next = slate.take([listing("fbs", [])])[0]

    assert.strictEqual(snapshotIn(next, two), nfl)
    assert.deepStrictEqual(idsIn(next, "nfl"), [two])
  })

  it("should take a named game ahead of the slate's", () => {
    const slate = listed(live(one, "10:00"))
    const ahead = live(one, "9:00")

    const next = slate.take([listing("fbs", [ahead])])[0]

    assert.strictEqual(snapshotIn(next, one), ahead)
  })

  it("should keep the slate's game over a named one behind it, still listing it", () => {
    const slate = listed(snapshot({ id: one, status: "live", period: 2 }))

    const next = slate.take([listing("fbs", [live(one, "10:00")])])[0]

    assert.strictEqual(snapshotIn(next, one), snapshotIn(slate, one))
    assert.deepStrictEqual(idsIn(next, "fbs"), [one])
  })

  it("should keep a live game's pushed snapshot over a named one at the same game time, giving back the slate itself", () => {
    const slate = listed(live(one, "10:00")).take([snapshotOf(withBall(live(one, "10:00"), 45))])[0]

    const next = slate.take([listing("fbs", [withBall(live(one, "10:00"), 60)])])[0]

    assert.strictEqual(next, slate)
  })

  it("should take an upcoming game named at the same game time", () => {
    const slate = listed(snapshot({ id: one }))
    const televised = snapshot({ id: one, broadcasts: [broadcast("ESPN")] })

    const next = slate.take([listing("fbs", [televised])])[0]

    assert.strictEqual(snapshotIn(next, one), televised)
  })

  it("should give back the slate itself for the same listing again", () => {
    const game = live(one, "10:00")
    const slate = listed(game)

    const next = slate.take([listing("fbs", [game])])[0]

    assert.strictEqual(next, slate)
  })
})

describe("Slate#take, a snapshot", () => {
  it("should take one ahead of a listed game", () => {
    const slate = listed(live(one, "10:00"))
    const ahead = live(one, "9:00")

    const next = slate.take([snapshotOf(ahead)])[0]

    assert.strictEqual(snapshotIn(next, one), ahead)
  })

  it("should give back the slate itself for one behind its game", () => {
    const slate = listed(snapshot({ id: one, status: "live", period: 2 }))
    const behind = snapshotOf(snapshot({ id: one, status: "live", period: 1 }))

    const next = slate.take([behind])[0]

    assert.strictEqual(next, slate)
  })

  it("should give back the slate itself for one equal to its game", () => {
    const slate = listed(live(one, "10:00"))

    const next = slate.take([snapshotOf(live(one, "10:00"))])[0]

    assert.strictEqual(next, slate)
  })

  it("should take one at its game's game time with more points", () => {
    const slate = listed(scoredAt("4:12", 13))

    const next = slate.take([snapshotOf(scoredAt("4:12", 14))])[0]

    assert.strictEqual(snapshotIn(next, one)?.home.score, 14)
  })

  it("should take a poll at the same game time with fewer points as behind, giving back the slate itself", () => {
    const slate = listed(scoredAt("4:12", 14))

    const next = slate.take([snapshotOf(scoredAt("4:12", 13))])[0]

    assert.strictEqual(next, slate)
  })

  it("should take a pushed snapshot at the same game time over a polled one", () => {
    const slate = listed(withBall(live(one, "10:00"), 60))
    const pushed = withBall(live(one, "10:00"), 45)

    const next = slate.take([snapshotOf(pushed)])[0]

    assert.strictEqual(snapshotIn(next, one), pushed)
  })

  it("should drop one of a game no listing names, giving back the slate itself", () => {
    const slate = listed(live(one, "10:00"))

    const next = slate.take([snapshotOf(live(two, "5:00"))])[0]

    assert.strictEqual(next, slate)
  })
})

describe("Slate#take, a frame", () => {
  it("should take its deliveries in order, so a snapshot of a game just listed is taken", () => {
    const listedGame = live(one, "10:00")
    const pushedGame = live(one, "9:00")

    const next = Slate.empty.take([listing("fbs", [listedGame]), snapshotOf(pushedGame)])[0]

    assert.strictEqual(snapshotIn(next, one), pushedGame)
  })

  it("should take two deliveries in one frame as the same two in two frames", () => {
    const deliveries = [
      listing("fbs", [live(one, "10:00"), live(two, "5:00")]),
      snapshotOf(live(one, "9:00"))
    ]

    const together = Slate.empty.take(deliveries)[0]
    const apart = deliveries.reduce((slate, delivery) => slate.take([delivery])[0], Slate.empty)

    assert.deepStrictEqual(together.games, apart.games)
  })

  it("should give back the slate itself for a frame with no deliveries", () => {
    const slate = listed(live(one, "10:00"))

    const next = slate.take([])[0]

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
  const finished = Slate.empty.take([listing("nfl", [playing]), snapshotOf(final)])[0]

  it("should keep its final over a lagging listing", () => {
    const next = finished.take([listing("nfl", [playing])])[0]

    assert.deepStrictEqual(snapshotsIn(next, "nfl"), [final])
  })

  it("should give back the slate itself for a lagging snapshot", () => {
    const next = finished.take([snapshotOf(playing)])[0]

    assert.strictEqual(next, finished)
  })

  it("should give back the slate itself when the listing catches up to its final", () => {
    const lagged = finished.take([listing("nfl", [playing])])[0]

    const next = lagged.take([listing("nfl", [final])])[0]

    assert.strictEqual(next, lagged)
    assert.deepStrictEqual(snapshotsIn(next, "nfl"), [final])
  })

  it("should take overtime after the final", () => {
    const overtime = snapshot({ ...playing, period: 5, clock: "15:00" })

    const next = finished.take([listing("nfl", [overtime])])[0]

    assert.deepStrictEqual(snapshotsIn(next, "nfl"), [overtime])
    assert.strictEqual(snapshotIn(next, one)?.progress(), "live")
  })

  it("should take a corrected score of its final", () => {
    const corrected = snapshot({ ...final, home: home(27) })

    const next = finished.take([snapshotOf(corrected)])[0]

    assert.deepStrictEqual(snapshotsIn(next, "nfl"), [corrected])
  })

  it("should take a postponed game resuming", () => {
    const slate = listed(snapshot({ id: two, status: "postponed" }))
    const resumed = live(two, "15:00")

    const next = slate.take([snapshotOf(resumed)])[0]

    assert.strictEqual(snapshotIn(next, two), resumed)
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
  const withFirst = listed(live(one, "10:00")).take([playsFor(one, [first])])[0]

  it("should hold none for a game just listed", () => {
    const next = Slate.empty.take([listing("fbs", [live(one, "10:00")])])[0]

    assert.deepStrictEqual(playsIn(next, one), [])
  })

  it("should replace the list, in Play.order", () => {
    const next = withFirst.take([playsFor(one, [second, first])])[0]

    assert.deepStrictEqual(playsIn(next, one), [first, second])
  })

  it("should keep the snapshot when plays are taken", () => {
    const next = withFirst.take([playsFor(one, [first, second])])[0]

    assert.deepStrictEqual(snapshotIn(next, one), live(one, "10:00"))
  })

  it("should keep the plays when it takes a snapshot", () => {
    const next = withFirst.take([snapshotOf(live(one, "9:00"))])[0]

    assert.deepStrictEqual(playsIn(next, one), [first])
  })

  it("should give back the slate itself for an identical list", () => {
    const next = withFirst.take([playsFor(one, [first])])[0]

    assert.strictEqual(next, withFirst)
  })

  it("should give back the slate itself for an equal list of equal plays", () => {
    const next = withFirst.take([playsFor(one, [play()])])[0]

    assert.strictEqual(next, withFirst)
  })

  it("should drop a play removed from the list", () => {
    const both = withFirst.take([playsFor(one, [first, second])])[0]

    const next = both.take([playsFor(one, [first])])[0]

    assert.deepStrictEqual(playsIn(next, one), [first])
  })

  it("should drop plays of a game no listing names, giving back the slate itself", () => {
    const next = Slate.empty.take([playsFor(one, [play()])])[0]

    assert.strictEqual(next, Slate.empty)
  })
})

describe("Slate#games", () => {
  const listedFbs = snapshot({ id: one, status: "live", period: 1, clock: "10:00" })
  const listedNfl = snapshot({ id: two, league: "nfl", kickoff: DateTime.add(t0, { hours: 3 }) })
  const later = live(one, "9:00")

  it("should hold each game as the slate has it in place of the listed one", () => {
    const slate = Slate.empty.take([listing("fbs", [listedFbs]), snapshotOf(later)])[0]

    assert.deepStrictEqual(snapshotsIn(slate, "fbs"), [later])
  })

  it("should keep the leagues in their order, whatever order they were listed in", () => {
    const slate = Slate.empty.take([listing("fbs", [listedFbs]), listing("nfl", [listedNfl])])[0]

    const ids = slate.games.map(({ snapshot }) => snapshot.id)

    assert.deepStrictEqual(ids, [two, one])
  })

  it("should keep the same game for one a take does not change", () => {
    const slate = Slate.empty.take([listing("fbs", [listedFbs]), listing("nfl", [listedNfl])])[0]

    const next = slate.take([snapshotOf(later)])[0]

    assert.strictEqual(next.games[0], slate.games[0])
  })
})

describe("Slate#published", () => {
  it("should keep the listing's order, leagues in their order", () => {
    const slate = Slate.empty.take([
      listing("fbs", [live(three, "10:00"), live(one, "10:00"), live(two, "10:00")]),
      listing("nfl", [snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })])
    ])[0]

    const ids = slate.published(noAnswers).games.map(({ game }) => game.snapshot.id)

    assert.deepStrictEqual(ids, ["9", "3", "1", "2"])
  })

  it("should publish a game's latest snapshot over its listing's", () => {
    const slate = Slate.empty.take([
      listing("fbs", [live(one, "10:00")]),
      snapshotOf(snapshot({ id: one, status: "live", period: 2 }))
    ])[0]

    const { games } = slate.published(noAnswers)

    assert.strictEqual(games[0]?.game.snapshot.period, 2)
  })

  it("should carry each listed game's plays with it", () => {
    const recordedPlay = play({ id: PlayId.make("p1"), sequence: 1 })
    const slate = Slate.empty.take([listing("fbs", [live(one, "10:00")]), playsFor(one, [recordedPlay])])[0]

    const { games } = slate.published(noAnswers)

    assert.deepStrictEqual(games[0]?.game.plays, [recordedPlay])
  })

  it("should carry only a game's last ten plays", () => {
    const slate = Slate.empty.take([listing("fbs", [live(one, "10:00")]), playsOf(one, 12)])[0]

    const { games } = slate.published(noAnswers)

    assert.deepStrictEqual(
      games[0]?.game.plays.map(({ sequence }) => sequence),
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    )
  })

  it("should publish a final game a listing names", () => {
    const final = snapshot({ id: one, status: "final" })
    const slate = listed(final)

    const { games } = slate.published(noAnswers)

    assert.deepStrictEqual(
      games.map(({ game }) => game.snapshot),
      [final]
    )
  })

  it("should leave off a game no listing has", () => {
    const slate = Slate.empty.take([
      listing("fbs", [live(one, "10:00")]),
      snapshotOf(live(GameId.make("9"), "10:00"))
    ])[0]

    const ids = slate.published(noAnswers).games.map(({ game }) => game.snapshot.id)

    assert.deepStrictEqual(ids, ["1"])
  })

  it("should put every source's answer for each game beside it", () => {
    const slate = listed(live(one, "10:00"))

    const { games } = slate.published(() => [streamingOnly])

    assert.deepStrictEqual(games[0]?.availability, [streamingOnly])
  })
})

describe("Slate#take, its changes", () => {
  it("should give a game a listing names for the first time as Progressed", () => {
    const game = live(one, "10:00")

    const [next, changes] = Slate.empty.take([listing("fbs", [game])])

    assert.deepStrictEqual(changes, [SlateChange.Progressed({ game: gameIn(next, one) })])
  })

  it("should give a listed game whose snapshot it takes as Progressed", () => {
    const slate = listed(live(one, "10:00"))

    const [next, changes] = slate.take([snapshotOf(live(one, "9:00"))])

    assert.deepStrictEqual(changes, [SlateChange.Progressed({ game: gameIn(next, one) })])
  })

  it("should give a game its league's listing no longer names as Delisted", () => {
    const slate = listed(live(one, "10:00"), live(two, "10:00"))

    const [, changes] = slate.take([listing("fbs", [live(one, "10:00")])])

    assert.deepStrictEqual(changes, [SlateChange.Delisted({ game: gameIn(slate, two) })])
  })

  it("should give each play it adds as Played, in Play.order", () => {
    const slate = listed(live(one, "10:00"))

    const [next, changes] = slate.take([playsOf(one, 2)])

    const game = gameIn(next, one)
    assert.deepStrictEqual(
      changes,
      game.plays.map((play) => SlateChange.Played({ game, play }))
    )
  })

  it("should give no Progressed for a game whose plays alone change", () => {
    const slate = listed(live(one, "10:00"))

    const [, changes] = slate.take([playsOf(one, 1)])

    assert.isTrue(changes.some(SlateChange.$is("Played")))
    assert.isFalse(changes.some(SlateChange.$is("Progressed")))
  })

  it("should give no change for a take that changes nothing", () => {
    const game = live(one, "10:00")
    const slate = listed(game)

    const [, changes] = slate.take([listing("fbs", [game])])

    assert.deepStrictEqual(changes, [])
  })
})

/** Game `id`'s snapshot, as `slate` has it. */
function snapshotIn(slate: Slate, id: GameId): GameSnapshot | undefined {
  return Option.getOrUndefined(slate.game(id))?.snapshot
}

/** Game `id`, as `slate` has it; the test fails when the slate lacks it. */
function gameIn(slate: Slate, id: GameId): Game {
  return Option.getOrThrow(slate.game(id))
}

/** Game `id`'s plays, as `slate` has them; none for a game it does not have. */
function playsIn(slate: Slate, id: GameId): ReadonlyArray<Play> {
  return Option.match(slate.game(id), { onNone: () => [], onSome: ({ plays }) => plays })
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
  return Slate.empty.take([listing("fbs", games)])[0]
}

function listing(league: LeagueId, games: ReadonlyArray<GameSnapshot>) {
  return Delivery.Listing({ league, games })
}

function snapshotOf(game: GameSnapshot) {
  return Delivery.Snapshot({ snapshot: game })
}

/** A `Plays` delivery of game `id`'s whole list of plays, `plays`. */
function playsFor(id: GameId, plays: ReadonlyArray<Play>) {
  return Delivery.Plays({ game: id, plays })
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
