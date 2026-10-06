import { DateTime } from "effect"
import { type Broadcast, GameId, GameSnapshot, Network } from "./Game.ts"
import type { LeagueId } from "./League.ts"
import { Play, PlayId } from "./Play.ts"
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

/** A team for a test, named by its abbreviation unless `names` says otherwise. */
export function team(
  abbreviation: string,
  league: LeagueId = "fbs",
  names: { name?: string; location?: string; shortName?: string } = {}
): Team {
  return new Team({
    id: TeamId.make(`${league}:${abbreviation}`),
    abbreviation,
    name: names.name ?? abbreviation,
    location: names.location ?? abbreviation,
    shortName: names.shortName ?? abbreviation
  })
}

/** A broadcast of `network`, on television unless said otherwise. */
export function broadcast(network: string, medium: Broadcast["medium"] = "tv"): Broadcast {
  return { network: Network.make(network), medium }
}

/** A play for a test: a one-yard rush by the home team in the first quarter unless the overrides say otherwise. */
export function play(overrides: Partial<Play> = {}): Play {
  const home = team("HOME").id
  return new Play({
    id: PlayId.make("1"),
    sequence: 1,
    period: 1,
    clock: "15:00",
    team: home,
    kind: "rush",
    text: "Rush for 1 yard",
    yards: 1,
    scoring: false,
    homeScore: 0,
    awayScore: 0,
    start: { down: 1, distance: 10, yardsToEndzone: 75, team: home },
    end: { down: 2, distance: 9, yardsToEndzone: 74, team: home },
    ...overrides
  })
}
