import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import { snapshot } from "./TestGame.ts"

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
