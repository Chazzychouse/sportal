import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Option } from "effect"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import { GameId, type GameSnapshot } from "./Game.ts"
import { GameEvent } from "./GameEvent.ts"
import { LiveGame, LiveGameState } from "./LiveGame.ts"
import { type Play, PlayId } from "./Play.ts"
import { play, snapshot } from "./TestGame.ts"
import { Watchability } from "./Watchability.ts"

const t0 = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
const later = DateTime.addDuration(t0, Duration.seconds(30))

const upcoming = snapshot()
const live = snapshot({ status: "live", period: 2, clock: "10:00" })
const liveBehind = snapshot({ status: "live", period: 1, clock: "10:00" })
const over = snapshot({ status: "final", period: 4, clock: "0:00" })

const upcomingGame = LiveGame.start(upcoming, "poll", t0)
const liveGame = LiveGame.start(live, "poll", t0)
const overGame = LiveGame.start(over, "poll", t0)
const staleGame = new LiveGame({ ...liveGame, state: LiveGameState.Stale({ updatedAt: t0 }) })

const liveAt = (updatedAt: DateTime.Utc) => LiveGameState.Live({ updatedAt })
const taken = (game: LiveGame, taking: GameSnapshot, from: DeliverySource, now: DateTime.Utc) =>
  game.take(Delivery.Snapshot({ snapshot: taking, from }), now).liveGame
const ticked = (game: LiveGame, now: DateTime.Utc) => game.tick(now).liveGame

describe("LiveGame.updatedAt", () => {
  it("is the instant of a live or stale game, and none otherwise", () => {
    assert.deepStrictEqual(upcomingGame.updatedAt(), Option.none())
    assert.deepStrictEqual(liveGame.updatedAt(), Option.some(t0))
    assert.deepStrictEqual(staleGame.updatedAt(), Option.some(t0))
    assert.deepStrictEqual(overGame.updatedAt(), Option.none())
  })
})

describe("LiveGame.start", () => {
  it("an upcoming snapshot starts Upcoming", () => {
    assert.deepStrictEqual(upcomingGame.state, LiveGameState.Upcoming())
  })
  it("a live snapshot starts Live, updated now", () => {
    assert.deepStrictEqual(liveGame.state, liveAt(t0))
  })
  it("a final snapshot starts Over", () => {
    assert.deepStrictEqual(overGame.state, LiveGameState.Over())
  })
})

describe("LiveGame#take, a snapshot", () => {
  it("Upcoming + upcoming snapshot: Upcoming", () => {
    assert.deepStrictEqual(
      taken(upcomingGame, upcoming, "poll", later).pipe(Option.map((game) => game.state)),
      Option.some(LiveGameState.Upcoming())
    )
  })
  it("Upcoming + live snapshot: Live, refreshed", () => {
    assert.deepStrictEqual(
      taken(upcomingGame, live, "poll", later).pipe(Option.map((game) => game.state)),
      Option.some(liveAt(later))
    )
  })
  it("Upcoming + final snapshot: Over", () => {
    assert.deepStrictEqual(
      taken(upcomingGame, over, "poll", later).pipe(Option.map((game) => game.state)),
      Option.some(LiveGameState.Over())
    )
  })
  it("Upcoming + behind snapshot: none", () => {
    // Unreachable through start and take; kept so every cell of the transition table is covered.
    const ahead = new LiveGame({ ...liveGame, state: LiveGameState.Upcoming() })
    assert.deepStrictEqual(taken(ahead, upcoming, "poll", later), Option.none())
  })
  it("Live + upcoming snapshot: none (behind)", () => {
    assert.deepStrictEqual(taken(liveGame, upcoming, "poll", later), Option.none())
  })
  it("Live + behind snapshot: none", () => {
    assert.deepStrictEqual(taken(liveGame, liveBehind, "poll", later), Option.none())
  })
  it("Live + live snapshot: Live, refreshed", () => {
    const next = snapshot({ status: "live", period: 2, clock: "9:00" })
    assert.deepStrictEqual(
      taken(liveGame, next, "poll", later).pipe(Option.map((game) => game.state)),
      Option.some(liveAt(later))
    )
  })
  it("Live + final snapshot: Over", () => {
    assert.deepStrictEqual(
      taken(liveGame, over, "poll", later).pipe(Option.map((game) => game.state)),
      Option.some(LiveGameState.Over())
    )
  })
  it("Stale + upcoming snapshot: none (behind)", () => {
    assert.deepStrictEqual(taken(staleGame, upcoming, "poll", later), Option.none())
  })
  it("Stale + behind snapshot: none", () => {
    assert.deepStrictEqual(taken(staleGame, liveBehind, "poll", later), Option.none())
  })
  it("Stale + live snapshot: Live, refreshed", () => {
    assert.deepStrictEqual(
      taken(staleGame, live, "poll", later).pipe(Option.map((game) => game.state)),
      Option.some(liveAt(later))
    )
  })
  it("Stale + final snapshot: Over", () => {
    assert.deepStrictEqual(
      taken(staleGame, over, "poll", later).pipe(Option.map((game) => game.state)),
      Option.some(LiveGameState.Over())
    )
  })
  it("Over + upcoming snapshot: none (behind)", () => {
    assert.deepStrictEqual(taken(overGame, upcoming, "poll", later), Option.none())
  })
  it("Over + live snapshot: none (behind)", () => {
    assert.deepStrictEqual(taken(overGame, live, "poll", later), Option.none())
  })
  it("Over + final snapshot: Over, new snapshot", () => {
    const corrected = snapshot({
      status: "final",
      period: 4,
      clock: "0:00",
      home: { ...over.home, score: 7 }
    })
    const next = taken(overGame, corrected, "poll", later)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state)), Option.some(LiveGameState.Over()))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(corrected))
  })
  it("a taken snapshot replaces the snapshot", () => {
    const scored = snapshot({ status: "live", period: 2, clock: "9:00", home: { ...live.home, score: 3 } })
    assert.deepStrictEqual(
      taken(liveGame, scored, "poll", later).pipe(Option.map((game) => game.snapshot)),
      Option.some(scored)
    )
  })
  it("an identical snapshot is taken and refreshes updatedAt", () => {
    assert.deepStrictEqual(
      taken(liveGame, live, "poll", later).pipe(Option.map((game) => game.state)),
      Option.some(liveAt(later))
    )
  })
})

describe("LiveGame#take, a snapshot, ties between the feeds", () => {
  const touchdown = snapshot({ status: "live", period: 2, clock: "4:12", home: { ...live.home, score: 13 } })
  const tried = snapshot({ status: "live", period: 2, clock: "4:12", home: { ...live.home, score: 14 } })
  const pushed = LiveGame.start(tried, "push", t0)

  it("a tied poll on a pushed live game keeps the pushed snapshot, refreshed", () => {
    const next = taken(pushed, touchdown, "poll", later)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot.home.score)), Option.some(14))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.from)), Option.some("push"))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state)), Option.some(liveAt(later)))
  })
  it("a tied poll on a polled live game is taken", () => {
    const next = taken(LiveGame.start(tried, "poll", t0), touchdown, "poll", later)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(touchdown))
  })
  it("a tied push on a pushed live game is taken, as an overturned score is", () => {
    const next = taken(pushed, touchdown, "push", later)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(touchdown))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.from)), Option.some("push"))
  })
  it("a tied poll on a stale pushed game is taken", () => {
    const stale = new LiveGame({ ...pushed, state: LiveGameState.Stale({ updatedAt: t0 }) })
    const next = taken(stale, touchdown, "poll", later)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(touchdown))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.from)), Option.some("poll"))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state)), Option.some(liveAt(later)))
  })
  it("a poll ahead of a pushed live game is taken", () => {
    const ahead = snapshot({ status: "live", period: 2, clock: "4:05", home: { ...live.home, score: 14 } })
    const next = taken(pushed, ahead, "poll", later)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(ahead))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.from)), Option.some("poll"))
  })
})

describe("LiveGame#tick, staleness", () => {
  const staleTime = DateTime.addDuration(t0, Duration.seconds(90))
  // The state a tick leaves, whether or not the watchability changed with it.
  const stateAt = (game: LiveGame, now: DateTime.Utc) => Option.getOrElse(ticked(game, now), () => game).state

  it("Upcoming: never stale", () => {
    assert.deepStrictEqual(stateAt(upcomingGame, staleTime), LiveGameState.Upcoming())
  })
  it("Live at updatedAt + 89 s: still Live", () => {
    assert.deepStrictEqual(stateAt(liveGame, DateTime.addDuration(t0, Duration.seconds(89))), liveAt(t0))
  })
  it("Live at exactly updatedAt + 90 s: Stale", () => {
    assert.deepStrictEqual(
      ticked(liveGame, staleTime).pipe(Option.map((game) => game.state)),
      Option.some(LiveGameState.Stale({ updatedAt: t0 }))
    )
  })
  it("after a refresh at 60 s, Live at 149 s and Stale at 150 s", () => {
    const refreshedAt = DateTime.addDuration(t0, Duration.seconds(60))
    const next = snapshot({ status: "live", period: 2, clock: "9:00" })
    const refreshed = Option.getOrThrow(taken(liveGame, next, "poll", refreshedAt))
    assert.deepStrictEqual(
      stateAt(refreshed, DateTime.addDuration(t0, Duration.seconds(149))),
      liveAt(refreshedAt)
    )
    assert.deepStrictEqual(
      stateAt(refreshed, DateTime.addDuration(t0, Duration.seconds(150))),
      LiveGameState.Stale({ updatedAt: refreshedAt })
    )
  })
  it("Stale, live again on the next snapshot", () => {
    const stale = Option.getOrThrow(ticked(liveGame, staleTime))
    const next = snapshot({ status: "live", period: 2, clock: "9:00" })
    assert.deepStrictEqual(
      taken(stale, next, "poll", staleTime).pipe(Option.map((game) => game.state)),
      Option.some(liveAt(staleTime))
    )
  })
  it("Stale stays Stale", () => {
    assert.deepStrictEqual(stateAt(staleGame, staleTime), LiveGameState.Stale({ updatedAt: t0 }))
  })
  it("Over: never stale, and nothing changes", () => {
    assert.deepStrictEqual(ticked(overGame, staleTime), Option.none())
  })
  it("gives no events", () => {
    assert.deepStrictEqual(liveGame.tick(staleTime).events, [])
  })
})

describe("LiveGame#tick, watchability", () => {
  const lastPlayAt = DateTime.addDuration(t0, Duration.seconds(10))
  const withPlay = Option.getOrThrow(
    liveGame.take(Delivery.Plays({ game: live.id, plays: [play()] }), lastPlayAt).liveGame
  )

  it("nothing changes before the lull", () => {
    assert.deepStrictEqual(
      ticked(withPlay, DateTime.addDuration(lastPlayAt, Duration.seconds(59))),
      Option.none()
    )
  })
  it("begins a lull 60 s after the last play with no snapshot", () => {
    const lull = ticked(withPlay, DateTime.addDuration(lastPlayAt, Duration.seconds(60)))
    assert.deepStrictEqual(lull.pipe(Option.map((game) => game.watchability.lull)), Option.some(true))
    assert.deepStrictEqual(lull.pipe(Option.map((game) => game.state)), Option.some(liveAt(t0)))
  })
})

describe("LiveGame#staleAt", () => {
  it("Live: updatedAt + 90 s", () => {
    assert.deepStrictEqual(liveGame.staleAt(), Option.some(DateTime.addDuration(t0, Duration.seconds(90))))
  })
  it("Upcoming, Stale and Over: none", () => {
    assert.deepStrictEqual(upcomingGame.staleAt(), Option.none())
    assert.deepStrictEqual(staleGame.staleAt(), Option.none())
    assert.deepStrictEqual(overGame.staleAt(), Option.none())
  })
})

describe("LiveGame#isCurrent", () => {
  it("Live and Stale are current", () => {
    assert.strictEqual(liveGame.isCurrent(later), true)
    assert.strictEqual(staleGame.isCurrent(later), true)
  })
  it("Stale at updatedAt + 29:59 is current, and at + 30:00 is not", () => {
    assert.strictEqual(staleGame.isCurrent(DateTime.addDuration(t0, Duration.seconds(30 * 60 - 1))), true)
    assert.strictEqual(staleGame.isCurrent(DateTime.addDuration(t0, Duration.minutes(30))), false)
  })
  it("Over is not current", () => {
    assert.strictEqual(overGame.isCurrent(later), false)
  })
  it("Upcoming with kickoff exactly 30 minutes away is current", () => {
    assert.strictEqual(
      upcomingGame.isCurrent(DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30))),
      true
    )
  })
  it("Upcoming with kickoff 30 minutes and 1 second away is not current", () => {
    assert.strictEqual(
      upcomingGame.isCurrent(DateTime.subtractDuration(upcoming.kickoff, Duration.seconds(30 * 60 + 1))),
      false
    )
  })
})

describe("LiveGame#currencyChangesAt", () => {
  it("Stale: updatedAt + 30 minutes, until then", () => {
    const end = DateTime.addDuration(t0, Duration.minutes(30))
    assert.deepStrictEqual(staleGame.currencyChangesAt(later), Option.some(end))
    assert.deepStrictEqual(staleGame.currencyChangesAt(end), Option.none())
  })
  it("Upcoming: kickoff - 30 minutes, until then", () => {
    const opens = DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30))
    assert.deepStrictEqual(
      upcomingGame.currencyChangesAt(DateTime.subtractDuration(opens, Duration.seconds(1))),
      Option.some(opens)
    )
    assert.deepStrictEqual(upcomingGame.currencyChangesAt(opens), Option.none())
  })
  it("Live and Over: none", () => {
    assert.deepStrictEqual(liveGame.currencyChangesAt(later), Option.none())
    assert.deepStrictEqual(overGame.currencyChangesAt(later), Option.none())
  })
})

describe("LiveGame.asFolded", () => {
  const listed = [snapshot({ id: GameId.make("2") }), snapshot({ id: GameId.make("1") })]

  it("each listed game in listed order, as its live game has it, or as listed when it has none", () => {
    const games = LiveGame.asFolded(
      listed,
      new Map([
        [
          GameId.make("1"),
          LiveGame.start(snapshot({ id: GameId.make("1"), status: "live", period: 2 }), "poll", t0)
        ]
      ])
    )
    assert.deepStrictEqual(
      games.map((game) => [game.id, game.status]),
      [
        ["2", "scheduled"],
        ["1", "live"]
      ]
    )
  })
  it("leaves off a live game no listing has", () => {
    const games = LiveGame.asFolded(listed, new Map([[GameId.make("9"), liveGame]]))
    assert.deepStrictEqual(
      games.map((game) => game.id),
      ["2", "1"]
    )
  })
})

describe("LiveGame.start, plays and watchability", () => {
  it("starts with no plays, judged fresh", () => {
    assert.deepStrictEqual(liveGame.plays, [])
    assert.deepStrictEqual(liveGame.watchability, Watchability.initial(live, t0))
  })
})

describe("LiveGame#take, plays", () => {
  const first = play()
  const second = play({ id: PlayId.make("2"), sequence: 2, scoring: true, homeScore: 7, kind: "pass" })
  const take = (game: LiveGame, plays: ReadonlyArray<Play>) =>
    game.take(Delivery.Plays({ game: live.id, plays }), later)
  const withFirst = Option.getOrThrow(take(liveGame, [first]).liveGame)
  const secondsEvents = [
    GameEvent.Played({ play: second }),
    GameEvent.ScoreChanged({ team: live.home.team.id, points: 7 })
  ]

  it("replaces the list, in Play.order, and gives the new plays' events", () => {
    const { liveGame: next, events } = take(withFirst, [second, first])
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.plays)), Option.some([first, second]))
    assert.deepStrictEqual(events, secondsEvents)
  })
  it("moves the watchability on with those events", () => {
    const next = take(withFirst, [first, second]).liveGame
    assert.deepStrictEqual(
      next.pipe(Option.map((game) => game.watchability)),
      Option.some(withFirst.watchability.next(live, live, secondsEvents, later))
    )
    assert.deepStrictEqual(
      next.pipe(Option.map((game) => game.watchability.boostUntil !== undefined)),
      Option.some(true)
    )
  })
  it("keeps the snapshot, its source, and its state", () => {
    const next = take(withFirst, [first, second]).liveGame
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(live))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.from)), Option.some("poll"))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state)), Option.some(liveAt(t0)))
  })
  it("an identical list is none", () => {
    assert.deepStrictEqual(take(withFirst, [first]), { liveGame: Option.none(), events: [] })
    assert.deepStrictEqual(take(withFirst, [play()]), { liveGame: Option.none(), events: [] })
  })
  it("a play removed from the list is gone", () => {
    const both = Option.getOrThrow(take(withFirst, [first, second]).liveGame)
    const { liveGame: next, events } = take(both, [first])
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.plays)), Option.some([first]))
    assert.deepStrictEqual(events, [])
  })
})

describe("LiveGame#take, a snapshot's events", () => {
  const scoredFinal = snapshot({
    status: "final",
    period: 4,
    clock: "0:00",
    home: { ...live.home, score: 3 }
  })

  it("before any plays, a score change is the snapshot's", () => {
    const { events } = liveGame.take(Delivery.Snapshot({ snapshot: scoredFinal, from: "poll" }), later)
    assert.include(
      events.map((event) => event._tag),
      "ScoreChanged"
    )
    assert.include(
      events.map((event) => event._tag),
      "WentFinal"
    )
  })
  it("once plays exist, the plays own the score change, and the snapshot still goes final", () => {
    const withPlay = Option.getOrThrow(
      liveGame.take(Delivery.Plays({ game: live.id, plays: [play()] }), later).liveGame
    )
    const { events } = withPlay.take(Delivery.Snapshot({ snapshot: scoredFinal, from: "poll" }), later)
    assert.notInclude(
      events.map((event) => event._tag),
      "ScoreChanged"
    )
    assert.include(
      events.map((event) => event._tag),
      "WentFinal"
    )
  })
  it("moves the watchability on with them", () => {
    const next = taken(liveGame, scoredFinal, "poll", later)
    assert.deepStrictEqual(
      next.pipe(Option.map((game) => game.watchability)),
      Option.some(liveGame.watchability.next(live, scoredFinal, scoredFinal.eventsSince(live), later))
    )
  })
  it("keeps the plays", () => {
    const withPlay = Option.getOrThrow(
      liveGame.take(Delivery.Plays({ game: live.id, plays: [play()] }), later).liveGame
    )
    assert.deepStrictEqual(
      taken(withPlay, scoredFinal, "poll", later).pipe(Option.map((game) => game.plays)),
      Option.some([play()])
    )
  })
  it("a snapshot behind gives no events", () => {
    assert.deepStrictEqual(liveGame.take(Delivery.Snapshot({ snapshot: liveBehind, from: "poll" }), later), {
      liveGame: Option.none(),
      events: []
    })
  })
})

describe("LiveGame#wakeAt", () => {
  it("a live game wakes for its watchability before it goes stale", () => {
    // Play counts as stopped 60 s after it last showed; stale comes at 90 s.
    assert.deepStrictEqual(liveGame.wakeAt(t0), Option.some(DateTime.addDuration(t0, Duration.seconds(60))))
  })
  it("a live game wakes when it goes stale if that is earlier", () => {
    const playedAt = DateTime.addDuration(t0, Duration.seconds(50))
    const played = Option.getOrThrow(
      liveGame.take(Delivery.Plays({ game: live.id, plays: [play()] }), playedAt).liveGame
    )
    assert.deepStrictEqual(
      played.wakeAt(playedAt),
      Option.some(DateTime.addDuration(t0, Duration.seconds(90)))
    )
  })
  it("an upcoming, stale, or over game never wakes for watchability", () => {
    assert.deepStrictEqual(upcomingGame.wakeAt(t0), Option.none())
    assert.deepStrictEqual(staleGame.wakeAt(t0), Option.none())
    assert.deepStrictEqual(overGame.wakeAt(t0), Option.none())
  })
})
