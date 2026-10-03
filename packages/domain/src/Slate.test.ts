import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { GameId, type GameStatus } from "./Game.ts"
import * as Slate from "./Slate.ts"
import { snapshot } from "./TestGame.ts"

function game(id: string, status: GameStatus, kickoff: string) {
  return snapshot({ id: GameId.make(id), status, kickoff: DateTime.makeUnsafe(kickoff) })
}

describe("Slate.inWatchOrder", () => {
  it("puts live games first, then upcoming by kickoff, then finished", () => {
    const ordered = Slate.inWatchOrder([
      game("final", "final", "2026-10-03T16:00:00Z"),
      game("late", "scheduled", "2026-10-03T23:30:00Z"),
      game("halftime", "halftime", "2026-10-03T19:30:00Z"),
      game("early", "scheduled", "2026-10-03T20:00:00Z"),
      game("live", "live", "2026-10-03T16:00:00Z")
    ])
    assert.deepStrictEqual(
      ordered.map((g) => g.id),
      ["live", "halftime", "early", "late", "final"]
    )
  })
})
