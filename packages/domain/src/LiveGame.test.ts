import { DateTime, Duration, Option } from "effect"
import { describe, expect, it } from "vitest"
import { GameId } from "./Game.ts"
import { LiveGame, LiveGameState } from "./LiveGame.ts"
import { snapshot } from "./TestGame.ts"

const t0 = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
const later = DateTime.addDuration(t0, Duration.seconds(30))

const upcoming = snapshot()
const live = snapshot({ status: "live", period: 2, clock: "10:00" })
const liveBehind = snapshot({ status: "live", period: 1, clock: "10:00" })
const over = snapshot({ status: "final", period: 4, clock: "0:00" })

const upcomingGame = LiveGame.start(upcoming, t0)
const liveGame = LiveGame.start(live, t0)
const staleGame = new LiveGame({ snapshot: live, state: LiveGameState.Stale({ lastUpdatedAt: t0 }) })
const overGame = LiveGame.start(over, t0)

const liveAt = (updatedAt: DateTime.Utc) => LiveGameState.Live({ updatedAt })

describe("LiveGame.start", () => {
  it("an upcoming snapshot starts Upcoming", () => {
    expect(upcomingGame.state).toEqual(LiveGameState.Upcoming())
  })
  it("a live snapshot starts Live, updated now", () => {
    expect(liveGame.state).toEqual(liveAt(t0))
  })
  it("a final snapshot starts Over", () => {
    expect(overGame.state).toEqual(LiveGameState.Over())
  })
})

describe("LiveGame#receive", () => {
  it("Upcoming + upcoming snapshot: Upcoming", () => {
    expect(upcomingGame.receive(upcoming, later).pipe(Option.map((game) => game.state))).toEqual(
      Option.some(LiveGameState.Upcoming())
    )
  })
  it("Upcoming + live snapshot: Live, refreshed", () => {
    expect(upcomingGame.receive(live, later).pipe(Option.map((game) => game.state))).toEqual(
      Option.some(liveAt(later))
    )
  })
  it("Upcoming + final snapshot: Over", () => {
    expect(upcomingGame.receive(over, later).pipe(Option.map((game) => game.state))).toEqual(
      Option.some(LiveGameState.Over())
    )
  })
  it("Upcoming + behind snapshot: none", () => {
    // Unreachable through start and receive; kept so every cell of the transition table is covered.
    const ahead = new LiveGame({ snapshot: live, state: LiveGameState.Upcoming() })
    expect(ahead.receive(upcoming, later)).toEqual(Option.none())
  })
  it("Live + upcoming snapshot: none (behind)", () => {
    expect(liveGame.receive(upcoming, later)).toEqual(Option.none())
  })
  it("Live + behind snapshot: none", () => {
    expect(liveGame.receive(liveBehind, later)).toEqual(Option.none())
  })
  it("Live + live snapshot: Live, refreshed", () => {
    const next = snapshot({ status: "live", period: 2, clock: "9:00" })
    expect(liveGame.receive(next, later).pipe(Option.map((game) => game.state))).toEqual(
      Option.some(liveAt(later))
    )
  })
  it("Live + final snapshot: Over", () => {
    expect(liveGame.receive(over, later).pipe(Option.map((game) => game.state))).toEqual(
      Option.some(LiveGameState.Over())
    )
  })
  it("Stale + upcoming snapshot: none (behind)", () => {
    expect(staleGame.receive(upcoming, later)).toEqual(Option.none())
  })
  it("Stale + behind snapshot: none", () => {
    expect(staleGame.receive(liveBehind, later)).toEqual(Option.none())
  })
  it("Stale + live snapshot: Live, refreshed", () => {
    expect(staleGame.receive(live, later).pipe(Option.map((game) => game.state))).toEqual(
      Option.some(liveAt(later))
    )
  })
  it("Stale + final snapshot: Over", () => {
    expect(staleGame.receive(over, later).pipe(Option.map((game) => game.state))).toEqual(
      Option.some(LiveGameState.Over())
    )
  })
  it("Over + upcoming snapshot: none (behind)", () => {
    expect(overGame.receive(upcoming, later)).toEqual(Option.none())
  })
  it("Over + live snapshot: none (behind)", () => {
    expect(overGame.receive(live, later)).toEqual(Option.none())
  })
  it("Over + final snapshot: Over, new snapshot", () => {
    const corrected = snapshot({
      status: "final",
      period: 4,
      clock: "0:00",
      home: { ...over.home, score: 7 }
    })
    const next = overGame.receive(corrected, later)
    expect(next.pipe(Option.map((game) => game.state))).toEqual(Option.some(LiveGameState.Over()))
    expect(next.pipe(Option.map((game) => game.snapshot))).toEqual(Option.some(corrected))
  })
  it("a taken snapshot replaces the snapshot", () => {
    const scored = snapshot({ status: "live", period: 2, clock: "9:00", home: { ...live.home, score: 3 } })
    expect(liveGame.receive(scored, later).pipe(Option.map((game) => game.snapshot))).toEqual(
      Option.some(scored)
    )
  })
  it("an identical snapshot is taken and refreshes updatedAt", () => {
    expect(liveGame.receive(live, later).pipe(Option.map((game) => game.state))).toEqual(
      Option.some(liveAt(later))
    )
  })
})

describe("LiveGame#tick", () => {
  const staleTime = DateTime.addDuration(t0, Duration.seconds(90))
  it("Upcoming: none", () => {
    expect(upcomingGame.tick(staleTime)).toEqual(Option.none())
  })
  it("Live at updatedAt + 89 s: none", () => {
    expect(liveGame.tick(DateTime.addDuration(t0, Duration.seconds(89)))).toEqual(Option.none())
  })
  it("Live at exactly updatedAt + 90 s: Stale", () => {
    expect(liveGame.tick(staleTime).pipe(Option.map((game) => game.state))).toEqual(
      Option.some(LiveGameState.Stale({ lastUpdatedAt: t0 }))
    )
  })
  it("after a refresh at 60 s, none at 140 s and Stale at 150 s", () => {
    const refreshedAt = DateTime.addDuration(t0, Duration.seconds(60))
    const next = snapshot({ status: "live", period: 2, clock: "9:00" })
    const refreshed = liveGame.receive(next, refreshedAt)
    expect(
      refreshed.pipe(Option.flatMap((game) => game.tick(DateTime.addDuration(t0, Duration.seconds(140)))))
    ).toEqual(Option.none())
    expect(
      refreshed.pipe(
        Option.flatMap((game) => game.tick(DateTime.addDuration(t0, Duration.seconds(150)))),
        Option.map((game) => game.state)
      )
    ).toEqual(Option.some(LiveGameState.Stale({ lastUpdatedAt: refreshedAt })))
  })
  it("Stale: none", () => {
    expect(staleGame.tick(staleTime)).toEqual(Option.none())
  })
  it("Over: none", () => {
    expect(overGame.tick(staleTime)).toEqual(Option.none())
  })
})

describe("LiveGame#staleAt", () => {
  it("Live: updatedAt + 90 s", () => {
    expect(liveGame.staleAt()).toEqual(Option.some(DateTime.addDuration(t0, Duration.seconds(90))))
  })
  it("Upcoming, Stale and Over: none", () => {
    expect(upcomingGame.staleAt()).toEqual(Option.none())
    expect(staleGame.staleAt()).toEqual(Option.none())
    expect(overGame.staleAt()).toEqual(Option.none())
  })
})

describe("LiveGame#isCurrent", () => {
  it("Live and Stale are current", () => {
    expect(liveGame.isCurrent(later)).toBe(true)
    expect(staleGame.isCurrent(later)).toBe(true)
  })
  it("Stale at lastUpdatedAt + 29:59 is current, and at + 30:00 is not", () => {
    expect(staleGame.isCurrent(DateTime.addDuration(t0, Duration.seconds(30 * 60 - 1)))).toBe(true)
    expect(staleGame.isCurrent(DateTime.addDuration(t0, Duration.minutes(30)))).toBe(false)
  })
  it("Over is not current", () => {
    expect(overGame.isCurrent(later)).toBe(false)
  })
  it("Upcoming with kickoff exactly 30 minutes away is current", () => {
    expect(upcomingGame.isCurrent(DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30)))).toBe(
      true
    )
  })
  it("Upcoming with kickoff 30 minutes and 1 second away is not current", () => {
    expect(
      upcomingGame.isCurrent(DateTime.subtractDuration(upcoming.kickoff, Duration.seconds(30 * 60 + 1)))
    ).toBe(false)
  })
})

describe("LiveGame#currencyChangesAt", () => {
  it("Stale: lastUpdatedAt + 30 minutes, until then", () => {
    const end = DateTime.addDuration(t0, Duration.minutes(30))
    expect(staleGame.currencyChangesAt(later)).toEqual(Option.some(end))
    expect(staleGame.currencyChangesAt(end)).toEqual(Option.none())
  })
  it("Upcoming: kickoff - 30 minutes, until then", () => {
    const opens = DateTime.subtractDuration(upcoming.kickoff, Duration.minutes(30))
    expect(upcomingGame.currencyChangesAt(DateTime.subtractDuration(opens, Duration.seconds(1)))).toEqual(
      Option.some(opens)
    )
    expect(upcomingGame.currencyChangesAt(opens)).toEqual(Option.none())
  })
  it("Live and Over: none", () => {
    expect(liveGame.currencyChangesAt(later)).toEqual(Option.none())
    expect(overGame.currencyChangesAt(later)).toEqual(Option.none())
  })
})

describe("LiveGame.followed", () => {
  const listed = [snapshot({ id: GameId.make("2") }), snapshot({ id: GameId.make("1") })]

  it("each listed game in listed order, as its live game has it, or as listed when it has none", () => {
    const followed = LiveGame.followed(
      listed,
      new Map([
        [GameId.make("1"), LiveGame.start(snapshot({ id: GameId.make("1"), status: "live", period: 2 }), t0)]
      ])
    )
    expect(followed.map((game) => [game.id, game.status])).toEqual([
      ["2", "scheduled"],
      ["1", "live"]
    ])
  })
  it("leaves off a live game no listing has", () => {
    const followed = LiveGame.followed(listed, new Map([[GameId.make("9"), liveGame]]))
    expect(followed.map((game) => game.id)).toEqual(["2", "1"])
  })
})
