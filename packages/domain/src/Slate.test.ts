import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import * as Slate from "./Slate.ts"
import { Team, TeamId } from "./Team.ts"

function game(id: string, status: GameStatus, kickoff: string) {
  const team = (abbreviation: string) =>
    new Team({ id: TeamId.make(`fbs:${abbreviation}`), abbreviation, name: abbreviation })
  return new GameSnapshot({
    id: GameId.make(id),
    league: "fbs",
    kickoff: DateTime.makeUnsafe(kickoff),
    status,
    period: 0,
    clock: "0:00",
    home: { team: team("HOME"), score: 0 },
    away: { team: team("AWAY"), score: 0 },
    broadcasts: []
  })
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
