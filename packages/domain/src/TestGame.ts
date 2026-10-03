import { DateTime } from "effect"
import { GameId, GameSnapshot } from "./Game.ts"
import type { LeagueId } from "./League.ts"
import { Team, TeamId } from "./Team.ts"

/** A game snapshot for a test: an FBS scheduled game unless the overrides say otherwise. */
export function snapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return new GameSnapshot({
    id: GameId.make("1"),
    league: "fbs",
    kickoff: DateTime.makeUnsafe("2026-10-03T16:00:00Z"),
    status: "scheduled",
    period: 0,
    clock: "0:00",
    home: { team: team("HOME"), score: 0 },
    away: { team: team("AWAY"), score: 0 },
    broadcasts: [],
    ...overrides
  })
}

export function team(abbreviation: string, league: LeagueId = "fbs"): Team {
  return new Team({ id: TeamId.make(`${league}:${abbreviation}`), abbreviation, name: abbreviation })
}
