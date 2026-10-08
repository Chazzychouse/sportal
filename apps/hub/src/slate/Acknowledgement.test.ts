import { assert, describe, it } from "@effect/vitest"
import { GameSnapshot } from "@sportal/domain/Game"
import { GameEventKind } from "@sportal/domain/GameEvent"
import { liveSnapshot, snapshot, tags } from "@sportal/domain/TestGame"
import { DateTime, Duration, Option } from "effect"
import { Acknowledgement } from "./Acknowledgement.ts"
import type { DeliverySource } from "./Delivery.ts"

const t0 = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
const later = DateTime.addDuration(t0, Duration.seconds(30))
// Heard from 90 s before t0, so stale from t0 on.
const staleSince = DateTime.subtractDuration(t0, Acknowledgement.staleAfter)

const upcoming = snapshot()
const live = snapshot({ status: "live", period: 2, clock: "10:00" })
const liveBehind = snapshot({ status: "live", period: 1, clock: "10:00" })
const over = snapshot({ status: "final", period: 4, clock: "0:00" })

const upcomingGame = first(upcoming, "poll", t0)
const liveGame = first(live, "poll", t0)
const overGame = first(over, "poll", t0)
const staleGame = first(live, "poll", staleSince)

describe("Acknowledgement.first", () => {
  it("should be Upcoming on an upcoming snapshot", () => {
    assert.strictEqual(stateOf(upcomingGame, t0), "Upcoming")
  })

  it("should be Live, heard now, on a live snapshot", () => {
    assert.strictEqual(stateOf(liveGame, t0), "Live")
    assert.deepStrictEqual(liveGame.acknowledgement.heardAt, t0)
  })

  it("should be Over on a final snapshot", () => {
    assert.strictEqual(stateOf(overGame, t0), "Over")
  })
})

describe("Acknowledgement.updatedAt", () => {
  it("should be none for an upcoming game", () => {
    assert.deepStrictEqual(upcomingGame.acknowledgement.updatedAt(upcoming), Option.none())
  })

  it("should be the instant of a live game", () => {
    assert.deepStrictEqual(liveGame.acknowledgement.updatedAt(live), Option.some(t0))
  })

  it("should be the instant of a stale game", () => {
    assert.deepStrictEqual(staleGame.acknowledgement.updatedAt(live), Option.some(staleSince))
  })

  it("should be none for a game that is over", () => {
    assert.deepStrictEqual(overGame.acknowledgement.updatedAt(over), Option.none())
  })

  it("should be when the hold began", () => {
    const now = DateTime.addDuration(t0, Duration.seconds(5))
    const covered = first(liveAtScore(14, 7), "push", t0)
    const holding = Option.getOrThrow(took(covered, liveAtScore(14, 7, "4:30"), "poll", now).next)

    assert.deepStrictEqual(holding.acknowledgement.updatedAt(holding.snapshot), Option.some(now))
  })
})

describe("Acknowledgement.took", () => {
  it("should stay Upcoming when an Upcoming game takes an upcoming snapshot", () => {
    const next = taken(upcomingGame, upcoming, "poll", later)

    assert.deepStrictEqual(statesOf(next, later), Option.some("Upcoming"))
  })

  it("should go Live, refreshed, when an Upcoming game takes a live snapshot", () => {
    const next = taken(upcomingGame, live, "poll", later)

    assert.deepStrictEqual(statesOf(next, later), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(later))
  })

  it("should go Over when an Upcoming game takes a final snapshot", () => {
    const next = taken(upcomingGame, over, "poll", later)

    assert.deepStrictEqual(statesOf(next, later), Option.some("Over"))
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

    assert.deepStrictEqual(statesOf(next, later), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(later))
  })

  it("should go Over when a Live game takes a final snapshot", () => {
    const next = taken(liveGame, over, "poll", later)

    assert.deepStrictEqual(statesOf(next, later), Option.some("Over"))
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

    assert.deepStrictEqual(statesOf(next, later), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(later))
  })

  it("should go Over when a Stale game takes a final snapshot", () => {
    const next = taken(staleGame, over, "poll", later)

    assert.deepStrictEqual(statesOf(next, later), Option.some("Over"))
  })

  it("should take nothing when a game that is Over takes an upcoming snapshot, which is behind", () => {
    const next = taken(overGame, upcoming, "poll", later)

    assert.deepStrictEqual(next, Option.none())
  })

  it("should take nothing when a game that is Over takes a live snapshot, which is behind", () => {
    const next = taken(overGame, live, "poll", later)

    assert.deepStrictEqual(next, Option.none())
  })

  it("should go Live on overtime after the final, taking its snapshot", () => {
    const overtime = snapshot({ status: "live", period: 5, clock: "15:00" })

    const next = taken(overGame, overtime, "poll", later)

    assert.deepStrictEqual(statesOf(next, later), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(later))
    assert.deepStrictEqual(snapshotOf(next), Option.some(overtime))
  })

  it("should stay Over on a corrected final snapshot, taking its snapshot", () => {
    const corrected = snapshot({
      status: "final",
      period: 4,
      clock: "0:00",
      home: { ...over.home, score: 7 }
    })

    const next = taken(overGame, corrected, "poll", later)

    assert.deepStrictEqual(statesOf(next, later), Option.some("Over"))
    assert.deepStrictEqual(snapshotOf(next), Option.some(corrected))
  })

  it("should replace the snapshot with the one taken", () => {
    const scored = snapshot({ status: "live", period: 2, clock: "9:00", home: { ...live.home, score: 3 } })

    const next = taken(liveGame, scored, "poll", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(scored))
  })

  it("should refresh heardAt when the snapshot taken is identical", () => {
    const next = taken(liveGame, live, "poll", later)

    assert.deepStrictEqual(statesOf(next, later), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(later))
  })

  it("should say ScoreChanged and WentFinal for a final with a score change", () => {
    const scoredFinal = snapshot({
      status: "final",
      period: 4,
      clock: "0:00",
      home: { ...live.home, score: 3 }
    })

    const { events } = took(liveGame, scoredFinal, "poll", later)

    assert.include(tags(events), "ScoreChanged")
    assert.include(tags(events), "WentFinal")
  })

  it("should give no events for a snapshot behind", () => {
    const result = took(liveGame, liveBehind, "poll", later)

    assert.deepStrictEqual(result, { next: Option.none(), events: [], outcome: "behind" })
  })
})

describe("Acknowledgement.took, ties between the feeds", () => {
  const touchdown = snapshot({ status: "live", period: 2, clock: "4:12", home: { ...live.home, score: 13 } })
  const tried = snapshot({ status: "live", period: 2, clock: "4:12", home: { ...live.home, score: 14 } })
  const pushed = first(tried, "push", t0)

  it("should find a poll with fewer points at the same game time on a pushed live game behind", () => {
    const next = taken(pushed, touchdown, "poll", later)

    assert.deepStrictEqual(next, Option.none())
  })

  it("should take a tied poll on a polled live game", () => {
    const polled = first(tried, "poll", t0)

    const next = taken(polled, touchdown, "poll", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(touchdown))
  })

  it("should take a tied push on a pushed live game, as an overturned score is, from the push", () => {
    const next = taken(pushed, touchdown, "push", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(touchdown))
    assert.deepStrictEqual(sourceOf(next), Option.some("push"))
  })

  it("should take a tied poll on a stale pushed game, from the poll, Live", () => {
    const stale = first(tried, "push", staleSince)

    const next = taken(stale, touchdown, "poll", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(touchdown))
    assert.deepStrictEqual(sourceOf(next), Option.some("poll"))
    assert.deepStrictEqual(statesOf(next, later), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(later))
  })

  it("should hold a poll ahead of a pushed live game, keeping the pushed snapshot", () => {
    const ahead = snapshot({ status: "live", period: 2, clock: "4:05", home: { ...live.home, score: 14 } })

    const next = taken(pushed, ahead, "poll", later)

    assert.deepStrictEqual(snapshotOf(next), Option.some(tried))
    assert.deepStrictEqual(statesOf(next, later), Option.some("Holding"))
  })
})

describe("Acknowledgement.took, a covered game and a poll ahead of it", () => {
  const now = DateTime.addDuration(t0, Duration.seconds(5))
  const until = DateTime.addDuration(now, Acknowledgement.fallbackAfter)
  const covered = first(liveAtScore(14, 7), "push", t0)
  const holding = Option.getOrThrow(took(covered, liveAtScore(14, 7, "4:30"), "poll", now).next)

  it("should hold a poll at a later clock on a covered live game until fallbackAfter from now, keeping the pushed snapshot", () => {
    const polled = liveAtScore(14, 7, "4:30")

    const { next, events, outcome } = took(covered, polled, "poll", now)

    assert.deepStrictEqual(statesOf(next, now), Option.some("Holding"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(now))
    assert.deepStrictEqual(heldOf(next), Option.some({ snapshot: polled, until }))
    assert.deepStrictEqual(snapshotOf(next), Option.some(covered.snapshot))
    assert.deepStrictEqual(events, [])
    assert.strictEqual(outcome, "held")
  })

  it("should hold a poll at the same game time with a higher home score", () => {
    const polled = liveAtScore(17, 7)

    const { next, outcome } = took(covered, polled, "poll", now)

    assert.deepStrictEqual(statesOf(next, now), Option.some("Holding"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(now))
    assert.deepStrictEqual(heldOf(next), Option.some({ snapshot: polled, until }))
    assert.strictEqual(outcome, "held")
  })

  it("should hold a poll at the same game time with equal points split differently", () => {
    const { outcome } = took(covered, liveAtScore(7, 14), "poll", now)

    assert.strictEqual(outcome, "held")
  })

  it("should take an equal poll on a covered live game as a refresh, heard now", () => {
    const { next, events, outcome } = took(covered, liveAtScore(14, 7), "poll", now)

    assert.deepStrictEqual(statesOf(next, now), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(now))
    assert.deepStrictEqual(snapshotOf(next), Option.some(covered.snapshot))
    assert.deepStrictEqual(sourceOf(next), Option.some("push"))
    assert.deepStrictEqual(events, [])
    assert.strictEqual(outcome, "taken")
  })

  it("should find a poll at an earlier clock than a covered live game behind it", () => {
    const result = took(covered, liveAtScore(14, 7, "6:00"), "poll", now)

    assert.deepStrictEqual(result, { next: Option.none(), events: [], outcome: "behind" })
  })

  it("should find a poll at the same game time with fewer points than a covered live game behind it", () => {
    const result = took(covered, liveAtScore(10, 7), "poll", now)

    assert.deepStrictEqual(result, { next: Option.none(), events: [], outcome: "behind" })
  })

  it("should apply a poll at the same game time with fewer points to a game that is not covered", () => {
    const polled = first(liveAtScore(14, 7), "poll", t0)

    const { next, outcome } = took(polled, liveAtScore(10, 7), "poll", now)

    assert.deepStrictEqual(snapshotOf(next), Option.some(liveAtScore(10, 7)))
    assert.strictEqual(outcome, "taken")
  })

  it("should find the PAT flicker of 2026-10-05, a poll at 20-14 on a covered 21-14 on the same clock, behind with no hold", () => {
    const afterTry = first(liveAtScore(21, 14, "2:03"), "push", t0)

    const { next, outcome } = took(afterTry, liveAtScore(20, 14, "2:03"), "poll", now)

    assert.deepStrictEqual(next, Option.none())
    assert.strictEqual(outcome, "behind")
  })

  it("should find a poll still at the end of the second period behind a covered halftime, with no hold", () => {
    const atHalf = first(halftimeAt(14, 7), "push", t0)

    const result = took(atHalf, liveAtScore(14, 7, "0:00"), "poll", now)

    assert.deepStrictEqual(result, { next: Option.none(), events: [], outcome: "behind" })
  })

  it("should hold a poll at halftime on a game covered at the end of the second period", () => {
    const endOfHalf = first(liveAtScore(14, 7, "0:00"), "push", t0)

    const { next, outcome } = took(endOfHalf, halftimeAt(14, 7), "poll", now)

    assert.deepStrictEqual(statesOf(next, now), Option.some("Holding"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(now))
    assert.deepStrictEqual(heldOf(next), Option.some({ snapshot: halftimeAt(14, 7), until }))
    assert.strictEqual(outcome, "held")
  })

  it("should replace held, keeping until and the snapshot, when a holding game takes a poll further ahead", () => {
    const further = liveAtScore(14, 7, "4:00")
    const at = DateTime.addDuration(now, Duration.seconds(10))

    const { next, outcome } = took(holding, further, "poll", at)

    assert.deepStrictEqual(statesOf(next, at), Option.some("Holding"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(at))
    assert.deepStrictEqual(heldOf(next), Option.some({ snapshot: further, until }))
    assert.deepStrictEqual(snapshotOf(next), Option.some(covered.snapshot))
    assert.strictEqual(outcome, "held")
  })

  it("should refresh heardAt, still holding, when a holding game takes a poll equal to the snapshot", () => {
    const at = DateTime.addDuration(now, Duration.seconds(10))

    const { next, outcome } = took(holding, liveAtScore(14, 7), "poll", at)

    assert.deepStrictEqual(statesOf(next, at), Option.some("Holding"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(at))
    assert.deepStrictEqual(heldOf(next), Option.some({ snapshot: liveAtScore(14, 7, "4:30"), until }))
    assert.strictEqual(outcome, "taken")
  })

  it("should find a poll neither ahead of held nor equal to the snapshot behind a holding game", () => {
    const { next, outcome } = took(holding, liveAtScore(14, 7, "4:45"), "poll", now)

    assert.deepStrictEqual(next, Option.none())
    assert.strictEqual(outcome, "behind")
  })

  it("should end the hold on a push at held's game time: Live from the push, held dropped, its events said", () => {
    const pushed = liveAtScore(21, 7, "4:30")

    const { next, events, outcome } = took(holding, pushed, "push", now)

    assert.deepStrictEqual(statesOf(next, now), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(now))
    assert.deepStrictEqual(snapshotOf(next), Option.some(pushed))
    assert.deepStrictEqual(events, [GameEventKind.ScoreChanged({ team: live.home.team.id, points: 7 })])
    assert.strictEqual(outcome, "taken")
  })

  it("should apply a push behind held but ahead of the snapshot, still holding", () => {
    const pushed = liveAtScore(14, 7, "4:45")

    const { next } = took(holding, pushed, "push", now)

    assert.deepStrictEqual(snapshotOf(next), Option.some(pushed))
    assert.deepStrictEqual(statesOf(next, now), Option.some("Holding"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(now))
    assert.deepStrictEqual(heldOf(next), Option.some({ snapshot: liveAtScore(14, 7, "4:30"), until }))
  })

  it("should apply a poll ahead at once to a game that is not covered", () => {
    const polled = first(liveAtScore(14, 7), "poll", t0)
    const ahead = liveAtScore(21, 7, "4:30")

    const { next, outcome } = took(polled, ahead, "poll", now)

    assert.deepStrictEqual(snapshotOf(next), Option.some(ahead))
    assert.deepStrictEqual(statesOf(next, now), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(now))
    assert.strictEqual(outcome, "taken")
  })

  it("should apply a poll at kickoff with status live at once to an upcoming game", () => {
    const kickoff = liveSnapshot({ clock: "15:00" })

    const { next, outcome } = took(upcomingGame, kickoff, "poll", now)

    assert.deepStrictEqual(snapshotOf(next), Option.some(kickoff))
    assert.deepStrictEqual(statesOf(next, now), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(now))
    assert.strictEqual(outcome, "taken")
  })
})

describe("Acknowledgement.ticked", () => {
  const now = DateTime.addDuration(t0, Duration.seconds(5))
  const until = DateTime.addDuration(now, Acknowledgement.fallbackAfter)
  const covered = first(liveAtScore(14, 7), "push", t0)
  const holding = Option.getOrThrow(took(covered, liveAtScore(14, 7, "4:30"), "poll", now).next)
  const staleTime = DateTime.addDuration(t0, Duration.seconds(90))

  it("should fall back to the poll when a tick reaches until: Live, held the snapshot, its events said", () => {
    const scoring = Option.getOrThrow(took(covered, liveAtScore(21, 7, "4:30"), "poll", now).next)

    const { next, events, fellBack } = scoring.acknowledgement.ticked(scoring.snapshot, until)

    assert.deepStrictEqual(statesOf(next, until), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(next), Option.some(until))
    assert.deepStrictEqual(snapshotOf(next), Option.some(liveAtScore(21, 7, "4:30")))
    assert.deepStrictEqual(sourceOf(next), Option.some("poll"))
    assert.deepStrictEqual(events, [GameEventKind.ScoreChanged({ team: live.home.team.id, points: 7 })])
    assert.isTrue(fellBack)
  })

  it("should change nothing when a tick comes before until", () => {
    const before = DateTime.subtractDuration(until, Duration.millis(1))

    const { next, fellBack } = holding.acknowledgement.ticked(holding.snapshot, before)

    assert.deepStrictEqual(next, Option.none())
    assert.isFalse(fellBack)
  })

  it("should change nothing when a live game's stale instant passes", () => {
    const { next, events, fellBack } = liveGame.acknowledgement.ticked(live, staleTime)

    assert.deepStrictEqual(next, Option.none())
    assert.deepStrictEqual(events, [])
    assert.isFalse(fellBack)
  })

  it("should never make a game that is Over stale, and change nothing", () => {
    const { next } = overGame.acknowledgement.ticked(over, staleTime)

    assert.deepStrictEqual(next, Option.none())
  })
})

describe("Acknowledgement.state", () => {
  const staleTime = DateTime.addDuration(t0, Duration.seconds(90))

  it("should never be Stale for an Upcoming game", () => {
    assert.strictEqual(stateOf(upcomingGame, staleTime), "Upcoming")
  })

  it("should keep a Live game Live at heardAt + 89 s", () => {
    const at = DateTime.addDuration(t0, Duration.seconds(89))

    assert.strictEqual(stateOf(liveGame, at), "Live")
    assert.deepStrictEqual(liveGame.acknowledgement.heardAt, t0)
  })

  it("should make a Live game Stale at exactly heardAt + 90 s", () => {
    assert.strictEqual(stateOf(liveGame, staleTime), "Stale")
    assert.deepStrictEqual(liveGame.acknowledgement.heardAt, t0)
  })

  it("should keep a game refreshed at 60 s Live at 149 s", () => {
    const refreshedAt = DateTime.addDuration(t0, Duration.seconds(60))
    const refreshed = refreshedLiveGame(refreshedAt)

    const state = stateOf(refreshed, DateTime.addDuration(t0, Duration.seconds(149)))

    assert.strictEqual(state, "Live")
    assert.deepStrictEqual(refreshed.acknowledgement.heardAt, refreshedAt)
  })

  it("should make a game refreshed at 60 s Stale at 150 s", () => {
    const refreshedAt = DateTime.addDuration(t0, Duration.seconds(60))
    const refreshed = refreshedLiveGame(refreshedAt)

    const state = stateOf(refreshed, DateTime.addDuration(t0, Duration.seconds(150)))

    assert.strictEqual(state, "Stale")
    assert.deepStrictEqual(refreshed.acknowledgement.heardAt, refreshedAt)
  })

  it("should go Live again on the next snapshot after going Stale", () => {
    const next = snapshot({ status: "live", period: 2, clock: "9:00" })

    const resumed = taken(liveGame, next, "poll", staleTime)

    assert.strictEqual(stateOf(liveGame, staleTime), "Stale")
    assert.deepStrictEqual(statesOf(resumed, staleTime), Option.some("Live"))
    assert.deepStrictEqual(heardAtOf(resumed), Option.some(staleTime))
  })

  it("should keep a Stale game Stale", () => {
    assert.strictEqual(stateOf(staleGame, staleTime), "Stale")
    assert.deepStrictEqual(staleGame.acknowledgement.heardAt, staleSince)
  })

  it("should be Holding while a poll is held", () => {
    const now = DateTime.addDuration(t0, Duration.seconds(5))
    const covered = first(liveAtScore(14, 7), "push", t0)

    const holding = taken(covered, liveAtScore(14, 7, "4:30"), "poll", now)

    assert.deepStrictEqual(statesOf(holding, now), Option.some("Holding"))
  })
})

describe("Acknowledgement.covers", () => {
  const now = DateTime.addDuration(t0, Duration.seconds(5))
  const covered = first(liveAtScore(14, 7), "push", t0)
  const holding = Option.getOrThrow(took(covered, liveAtScore(14, 7, "4:30"), "poll", now).next)

  it("should cover a live game from the push", () => {
    assert.isTrue(covers(covered, now))
  })

  it("should cover a holding game", () => {
    assert.isTrue(covers(holding, now))
  })

  it("should not cover a live game from the poll", () => {
    const polled = first(liveAtScore(14, 7), "poll", t0)

    assert.isFalse(covers(polled, now))
  })

  it("should not cover a stale game", () => {
    const stale = first(liveAtScore(14, 7), "push", staleSince)

    assert.isFalse(covers(stale, now))
  })
})

describe("Acknowledgement.isCurrent", () => {
  const now = DateTime.addDuration(t0, Duration.seconds(5))
  const covered = first(liveAtScore(14, 7), "push", t0)
  const holding = Option.getOrThrow(took(covered, liveAtScore(14, 7, "4:30"), "poll", now).next)

  it("should be current when Live", () => {
    assert.isTrue(isCurrent(liveGame, later))
  })

  it("should be current when holding", () => {
    assert.isTrue(isCurrent(holding, now))
  })

  it("should be current when Stale", () => {
    assert.isTrue(isCurrent(staleGame, later))
  })

  it("should be current when Stale at heardAt + 29:59", () => {
    const at = DateTime.addDuration(staleSince, Duration.seconds(30 * 60 - 1))

    assert.isTrue(isCurrent(staleGame, at))
  })

  it("should not be current when Stale at heardAt + 30:00", () => {
    const at = DateTime.addDuration(staleSince, Duration.minutes(30))

    assert.isFalse(isCurrent(staleGame, at))
  })

  it("should not be current when Over", () => {
    assert.isFalse(isCurrent(overGame, later))
  })

  it("should be current when Upcoming with kickoff exactly 30 minutes away", () => {
    const at = DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30))

    assert.isTrue(isCurrent(upcomingGame, at))
  })

  it("should not be current when Upcoming with kickoff 30 minutes and 1 second away", () => {
    const at = DateTime.subtractDuration(upcoming.kickoff, Duration.seconds(30 * 60 + 1))

    assert.isFalse(isCurrent(upcomingGame, at))
  })
})

describe("Acknowledgement.dueAfter", () => {
  const now = DateTime.addDuration(t0, Duration.seconds(5))
  const until = DateTime.addDuration(now, Acknowledgement.fallbackAfter)
  const covered = first(liveAtScore(14, 7), "push", t0)
  const holding = Option.getOrThrow(took(covered, liveAtScore(14, 7, "4:30"), "poll", now).next)

  it("should be when a Live game goes stale, heardAt + 90 s", () => {
    assert.deepStrictEqual(
      dueAfter(liveGame, later),
      Option.some(DateTime.addDuration(t0, Duration.seconds(90)))
    )
  })

  it("should be when a Stale game leaves the live-feed window, heardAt + 30 minutes", () => {
    assert.deepStrictEqual(
      dueAfter(staleGame, later),
      Option.some(DateTime.addDuration(staleSince, Duration.minutes(30)))
    )
  })

  it("should be when an Upcoming game enters the live-feed window, kickoff - 30 minutes", () => {
    const opens = DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30))
    const justBefore = DateTime.subtractDuration(opens, Duration.seconds(1))

    assert.deepStrictEqual(dueAfter(upcomingGame, justBefore), Option.some(opens))
  })

  it("should be none for an Upcoming game already inside the window", () => {
    assert.deepStrictEqual(dueAfter(upcomingGame, upcoming.kickoff), Option.none())
  })

  it("should be none for a game that is Over", () => {
    assert.deepStrictEqual(dueAfter(overGame, later), Option.none())
  })

  it("should not call a Live game's stale instant equal to now after it, but the end of its current window", () => {
    const staleAt = DateTime.addDuration(t0, Duration.seconds(90))

    assert.deepStrictEqual(
      dueAfter(liveGame, staleAt),
      Option.some(DateTime.addDuration(t0, Duration.minutes(30)))
    )
  })

  it("should not call an Upcoming game's window instant equal to now after it", () => {
    const opens = DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30))

    assert.deepStrictEqual(dueAfter(upcomingGame, opens), Option.none())
  })

  it("should be due at until when holding", () => {
    assert.deepStrictEqual(dueAfter(holding, now), Option.some(until))
  })
})

describe("Acknowledgement.earliest", () => {
  it("should be none of nothing", () => {
    assert.deepStrictEqual(Acknowledgement.earliest([]), Option.none())
  })

  it("should be none of only nones", () => {
    assert.deepStrictEqual(Acknowledgement.earliest([Option.none()]), Option.none())
  })

  it("should be the earliest of some, ignoring nones", () => {
    const earliest = Acknowledgement.earliest([Option.some(later), Option.none(), Option.some(t0)])

    assert.deepStrictEqual(earliest, Option.some(t0))
  })
})

/** A game as the slate holds it: its snapshot and its acknowledgement. */
type Game = Option.Option.Value<ReturnType<Acknowledgement["took"]>["next"]>

/** `snapshot`, first heard from `from` at `now`. */
function first(snapshot: GameSnapshot, from: DeliverySource, now: DateTime.Utc): Game {
  return { snapshot, acknowledgement: Acknowledgement.first(from, now) }
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

function took(game: Game, taking: GameSnapshot, from: DeliverySource, now: DateTime.Utc) {
  return game.acknowledgement.took(game.snapshot, { snapshot: taking, from }, now)
}

function taken(game: Game, taking: GameSnapshot, from: DeliverySource, now: DateTime.Utc) {
  return took(game, taking, from, now).next
}

/** A live game that took a snapshot at `at`. */
function refreshedLiveGame(at: DateTime.Utc): Game {
  const next = snapshot({ status: "live", period: 2, clock: "9:00" })
  return Option.getOrThrow(taken(liveGame, next, "poll", at))
}

function stateOf({ snapshot, acknowledgement }: Game, now: DateTime.Utc) {
  return acknowledgement.state(snapshot, now)
}

function statesOf(game: Option.Option<Game>, now: DateTime.Utc) {
  return Option.map(game, (some) => stateOf(some, now))
}

function covers({ snapshot, acknowledgement }: Game, now: DateTime.Utc) {
  return acknowledgement.covers(snapshot, now)
}

function isCurrent({ snapshot, acknowledgement }: Game, now: DateTime.Utc) {
  return acknowledgement.isCurrent(snapshot, now)
}

function dueAfter({ snapshot, acknowledgement }: Game, now: DateTime.Utc) {
  return acknowledgement.dueAfter(snapshot, now)
}

function heardAtOf(game: Option.Option<Game>) {
  return Option.map(game, ({ acknowledgement }) => acknowledgement.heardAt)
}

function heldOf(game: Option.Option<Game>) {
  return Option.flatMap(game, ({ acknowledgement }) => acknowledgement.held)
}

function snapshotOf(game: Option.Option<Game>) {
  return Option.map(game, ({ snapshot }) => snapshot)
}

function sourceOf(game: Option.Option<Game>) {
  return Option.map(game, ({ acknowledgement }) => acknowledgement.from)
}
