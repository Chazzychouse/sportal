import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Option } from "effect"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import { GameSnapshot } from "./Game.ts"
import { GameEventKind } from "./GameEvent.ts"
import { LiveGame, LiveGameState } from "./LiveGame.ts"
import { type Play, PlayId } from "./Play.ts"
import { completion, liveSnapshot, play, snapshot } from "./TestGame.ts"

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

describe("LiveGame#updatedAt", () => {
  it("should be none for an upcoming game", () => {
    assert.deepStrictEqual(upcomingGame.updatedAt(), Option.none())
  })

  it("should be the instant of a live game", () => {
    assert.deepStrictEqual(liveGame.updatedAt(), Option.some(t0))
  })

  it("should be the instant of a stale game", () => {
    assert.deepStrictEqual(staleGame.updatedAt(), Option.some(t0))
  })

  it("should be none for a game that is over", () => {
    assert.deepStrictEqual(overGame.updatedAt(), Option.none())
  })
})

describe("LiveGame.start", () => {
  it("should start Upcoming on an upcoming snapshot", () => {
    assert.deepStrictEqual(upcomingGame.state, LiveGameState.Upcoming())
  })

  it("should start Live, updated now, on a live snapshot", () => {
    assert.deepStrictEqual(liveGame.state, liveAt(t0))
  })

  it("should start Over on a final snapshot", () => {
    assert.deepStrictEqual(overGame.state, LiveGameState.Over())
  })

  it("should start with no plays", () => {
    assert.deepStrictEqual(liveGame.plays, [])
  })
})

describe("LiveGame#take, a snapshot", () => {
  it("should stay Upcoming when an Upcoming game takes an upcoming snapshot", () => {
    const next = taken(upcomingGame, upcoming, "poll", later)

    assert.deepStrictEqual(stateOf(next), Option.some(LiveGameState.Upcoming()))
  })

  it("should go Live, refreshed, when an Upcoming game takes a live snapshot", () => {
    const next = taken(upcomingGame, live, "poll", later)

    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(later)))
  })

  it("should go Over when an Upcoming game takes a final snapshot", () => {
    const next = taken(upcomingGame, over, "poll", later)

    assert.deepStrictEqual(stateOf(next), Option.some(LiveGameState.Over()))
  })

  // Unreachable through start and take; kept so every cell of the transition table is covered.
  it("should take nothing when an Upcoming game takes a snapshot behind it", () => {
    const ahead = new LiveGame({ ...liveGame, state: LiveGameState.Upcoming() })

    const next = taken(ahead, upcoming, "poll", later)

    assert.deepStrictEqual(next, Option.none())
  })

  it("should take nothing when a Live game takes an upcoming snapshot, which is behind", () => {
    const next = taken(liveGame, upcoming, "poll", later)

    assert.deepStrictEqual(next, Option.none())
  })

  it("should take nothing when a Live game takes a snapshot behind it", () => {
    const next = taken(liveGame, liveBehind, "poll", later)

    assert.deepStrictEqual(next, Option.none())
  })

  it("should stay Live, refreshed, when a Live game takes a live snapshot", () => {
    const ahead = snapshot({ status: "live", period: 2, clock: "9:00" })

    const next = taken(liveGame, ahead, "poll", later)

    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(later)))
  })

  it("should go Over when a Live game takes a final snapshot", () => {
    const next = taken(liveGame, over, "poll", later)

    assert.deepStrictEqual(stateOf(next), Option.some(LiveGameState.Over()))
  })

  it("should take nothing when a Stale game takes an upcoming snapshot, which is behind", () => {
    const next = taken(staleGame, upcoming, "poll", later)

    assert.deepStrictEqual(next, Option.none())
  })

  it("should take nothing when a Stale game takes a snapshot behind it", () => {
    const next = taken(staleGame, liveBehind, "poll", later)

    assert.deepStrictEqual(next, Option.none())
  })

  it("should go Live, refreshed, when a Stale game takes a live snapshot", () => {
    const next = taken(staleGame, live, "poll", later)

    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(later)))
  })

  it("should go Over when a Stale game takes a final snapshot", () => {
    const next = taken(staleGame, over, "poll", later)

    assert.deepStrictEqual(stateOf(next), Option.some(LiveGameState.Over()))
  })

  it("should take nothing when a game that is Over takes an upcoming snapshot, which is behind", () => {
    const next = taken(overGame, upcoming, "poll", later)

    assert.deepStrictEqual(next, Option.none())
  })

  it("should take nothing when a game that is Over takes a live snapshot, which is behind", () => {
    const next = taken(overGame, live, "poll", later)

    assert.deepStrictEqual(next, Option.none())
  })

  it("should go Live when a game that is Over takes overtime after the final", () => {
    const overtime = snapshot({ status: "live", period: 5, clock: "15:00" })

    const next = taken(overGame, overtime, "poll", later)

    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(later)))
  })

  it("should replace the snapshot when a game that is Over takes overtime after the final", () => {
    const overtime = snapshot({ status: "live", period: 5, clock: "15:00" })

    const next = taken(overGame, overtime, "poll", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(overtime))
  })

  it("should stay Over when a game that is Over takes a corrected final snapshot", () => {
    const corrected = snapshot({
      status: "final",
      period: 4,
      clock: "0:00",
      home: { ...over.home, score: 7 }
    })

    const next = taken(overGame, corrected, "poll", later)

    assert.deepStrictEqual(stateOf(next), Option.some(LiveGameState.Over()))
  })

  it("should replace the snapshot when a game that is Over takes a corrected final snapshot", () => {
    const corrected = snapshot({
      status: "final",
      period: 4,
      clock: "0:00",
      home: { ...over.home, score: 7 }
    })

    const next = taken(overGame, corrected, "poll", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(corrected))
  })

  it("should replace the snapshot with the one taken", () => {
    const scored = snapshot({ status: "live", period: 2, clock: "9:00", home: { ...live.home, score: 3 } })

    const next = taken(liveGame, scored, "poll", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(scored))
  })

  it("should refresh updatedAt when the snapshot taken is identical", () => {
    const next = taken(liveGame, live, "poll", later)

    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(later)))
  })
})

describe("LiveGame#take, a snapshot, ties between the feeds", () => {
  const touchdown = snapshot({ status: "live", period: 2, clock: "4:12", home: { ...live.home, score: 13 } })
  const tried = snapshot({ status: "live", period: 2, clock: "4:12", home: { ...live.home, score: 14 } })
  const pushed = LiveGame.start(tried, "push", t0)

  it("should find a poll with fewer points at the same game time on a pushed live game behind", () => {
    const next = taken(pushed, touchdown, "poll", later)

    assert.deepStrictEqual(next, Option.none())
  })

  it("should take a tied poll on a polled live game", () => {
    const polled = LiveGame.start(tried, "poll", t0)

    const next = taken(polled, touchdown, "poll", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(touchdown))
  })

  it("should take a tied push on a pushed live game, as an overturned score is", () => {
    const next = taken(pushed, touchdown, "push", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(touchdown))
  })

  it("should take a tied push on a pushed live game from the push", () => {
    const next = taken(pushed, touchdown, "push", later)

    assert.deepStrictEqual(sourceOf(next), Option.some("push"))
  })

  it("should take a tied poll on a stale pushed game, from the poll, Live", () => {
    const stale = new LiveGame({ ...pushed, state: LiveGameState.Stale({ updatedAt: t0 }) })

    const next = taken(stale, touchdown, "poll", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(touchdown))
    assert.deepStrictEqual(sourceOf(next), Option.some("poll"))
    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(later)))
  })

  it("should keep the pushed snapshot when a poll is ahead of a pushed live game", () => {
    const ahead = snapshot({ status: "live", period: 2, clock: "4:05", home: { ...live.home, score: 14 } })

    const next = taken(pushed, ahead, "poll", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(tried))
  })

  it("should hold a poll ahead of a pushed live game", () => {
    const ahead = snapshot({ status: "live", period: 2, clock: "4:05", home: { ...live.home, score: 14 } })

    const next = taken(pushed, ahead, "poll", later)

    assert.deepStrictEqual(next.pipe(Option.map((game) => game.state._tag)), Option.some("Holding"))
  })
})

describe("LiveGame#take and #tick, a covered game and a poll ahead of it", () => {
  const now = DateTime.addDuration(t0, Duration.seconds(5))
  const until = DateTime.addDuration(now, LiveGame.fallbackAfter)
  const covered = LiveGame.start(liveAtScore(14, 7), "push", t0)
  const holding = Option.getOrThrow(take(covered, liveAtScore(14, 7, "4:30"), "poll", now).liveGame)

  it("should cover a live game from the push", () => {
    assert.isTrue(covered.isCovered())
  })

  it("should cover a holding game", () => {
    assert.isTrue(holding.isCovered())
  })

  it("should not cover a live game from the poll", () => {
    const polled = LiveGame.start(liveAtScore(14, 7), "poll", t0)

    assert.isFalse(polled.isCovered())
  })

  it("should not cover a stale game", () => {
    const stale = new LiveGame({ ...covered, state: LiveGameState.Stale({ updatedAt: t0 }) })

    assert.isFalse(stale.isCovered())
  })

  it("should hold a poll at a later clock on a covered live game, until fallbackAfter from now", () => {
    const polled = liveAtScore(14, 7, "4:30")

    const { liveGame: next } = take(covered, polled, "poll", now)

    assert.deepStrictEqual(stateOf(next), Option.some(holdingAt(polled, now, until)))
  })

  it("should keep the pushed snapshot while holding a poll", () => {
    const { liveGame: next } = take(covered, liveAtScore(14, 7, "4:30"), "poll", now)

    assert.deepStrictEqual(snapshotOf(next), Option.some(covered.snapshot))
  })

  it("should say no events while holding a poll", () => {
    const { events } = take(covered, liveAtScore(14, 7, "4:30"), "poll", now)

    assert.deepStrictEqual(events, [])
  })

  it("should call the outcome of holding a poll held", () => {
    const { outcome } = take(covered, liveAtScore(14, 7, "4:30"), "poll", now)

    assert.strictEqual(outcome, "held")
  })

  it("should hold a poll at the same game time with a higher home score", () => {
    const polled = liveAtScore(17, 7)

    const { liveGame: next, outcome } = take(covered, polled, "poll", now)

    assert.deepStrictEqual(stateOf(next), Option.some(holdingAt(polled, now, until)))
    assert.strictEqual(outcome, "held")
  })

  it("should hold a poll at the same game time with equal points split differently", () => {
    const { outcome } = take(covered, liveAtScore(7, 14), "poll", now)

    assert.strictEqual(outcome, "held")
  })

  it("should take an equal poll on a covered live game, updated now", () => {
    const { liveGame: next } = take(covered, liveAtScore(14, 7), "poll", now)

    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(now)))
  })

  it("should keep the pushed snapshot and source on an equal poll", () => {
    const { liveGame: next } = take(covered, liveAtScore(14, 7), "poll", now)

    assert.deepStrictEqual(snapshotOf(next), Option.some(covered.snapshot))
    assert.deepStrictEqual(sourceOf(next), Option.some("push"))
  })

  it("should say no events on an equal poll, and call it taken", () => {
    const { events, outcome } = take(covered, liveAtScore(14, 7), "poll", now)

    assert.deepStrictEqual(events, [])
    assert.strictEqual(outcome, "taken")
  })

  it("should find a poll behind a covered live game behind", () => {
    const result = take(covered, liveAtScore(14, 7, "6:00"), "poll", now)

    assert.deepStrictEqual(result, { liveGame: Option.none(), events: [], outcome: "behind" })
  })

  it("should find a poll at the same game time with fewer points behind a covered live game behind", () => {
    const result = take(covered, liveAtScore(10, 7), "poll", now)

    assert.deepStrictEqual(result, { liveGame: Option.none(), events: [], outcome: "behind" })
  })

  it("should apply a poll at the same game time with fewer points to a game that is not covered", () => {
    const polled = LiveGame.start(liveAtScore(14, 7), "poll", t0)

    const { liveGame: next } = take(polled, liveAtScore(10, 7), "poll", now)

    assert.deepStrictEqual(snapshotOf(next), Option.some(liveAtScore(10, 7)))
  })

  it("should call the outcome of applying a poll to a game that is not covered taken", () => {
    const polled = LiveGame.start(liveAtScore(14, 7), "poll", t0)

    const { outcome } = take(polled, liveAtScore(10, 7), "poll", now)

    assert.strictEqual(outcome, "taken")
  })

  it("should find the PAT flicker of 2026-10-05, a poll at 20-14 on a covered 21-14 on the same clock, behind with no hold", () => {
    const afterTry = LiveGame.start(liveAtScore(21, 14, "2:03"), "push", t0)

    const { liveGame: next, outcome } = take(afterTry, liveAtScore(20, 14, "2:03"), "poll", now)

    assert.deepStrictEqual(next, Option.none())
    assert.strictEqual(outcome, "behind")
  })

  it("should find a poll still at the end of the second period behind a covered halftime, with no hold", () => {
    const atHalf = LiveGame.start(halftimeAt(14, 7), "push", t0)

    const result = take(atHalf, liveAtScore(14, 7, "0:00"), "poll", now)

    assert.deepStrictEqual(result, { liveGame: Option.none(), events: [], outcome: "behind" })
  })

  it("should hold a poll at halftime on a game covered at the end of the second period", () => {
    const endOfHalf = LiveGame.start(liveAtScore(14, 7, "0:00"), "push", t0)

    const { liveGame: next, outcome } = take(endOfHalf, halftimeAt(14, 7), "poll", now)

    assert.deepStrictEqual(stateOf(next), Option.some(holdingAt(halftimeAt(14, 7), now, until)))
    assert.strictEqual(outcome, "held")
  })

  it("should replace held, keeping until, when a holding game takes a poll further ahead", () => {
    const further = liveAtScore(14, 7, "4:00")
    const at = DateTime.addDuration(now, Duration.seconds(10))

    const { liveGame: next } = take(holding, further, "poll", at)

    assert.deepStrictEqual(stateOf(next), Option.some(holdingAt(further, at, until)))
  })

  it("should keep the snapshot and call it held when a holding game takes a poll further ahead", () => {
    const at = DateTime.addDuration(now, Duration.seconds(10))

    const { liveGame: next, outcome } = take(holding, liveAtScore(14, 7, "4:00"), "poll", at)

    assert.deepStrictEqual(snapshotOf(next), Option.some(covered.snapshot))
    assert.strictEqual(outcome, "held")
  })

  it("should refresh updatedAt, still holding, when a holding game takes a poll equal to the snapshot", () => {
    const at = DateTime.addDuration(now, Duration.seconds(10))

    const { liveGame: next } = take(holding, liveAtScore(14, 7), "poll", at)

    assert.deepStrictEqual(stateOf(next), Option.some(holdingAt(liveAtScore(14, 7, "4:30"), at, until)))
  })

  it("should call a poll equal to the snapshot taken by a holding game", () => {
    const at = DateTime.addDuration(now, Duration.seconds(10))

    const { outcome } = take(holding, liveAtScore(14, 7), "poll", at)

    assert.strictEqual(outcome, "taken")
  })

  it("should find a poll neither ahead of held nor equal to the snapshot behind a holding game", () => {
    const { liveGame: next, outcome } = take(holding, liveAtScore(14, 7, "4:45"), "poll", now)

    assert.deepStrictEqual(next, Option.none())
    assert.strictEqual(outcome, "behind")
  })

  it("should go Live from a push at held's game time, dropping held", () => {
    const pushed = liveAtScore(21, 7, "4:30")

    const { liveGame: next } = take(holding, pushed, "push", now)

    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(now)))
    assert.deepStrictEqual(snapshotOf(next), Option.some(pushed))
  })

  it("should say held's events when a push at held's game time ends the hold", () => {
    const { events } = take(holding, liveAtScore(21, 7, "4:30"), "push", now)

    assert.deepStrictEqual(events, [GameEventKind.ScoreChanged({ team: live.home.team.id, points: 7 })])
  })

  it("should call a push at held's game time taken", () => {
    const { outcome } = take(holding, liveAtScore(21, 7, "4:30"), "push", now)

    assert.strictEqual(outcome, "taken")
  })

  it("should apply a push behind held but ahead of the snapshot", () => {
    const pushed = liveAtScore(14, 7, "4:45")

    const { liveGame: next } = take(holding, pushed, "push", now)

    assert.deepStrictEqual(snapshotOf(next), Option.some(pushed))
  })

  it("should still hold after a push behind held but ahead of the snapshot", () => {
    const { liveGame: next } = take(holding, liveAtScore(14, 7, "4:45"), "push", now)

    assert.deepStrictEqual(stateOf(next), Option.some(holdingAt(liveAtScore(14, 7, "4:30"), now, until)))
  })

  it("should go Live from the poll, with held the snapshot, when a tick reaches until", () => {
    const scoring = Option.getOrThrow(take(covered, liveAtScore(21, 7, "4:30"), "poll", now).liveGame)

    const { liveGame: next } = scoring.tick(until)

    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(until)))
    assert.deepStrictEqual(snapshotOf(next), Option.some(liveAtScore(21, 7, "4:30")))
    assert.deepStrictEqual(sourceOf(next), Option.some("poll"))
  })

  it("should say held's events when a tick reaches until", () => {
    const scoring = Option.getOrThrow(take(covered, liveAtScore(21, 7, "4:30"), "poll", now).liveGame)

    const { events } = scoring.tick(until)

    assert.deepStrictEqual(events, [GameEventKind.ScoreChanged({ team: live.home.team.id, points: 7 })])
  })

  it("should report that a tick reaching until fell back", () => {
    const scoring = Option.getOrThrow(take(covered, liveAtScore(21, 7, "4:30"), "poll", now).liveGame)

    const { fellBack } = scoring.tick(until)

    assert.isTrue(fellBack)
  })

  it("should change nothing when a tick comes before until", () => {
    const { liveGame: next } = holding.tick(DateTime.subtractDuration(until, Duration.millis(1)))

    assert.deepStrictEqual(next, Option.none())
  })

  it("should not report a fall back when a tick comes before until", () => {
    const { fellBack } = holding.tick(DateTime.subtractDuration(until, Duration.millis(1)))

    assert.isFalse(fellBack)
  })

  it("should be due at until when holding", () => {
    assert.deepStrictEqual(holding.dueAfter(now), Option.some(until))
  })

  it("should be current when holding", () => {
    assert.isTrue(holding.isCurrent(now))
  })

  it("should be updated when the hold began", () => {
    assert.deepStrictEqual(holding.updatedAt(), Option.some(now))
  })

  it("should apply a poll ahead at once to a game that is not covered", () => {
    const polled = LiveGame.start(liveAtScore(14, 7), "poll", t0)
    const ahead = liveAtScore(21, 7, "4:30")

    const { liveGame: next } = take(polled, ahead, "poll", now)

    assert.deepStrictEqual(snapshotOf(next), Option.some(ahead))
    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(now)))
  })

  it("should call a poll ahead of a game that is not covered taken", () => {
    const polled = LiveGame.start(liveAtScore(14, 7), "poll", t0)

    const { outcome } = take(polled, liveAtScore(21, 7, "4:30"), "poll", now)

    assert.strictEqual(outcome, "taken")
  })

  it("should apply a poll at kickoff with status live at once to an upcoming game", () => {
    const kickoff = liveSnapshot({ clock: "15:00" })

    const { liveGame: next } = take(upcomingGame, kickoff, "poll", now)

    assert.deepStrictEqual(snapshotOf(next), Option.some(kickoff))
    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(now)))
  })

  it("should call a poll at kickoff with status live taken by an upcoming game", () => {
    const { outcome } = take(upcomingGame, liveSnapshot({ clock: "15:00" }), "poll", now)

    assert.strictEqual(outcome, "taken")
  })
})

describe("LiveGame#tick, staleness", () => {
  const staleTime = DateTime.addDuration(t0, Duration.seconds(90))

  it("should never make an Upcoming game stale", () => {
    assert.deepStrictEqual(stateAfterTick(upcomingGame, staleTime), LiveGameState.Upcoming())
  })

  it("should keep a Live game Live at updatedAt + 89 s", () => {
    const state = stateAfterTick(liveGame, DateTime.addDuration(t0, Duration.seconds(89)))

    assert.deepStrictEqual(state, liveAt(t0))
  })

  it("should make a Live game Stale at exactly updatedAt + 90 s", () => {
    const next = ticked(liveGame, staleTime)

    assert.deepStrictEqual(stateOf(next), Option.some(LiveGameState.Stale({ updatedAt: t0 })))
  })

  it("should keep a game refreshed at 60 s Live at 149 s", () => {
    const refreshedAt = DateTime.addDuration(t0, Duration.seconds(60))
    const refreshed = refreshedLiveGame(refreshedAt)

    const state = stateAfterTick(refreshed, DateTime.addDuration(t0, Duration.seconds(149)))

    assert.deepStrictEqual(state, liveAt(refreshedAt))
  })

  it("should make a game refreshed at 60 s Stale at 150 s", () => {
    const refreshedAt = DateTime.addDuration(t0, Duration.seconds(60))
    const refreshed = refreshedLiveGame(refreshedAt)

    const state = stateAfterTick(refreshed, DateTime.addDuration(t0, Duration.seconds(150)))

    assert.deepStrictEqual(state, LiveGameState.Stale({ updatedAt: refreshedAt }))
  })

  it("should go live again on the next snapshot after going Stale", () => {
    const stale = Option.getOrThrow(ticked(liveGame, staleTime))
    const next = snapshot({ status: "live", period: 2, clock: "9:00" })

    const resumed = taken(stale, next, "poll", staleTime)

    assert.deepStrictEqual(stateOf(resumed), Option.some(liveAt(staleTime)))
  })

  it("should keep a Stale game Stale", () => {
    const state = stateAfterTick(staleGame, staleTime)

    assert.deepStrictEqual(state, LiveGameState.Stale({ updatedAt: t0 }))
  })

  it("should never make a game that is Over stale, and change nothing", () => {
    const next = ticked(overGame, staleTime)

    assert.deepStrictEqual(next, Option.none())
  })
})

describe("LiveGame#isCurrent", () => {
  it("should be current when Live", () => {
    assert.isTrue(liveGame.isCurrent(later))
  })

  it("should be current when Stale", () => {
    assert.isTrue(staleGame.isCurrent(later))
  })

  it("should be current when Stale at updatedAt + 29:59", () => {
    const now = DateTime.addDuration(t0, Duration.seconds(30 * 60 - 1))

    assert.isTrue(staleGame.isCurrent(now))
  })

  it("should not be current when Stale at updatedAt + 30:00", () => {
    const now = DateTime.addDuration(t0, Duration.minutes(30))

    assert.isFalse(staleGame.isCurrent(now))
  })

  it("should not be current when Over", () => {
    assert.isFalse(overGame.isCurrent(later))
  })

  it("should be current when Upcoming with kickoff exactly 30 minutes away", () => {
    const now = DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30))

    assert.isTrue(upcomingGame.isCurrent(now))
  })

  it("should not be current when Upcoming with kickoff 30 minutes and 1 second away", () => {
    const now = DateTime.subtractDuration(upcoming.kickoff, Duration.seconds(30 * 60 + 1))

    assert.isFalse(upcomingGame.isCurrent(now))
  })
})

describe("LiveGame#dueAfter", () => {
  it("should be when a Live game goes stale, updatedAt + 90 s", () => {
    assert.deepStrictEqual(
      liveGame.dueAfter(later),
      Option.some(DateTime.addDuration(t0, Duration.seconds(90)))
    )
  })

  it("should be when a Stale game leaves the live-feed window, updatedAt + 30 minutes", () => {
    assert.deepStrictEqual(
      staleGame.dueAfter(later),
      Option.some(DateTime.addDuration(t0, Duration.minutes(30)))
    )
  })

  it("should be when an Upcoming game enters the live-feed window, kickoff - 30 minutes", () => {
    const opens = DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30))
    const justBefore = DateTime.subtractDuration(opens, Duration.seconds(1))

    assert.deepStrictEqual(upcomingGame.dueAfter(justBefore), Option.some(opens))
  })

  it("should be none for an Upcoming game already inside the window", () => {
    assert.deepStrictEqual(upcomingGame.dueAfter(upcoming.kickoff), Option.none())
  })

  it("should be none for a game that is Over", () => {
    assert.deepStrictEqual(overGame.dueAfter(later), Option.none())
  })

  it("should not call a Live game's stale instant equal to now after it", () => {
    const staleAt = DateTime.addDuration(t0, Duration.seconds(90))

    assert.deepStrictEqual(liveGame.dueAfter(staleAt), Option.none())
  })

  it("should not call an Upcoming game's window instant equal to now after it", () => {
    const opens = DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30))

    assert.deepStrictEqual(upcomingGame.dueAfter(opens), Option.none())
  })
})

describe("LiveGame.earliest", () => {
  it("should be none of nothing", () => {
    assert.deepStrictEqual(LiveGame.earliest([]), Option.none())
  })

  it("should be none of only nones", () => {
    assert.deepStrictEqual(LiveGame.earliest([Option.none()]), Option.none())
  })

  it("should be the earliest of some, ignoring nones", () => {
    const earliest = LiveGame.earliest([Option.some(later), Option.none(), Option.some(t0)])

    assert.deepStrictEqual(earliest, Option.some(t0))
  })
})

describe("LiveGame#take, plays", () => {
  const first = play()
  const second = completion({
    id: PlayId.make("2"),
    sequence: 2,
    scoring: true,
    homeScore: 7,
    touchdown: true
  })
  const withFirst = Option.getOrThrow(takePlays(liveGame, [first]).liveGame)

  it("should replace the list, in Play.order", () => {
    const { liveGame: next } = takePlays(withFirst, [second, first])

    assert.deepStrictEqual(playsOf(next), Option.some([first, second]))
  })

  it("should give the new plays' events", () => {
    const { events } = takePlays(withFirst, [second, first])

    assert.deepStrictEqual(events, [GameEventKind.Played({ play: second })])
  })

  it("should keep the snapshot", () => {
    const { liveGame: next } = takePlays(withFirst, [first, second])

    assert.deepStrictEqual(snapshotOf(next), Option.some(live))
  })

  it("should keep the snapshot's source", () => {
    const { liveGame: next } = takePlays(withFirst, [first, second])

    assert.deepStrictEqual(sourceOf(next), Option.some("poll"))
  })

  it("should keep the state", () => {
    const { liveGame: next } = takePlays(withFirst, [first, second])

    assert.deepStrictEqual(stateOf(next), Option.some(liveAt(t0)))
  })

  it("should take nothing for an identical list", () => {
    const result = takePlays(withFirst, [first])

    assert.deepStrictEqual(result, { liveGame: Option.none(), events: [] })
  })

  it("should take nothing for an equal list of equal plays", () => {
    const result = takePlays(withFirst, [play()])

    assert.deepStrictEqual(result, { liveGame: Option.none(), events: [] })
  })

  it("should drop a play removed from the list", () => {
    const both = Option.getOrThrow(takePlays(withFirst, [first, second]).liveGame)

    const { liveGame: next } = takePlays(both, [first])

    assert.deepStrictEqual(playsOf(next), Option.some([first]))
  })

  it("should give no events for a play removed from the list", () => {
    const both = Option.getOrThrow(takePlays(withFirst, [first, second]).liveGame)

    const { events } = takePlays(both, [first])

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
  const scored = snapshot({ status: "live", period: 2, clock: "9:00", home: { ...live.home, score: 7 } })
  const touchdown = completion({
    id: PlayId.make("2"),
    sequence: 2,
    scoring: true,
    homeScore: 7,
    touchdown: true
  })

  it("should say ScoreChanged for a score change before any plays", () => {
    const { events } = take(liveGame, scoredFinal, "poll", later)

    assert.include(tagsOf(events), "ScoreChanged")
  })

  it("should say WentFinal for a final before any plays", () => {
    const { events } = take(liveGame, scoredFinal, "poll", later)

    assert.include(tagsOf(events), "WentFinal")
  })

  it("should say ScoreChanged for a score change once plays exist", () => {
    const withPlay = Option.getOrThrow(takePlays(liveGame, [play()]).liveGame)

    const { events } = take(withPlay, scoredFinal, "poll", later)

    assert.include(tagsOf(events), "ScoreChanged")
  })

  it("should say WentFinal for a final once plays exist", () => {
    const withPlay = Option.getOrThrow(takePlays(liveGame, [play()]).liveGame)

    const { events } = take(withPlay, scoredFinal, "poll", later)

    assert.include(tagsOf(events), "WentFinal")
  })

  it("should say ScoreChanged for a snapshot's score change that comes before the touchdown pass", () => {
    const withPlay = Option.getOrThrow(takePlays(liveGame, [play()]).liveGame)

    const byScore = take(withPlay, scored, "poll", later)

    assert.deepStrictEqual(byScore.events, [
      GameEventKind.ScoreChanged({ team: live.home.team.id, points: 7 })
    ])
  })

  it("should say only Played for the touchdown pass after the snapshot's score change", () => {
    const withPlay = Option.getOrThrow(takePlays(liveGame, [play()]).liveGame)
    const byScore = take(withPlay, scored, "poll", later)

    const byPlay = takePlays(Option.getOrThrow(byScore.liveGame), [play(), touchdown])

    assert.deepStrictEqual(byPlay.events, [GameEventKind.Played({ play: touchdown })])
  })

  it("should say only Played for the touchdown pass that comes before the snapshot's score change", () => {
    const withPlay = Option.getOrThrow(takePlays(liveGame, [play()]).liveGame)

    const byPlay = takePlays(withPlay, [play(), touchdown])

    assert.deepStrictEqual(byPlay.events, [GameEventKind.Played({ play: touchdown })])
  })

  it("should say ScoreChanged once for the snapshot's score change after the touchdown pass", () => {
    const withPlay = Option.getOrThrow(takePlays(liveGame, [play()]).liveGame)
    const byPlay = takePlays(withPlay, [play(), touchdown])

    const bySnapshot = take(Option.getOrThrow(byPlay.liveGame), scored, "poll", later)

    assert.deepStrictEqual(bySnapshot.events, [
      GameEventKind.ScoreChanged({ team: live.home.team.id, points: 7 })
    ])
  })

  it("should keep the plays when it takes a snapshot", () => {
    const withPlay = Option.getOrThrow(takePlays(liveGame, [play()]).liveGame)

    const next = taken(withPlay, scoredFinal, "poll", later)

    assert.deepStrictEqual(playsOf(next), Option.some([play()]))
  })

  it("should give no events for a snapshot behind", () => {
    const result = take(liveGame, liveBehind, "poll", later)

    assert.deepStrictEqual(result, { liveGame: Option.none(), events: [], outcome: "behind" })
  })
})

function liveAt(updatedAt: DateTime.Utc) {
  return LiveGameState.Live({ updatedAt })
}

function holdingAt(held: GameSnapshot, updatedAt: DateTime.Utc, until: DateTime.Utc) {
  return LiveGameState.Holding({ updatedAt, held, until })
}

/** A live game snapshot in period 2, as the covered-game tests score it. */
function liveAtScore(home: number, away: number, clock = "5:00") {
  return liveSnapshot({
    period: 2,
    clock,
    home: { ...live.home, score: home },
    away: { ...live.away, score: away }
  })
}

function halftimeAt(home: number, away: number) {
  return new GameSnapshot({ ...liveAtScore(home, away, "0:00"), status: "halftime" })
}

function take(game: LiveGame, taking: GameSnapshot, from: DeliverySource, now: DateTime.Utc) {
  return game.take(Delivery.cases.Snapshot.make({ snapshot: taking, from }), now)
}

function taken(game: LiveGame, taking: GameSnapshot, from: DeliverySource, now: DateTime.Utc) {
  return take(game, taking, from, now).liveGame
}

function takePlays(game: LiveGame, plays: ReadonlyArray<Play>) {
  return game.take(Delivery.cases.Plays.make({ game: live.id, plays }), later)
}

function ticked(game: LiveGame, now: DateTime.Utc) {
  return game.tick(now).liveGame
}

/** The state a tick leaves, or the one the game had when the tick changed nothing. */
function stateAfterTick(game: LiveGame, now: DateTime.Utc) {
  return Option.getOrElse(ticked(game, now), () => game).state
}

/** A live game that took a snapshot at `at`. */
function refreshedLiveGame(at: DateTime.Utc) {
  const next = snapshot({ status: "live", period: 2, clock: "9:00" })
  return Option.getOrThrow(taken(liveGame, next, "poll", at))
}

function stateOf(game: Option.Option<LiveGame>) {
  return game.pipe(Option.map((g) => g.state))
}

function snapshotOf(game: Option.Option<LiveGame>) {
  return game.pipe(Option.map((g) => g.snapshot))
}

function sourceOf(game: Option.Option<LiveGame>) {
  return game.pipe(Option.map((g) => g.from))
}

function playsOf(game: Option.Option<LiveGame>) {
  return game.pipe(Option.map((g) => g.plays))
}

function tagsOf(events: ReadonlyArray<GameEventKind>) {
  return events.map((event) => event._tag)
}
