import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Option } from "effect"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import { GameSnapshot } from "./Game.ts"
import { GameEventKind } from "./GameEvent.ts"
import { LiveGame, LiveGameState } from "./LiveGame.ts"
import { type Play, PlayId } from "./Play.ts"
import { liveSnapshot, play, snapshot } from "./TestGame.ts"

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
  game.take(Delivery.cases.Snapshot.make({ snapshot: taking, from }), now).liveGame
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
  it("Over + a snapshot ahead of it, overtime after a final: Live", () => {
    const overtime = snapshot({ status: "live", period: 5, clock: "15:00" })
    const next = taken(overGame, overtime, "poll", later)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state)), Option.some(liveAt(later)))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(overtime))
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

  it("a poll with fewer points at the same game time on a pushed live game is behind", () => {
    assert.deepStrictEqual(taken(pushed, touchdown, "poll", later), Option.none())
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
  it("a poll ahead of a pushed live game is held, and the pushed snapshot kept", () => {
    const ahead = snapshot({ status: "live", period: 2, clock: "4:05", home: { ...live.home, score: 14 } })
    const next = taken(pushed, ahead, "poll", later)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(tried))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state._tag)), Option.some("Holding"))
  })
})

describe("LiveGame#take and #tick, a covered game and a poll ahead of it", () => {
  const now = DateTime.addDuration(t0, Duration.seconds(5))
  const until = DateTime.addDuration(now, LiveGame.fallbackAfter)
  const scored = (home: number, away: number, clock = "5:00") =>
    liveSnapshot({
      period: 2,
      clock,
      home: { ...live.home, score: home },
      away: { ...live.away, score: away }
    })
  const covered = LiveGame.start(scored(14, 7), "push", t0)
  const take = (game: LiveGame, taking: GameSnapshot, from: DeliverySource, at: DateTime.Utc) =>
    game.take(Delivery.cases.Snapshot.make({ snapshot: taking, from }), at)
  const holding = Option.getOrThrow(take(covered, scored(14, 7, "4:30"), "poll", now).liveGame)
  const holdingAt = (held: GameSnapshot) => LiveGameState.Holding({ updatedAt: now, held, until })
  const halftimeAt = (home: number, away: number) =>
    new GameSnapshot({ ...scored(home, away, "0:00"), status: "halftime" })

  it("a covered game is live or holding from the push", () => {
    assert.isTrue(covered.isCovered())
    assert.isTrue(holding.isCovered())
    assert.isFalse(LiveGame.start(scored(14, 7), "poll", t0).isCovered())
    assert.isFalse(new LiveGame({ ...covered, state: LiveGameState.Stale({ updatedAt: t0 }) }).isCovered())
  })
  it("covered Live, a poll at a later clock: Holding until fallbackAfter from now, snapshot kept, no events", () => {
    const { liveGame: next, events, outcome } = take(covered, scored(14, 7, "4:30"), "poll", now)
    assert.deepStrictEqual(
      next.pipe(Option.map((game) => game.state)),
      Option.some(holdingAt(scored(14, 7, "4:30")))
    )
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(covered.snapshot))
    assert.deepStrictEqual(events, [])
    assert.strictEqual(outcome, "held")
  })
  it("covered Live, a poll at the same game time with a higher home score: Holding", () => {
    const { liveGame: next, outcome } = take(covered, scored(17, 7), "poll", now)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state)), Option.some(holdingAt(scored(17, 7))))
    assert.strictEqual(outcome, "held")
  })
  it("covered Live, a poll at the same game time with equal points split differently: Holding", () => {
    const { outcome } = take(covered, scored(7, 14), "poll", now)
    assert.strictEqual(outcome, "held")
  })
  it("covered Live, an equal poll: Live, updated now, snapshot kept, no events, taken", () => {
    const { liveGame: next, events, outcome } = take(covered, scored(14, 7), "poll", now)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state)), Option.some(liveAt(now)))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(covered.snapshot))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.from)), Option.some("push"))
    assert.deepStrictEqual(events, [])
    assert.strictEqual(outcome, "taken")
  })
  it("covered Live, a poll behind: none, behind", () => {
    assert.deepStrictEqual(take(covered, scored(14, 7, "6:00"), "poll", now), {
      liveGame: Option.none(),
      events: [],
      outcome: "behind"
    })
  })
  it("covered Live, a poll at the same game time with fewer points: none, behind", () => {
    assert.deepStrictEqual(take(covered, scored(10, 7), "poll", now), {
      liveGame: Option.none(),
      events: [],
      outcome: "behind"
    })
  })
  it("not covered, a poll at the same game time with fewer points: applies", () => {
    const polled = LiveGame.start(scored(14, 7), "poll", t0)
    const { liveGame: next, outcome } = take(polled, scored(10, 7), "poll", now)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(scored(10, 7)))
    assert.strictEqual(outcome, "taken")
  })
  it("the PAT flicker of 2026-10-05: covered at 21–14, a poll at 20–14 on the same clock is behind, with no hold", () => {
    const afterTry = LiveGame.start(scored(21, 14, "2:03"), "push", t0)
    const { liveGame: next, outcome } = take(afterTry, scored(20, 14, "2:03"), "poll", now)
    assert.deepStrictEqual(next, Option.none())
    assert.strictEqual(outcome, "behind")
  })
  it("covered at halftime, a poll still at the end of the second period: none, behind, with no hold", () => {
    const atHalf = LiveGame.start(halftimeAt(14, 7), "push", t0)
    assert.deepStrictEqual(take(atHalf, scored(14, 7, "0:00"), "poll", now), {
      liveGame: Option.none(),
      events: [],
      outcome: "behind"
    })
  })
  it("covered at the end of the second period, a poll at halftime: Holding", () => {
    const endOfHalf = LiveGame.start(scored(14, 7, "0:00"), "push", t0)
    const { liveGame: next, outcome } = take(endOfHalf, halftimeAt(14, 7), "poll", now)
    assert.deepStrictEqual(
      next.pipe(Option.map((game) => game.state)),
      Option.some(holdingAt(halftimeAt(14, 7)))
    )
    assert.strictEqual(outcome, "held")
  })
  it("Holding, a poll further ahead of held: held replaced, until kept", () => {
    const further = scored(14, 7, "4:00")
    const at = DateTime.addDuration(now, Duration.seconds(10))
    const { liveGame: next, outcome } = take(holding, further, "poll", at)
    assert.deepStrictEqual(
      next.pipe(Option.map((game) => game.state)),
      Option.some(LiveGameState.Holding({ updatedAt: at, held: further, until }))
    )
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(covered.snapshot))
    assert.strictEqual(outcome, "held")
  })
  it("Holding, a poll equal to the snapshot: updatedAt refreshed, still holding, taken", () => {
    const at = DateTime.addDuration(now, Duration.seconds(10))
    const { liveGame: next, outcome } = take(holding, scored(14, 7), "poll", at)
    assert.deepStrictEqual(
      next.pipe(Option.map((game) => game.state)),
      Option.some(LiveGameState.Holding({ updatedAt: at, held: scored(14, 7, "4:30"), until }))
    )
    assert.strictEqual(outcome, "taken")
  })
  it("Holding, a poll neither ahead of held nor equal to the snapshot: none, behind", () => {
    const { liveGame: next, outcome } = take(holding, scored(14, 7, "4:45"), "poll", now)
    assert.deepStrictEqual(next, Option.none())
    assert.strictEqual(outcome, "behind")
  })
  it("Holding, a push at held's game time: Live from the push, held dropped, its events said", () => {
    const { liveGame: next, events, outcome } = take(holding, scored(21, 7, "4:30"), "push", now)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state)), Option.some(liveAt(now)))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(scored(21, 7, "4:30")))
    assert.deepStrictEqual(events, [GameEventKind.ScoreChanged({ team: live.home.team.id, points: 7 })])
    assert.strictEqual(outcome, "taken")
  })
  it("Holding, a push behind held but ahead of the snapshot: applies, still Holding", () => {
    const { liveGame: next } = take(holding, scored(14, 7, "4:45"), "push", now)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(scored(14, 7, "4:45")))
    assert.deepStrictEqual(
      next.pipe(Option.map((game) => game.state)),
      Option.some(holdingAt(scored(14, 7, "4:30")))
    )
  })
  it("Holding, a tick at until: Live from the poll, held the snapshot, its events said, fellBack", () => {
    const scoring = Option.getOrThrow(take(covered, scored(21, 7, "4:30"), "poll", now).liveGame)
    const { liveGame: next, events, fellBack } = scoring.tick(until)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state)), Option.some(liveAt(until)))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(scored(21, 7, "4:30")))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.from)), Option.some("poll"))
    assert.deepStrictEqual(events, [GameEventKind.ScoreChanged({ team: live.home.team.id, points: 7 })])
    assert.isTrue(fellBack)
  })
  it("Holding, a tick before until: nothing", () => {
    const { liveGame: next, fellBack } = holding.tick(DateTime.subtractDuration(until, Duration.millis(1)))
    assert.deepStrictEqual(next, Option.none())
    assert.isFalse(fellBack)
  })
  it("Holding: due at until, live, and updated when the hold began", () => {
    assert.deepStrictEqual(holding.dueAfter(now), Option.some(until))
    assert.isTrue(holding.isCurrent(now))
    assert.deepStrictEqual(holding.updatedAt(), Option.some(now))
  })
  it("not covered, a poll ahead: applies at once", () => {
    const polled = LiveGame.start(scored(14, 7), "poll", t0)
    const { liveGame: next, outcome } = take(polled, scored(21, 7, "4:30"), "poll", now)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(scored(21, 7, "4:30")))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state)), Option.some(liveAt(now)))
    assert.strictEqual(outcome, "taken")
  })
  it("an upcoming game, a poll at kickoff with status live: applies at once", () => {
    const kickoff = liveSnapshot({ clock: "15:00" })
    const { liveGame: next, outcome } = take(upcomingGame, kickoff, "poll", now)
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.snapshot)), Option.some(kickoff))
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state)), Option.some(liveAt(now)))
    assert.strictEqual(outcome, "taken")
  })
})

describe("LiveGame#tick, staleness", () => {
  const staleTime = DateTime.addDuration(t0, Duration.seconds(90))
  // The state a tick leaves, or the one it had when the tick changed nothing.
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

describe("LiveGame#dueAfter", () => {
  it("Live: when it goes stale, updatedAt + 90 s", () => {
    assert.deepStrictEqual(
      liveGame.dueAfter(later),
      Option.some(DateTime.addDuration(t0, Duration.seconds(90)))
    )
  })
  it("Stale: when it leaves the live-feed window, updatedAt + 30 minutes", () => {
    assert.deepStrictEqual(
      staleGame.dueAfter(later),
      Option.some(DateTime.addDuration(t0, Duration.minutes(30)))
    )
  })
  it("Upcoming: when it enters the live-feed window, kickoff - 30 minutes", () => {
    const opens = DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30))
    assert.deepStrictEqual(
      upcomingGame.dueAfter(DateTime.subtractDuration(opens, Duration.seconds(1))),
      Option.some(opens)
    )
  })
  it("Upcoming already inside the window: none", () => {
    assert.deepStrictEqual(upcomingGame.dueAfter(upcoming.kickoff), Option.none())
  })
  it("Over: none", () => {
    assert.deepStrictEqual(overGame.dueAfter(later), Option.none())
  })
  it("an instant equal to now is not after it", () => {
    const staleAt = DateTime.addDuration(t0, Duration.seconds(90))
    assert.deepStrictEqual(liveGame.dueAfter(staleAt), Option.none())
    const opens = DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30))
    assert.deepStrictEqual(upcomingGame.dueAfter(opens), Option.none())
  })
})

describe("LiveGame.earliest", () => {
  it("is none of nothing", () => {
    assert.deepStrictEqual(LiveGame.earliest([]), Option.none())
    assert.deepStrictEqual(LiveGame.earliest([Option.none()]), Option.none())
  })
  it("is the earliest of some, ignoring nones", () => {
    assert.deepStrictEqual(
      LiveGame.earliest([Option.some(later), Option.none(), Option.some(t0)]),
      Option.some(t0)
    )
  })
})

describe("LiveGame.start, plays", () => {
  it("starts with no plays", () => {
    assert.deepStrictEqual(liveGame.plays, [])
  })
})

describe("LiveGame#take, plays", () => {
  const first = play()
  const second = play({ id: PlayId.make("2"), sequence: 2, scoring: true, homeScore: 7, touchdown: true })
  const take = (game: LiveGame, plays: ReadonlyArray<Play>) =>
    game.take(Delivery.cases.Plays.make({ game: live.id, plays }), later)
  const withFirst = Option.getOrThrow(take(liveGame, [first]).liveGame)
  const secondsEvents = [GameEventKind.Played({ play: second })]

  it("replaces the list, in Play.order, and gives the new plays' events", () => {
    const { liveGame: next, events } = take(withFirst, [second, first])
    assert.deepStrictEqual(next.pipe(Option.map((game) => game.plays)), Option.some([first, second]))
    assert.deepStrictEqual(events, secondsEvents)
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
    const { events } = liveGame.take(
      Delivery.cases.Snapshot.make({ snapshot: scoredFinal, from: "poll" }),
      later
    )
    assert.include(
      events.map((event) => event._tag),
      "ScoreChanged"
    )
    assert.include(
      events.map((event) => event._tag),
      "WentFinal"
    )
  })
  it("once plays exist, the snapshot still gives the score change, and goes final", () => {
    const withPlay = Option.getOrThrow(
      liveGame.take(Delivery.cases.Plays.make({ game: live.id, plays: [play()] }), later).liveGame
    )
    const { events } = withPlay.take(
      Delivery.cases.Snapshot.make({ snapshot: scoredFinal, from: "poll" }),
      later
    )
    assert.include(
      events.map((event) => event._tag),
      "ScoreChanged"
    )
    assert.include(
      events.map((event) => event._tag),
      "WentFinal"
    )
  })
  it("a snapshot's score change, then the touchdown play: ScoreChanged once, then Played only", () => {
    const scored = snapshot({ status: "live", period: 2, clock: "9:00", home: { ...live.home, score: 7 } })
    const touchdown = play({
      id: PlayId.make("2"),
      sequence: 2,
      scoring: true,
      homeScore: 7,
      touchdown: true
    })
    const withPlay = Option.getOrThrow(
      liveGame.take(Delivery.cases.Plays.make({ game: live.id, plays: [play()] }), later).liveGame
    )
    const byScore = withPlay.take(Delivery.cases.Snapshot.make({ snapshot: scored, from: "poll" }), later)
    assert.deepStrictEqual(byScore.events, [
      GameEventKind.ScoreChanged({ team: live.home.team.id, points: 7 })
    ])
    const byPlay = Option.getOrThrow(byScore.liveGame).take(
      Delivery.cases.Plays.make({ game: live.id, plays: [play(), touchdown] }),
      later
    )
    assert.deepStrictEqual(byPlay.events, [GameEventKind.Played({ play: touchdown })])
  })
  it("the touchdown play, then the snapshot's score change: Played, then ScoreChanged, once each", () => {
    const scored = snapshot({ status: "live", period: 2, clock: "9:00", home: { ...live.home, score: 7 } })
    const touchdown = play({
      id: PlayId.make("2"),
      sequence: 2,
      scoring: true,
      homeScore: 7,
      touchdown: true
    })
    const withPlay = Option.getOrThrow(
      liveGame.take(Delivery.cases.Plays.make({ game: live.id, plays: [play()] }), later).liveGame
    )
    const byPlay = withPlay.take(
      Delivery.cases.Plays.make({ game: live.id, plays: [play(), touchdown] }),
      later
    )
    assert.deepStrictEqual(byPlay.events, [GameEventKind.Played({ play: touchdown })])
    const bySnapshot = Option.getOrThrow(byPlay.liveGame).take(
      Delivery.cases.Snapshot.make({ snapshot: scored, from: "poll" }),
      later
    )
    assert.deepStrictEqual(bySnapshot.events, [
      GameEventKind.ScoreChanged({ team: live.home.team.id, points: 7 })
    ])
  })
  it("keeps the plays", () => {
    const withPlay = Option.getOrThrow(
      liveGame.take(Delivery.cases.Plays.make({ game: live.id, plays: [play()] }), later).liveGame
    )
    assert.deepStrictEqual(
      taken(withPlay, scoredFinal, "poll", later).pipe(Option.map((game) => game.plays)),
      Option.some([play()])
    )
  })
  it("a snapshot behind gives no events", () => {
    assert.deepStrictEqual(
      liveGame.take(Delivery.cases.Snapshot.make({ snapshot: liveBehind, from: "poll" }), later),
      {
        liveGame: Option.none(),
        events: [],
        outcome: "behind"
      }
    )
  })
})
