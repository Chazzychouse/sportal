import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import { snapshot, team } from "./TestGame.ts"

describe("GameSnapshot.isLive", () => {
  it.each(["live", "halftime"] as const)("is live when %s", (status) => {
    assert.isTrue(snapshot({ status }).isLive())
  })

  it.each(["scheduled", "delayed", "final", "postponed", "canceled"] as const)(
    "is not live when %s",
    (status) => {
      assert.isFalse(snapshot({ status }).isLive())
    }
  )
})

describe("GameSnapshot.progress", () => {
  it.each([
    ["scheduled", "upcoming"],
    ["delayed", "upcoming"],
    ["live", "live"],
    ["halftime", "live"],
    ["final", "over"],
    ["postponed", "over"],
    ["canceled", "over"]
  ] as const)("is %s → %s", (status, progress) => {
    assert.strictEqual(snapshot({ status }).progress(), progress)
  })

  it("reads a delay before kickoff as upcoming and a delay during the game as live", () => {
    assert.strictEqual(snapshot({ status: "delayed", period: 0 }).progress(), "upcoming")
    assert.strictEqual(snapshot({ status: "delayed", period: 2 }).progress(), "live")
  })
})

describe("GameSnapshot.matchup", () => {
  it("names the away team at the home team", () => {
    const game = snapshot({ away: { team: team("UGA"), score: 0 }, home: { team: team("BAMA"), score: 0 } })
    assert.strictEqual(game.matchup(), "UGA at BAMA")
  })
})

describe("GameSnapshot.gameTime", () => {
  const compare = GameSnapshot.gameTime

  it("puts upcoming behind live and live behind over", () => {
    const upcoming = snapshot({ status: "scheduled" })
    const live = snapshot({ status: "live", period: 1, clock: "10:00" })
    const over = snapshot({ status: "final", period: 4, clock: "0:00" })
    assert.strictEqual(compare(upcoming, live), -1)
    assert.strictEqual(compare(live, over), -1)
    assert.strictEqual(compare(over, upcoming), 1)
  })

  it("puts a later period ahead of an earlier one whatever the clock", () => {
    const later = snapshot({ status: "live", period: 2, clock: "14:00" })
    const earlier = snapshot({ status: "live", period: 1, clock: "0:30" })
    assert.strictEqual(compare(later, earlier), 1)
  })

  it("puts less time left ahead within a period", () => {
    const later = snapshot({ status: "live", period: 3, clock: "2:00" })
    const earlier = snapshot({ status: "live", period: 3, clock: "9:00" })
    assert.strictEqual(compare(later, earlier), 1)
    assert.strictEqual(compare(earlier, later), -1)
  })

  it("ignores the score", () => {
    const a = snapshot({ status: "live", period: 2, clock: "5:00", home: { team: team("HOME"), score: 7 } })
    const b = snapshot({ status: "live", period: 2, clock: "5:00" })
    assert.strictEqual(compare(a, b), 0)
  })

  it("puts halftime between the end of period 2 and the start of period 3", () => {
    const halftime = snapshot({ status: "halftime", period: 2, clock: "0:00" })
    assert.strictEqual(compare(halftime, snapshot({ status: "live", period: 2, clock: "0:10" })), 1)
    assert.strictEqual(compare(halftime, snapshot({ status: "live", period: 3, clock: "15:00" })), -1)
  })

  it("reads a delay during the game as live and a delay before kickoff as upcoming", () => {
    const delayed = snapshot({ status: "delayed", period: 2, clock: "5:00" })
    assert.strictEqual(compare(delayed, snapshot({ status: "live", period: 1, clock: "1:00" })), 1)
    assert.strictEqual(
      compare(snapshot({ status: "delayed", period: 0 }), snapshot({ status: "live", period: 1 })),
      -1
    )
  })
})

describe("GameSnapshot.watchOrder", () => {
  it("puts live games first, then upcoming by kickoff, then finished", () => {
    const ordered = [
      game("final", "final", "2026-10-03T16:00:00Z"),
      game("late", "scheduled", "2026-10-03T23:30:00Z"),
      game("halftime", "halftime", "2026-10-03T19:30:00Z"),
      game("early", "scheduled", "2026-10-03T20:00:00Z"),
      game("live", "live", "2026-10-03T16:00:00Z")
    ].sort(GameSnapshot.watchOrder)
    assert.deepStrictEqual(
      ordered.map((g) => g.id),
      ["live", "halftime", "early", "late", "final"]
    )
  })
})

function game(id: string, status: GameStatus, kickoff: string) {
  return snapshot({ id: GameId.make(id), status, kickoff: DateTime.makeUnsafe(kickoff) })
}
