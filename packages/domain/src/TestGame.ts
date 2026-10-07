import { DateTime } from "effect"
import { type Broadcast, GameId, GameSnapshot, Network } from "./Game.ts"
import type { GameEventKind } from "./GameEvent.ts"
import type { LeagueId } from "./League.ts"
import { Completion, PlayId, Rush } from "./Play.ts"
import { Situation } from "./Situation.ts"
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

/** A live game snapshot for a test: in the first period with 10:00 on the clock unless the overrides say otherwise. */
export function liveSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return snapshot({ status: "live", period: 1, clock: "10:00", ...overrides })
}

/** A situation for a test: the home team's first and ten at midfield, three timeouts each, unless the overrides say otherwise. */
export function situation(overrides: Partial<Situation> = {}): Situation {
  return new Situation({
    possession: team("HOME").id,
    down: 1,
    distance: 10,
    yardLine: 50,
    homeTimeouts: 3,
    awayTimeouts: 3,
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

const home = team("HOME").id

/** The fields a one-yard first-quarter play by the home team shares, whichever way it was made. */
const oneYardPlay = {
  id: PlayId.make("1"),
  sequence: 1,
  period: 1,
  clock: "15:00",
  team: home,
  yards: 1,
  touchdown: false,
  scoring: false,
  homeScore: 0,
  awayScore: 0,
  start: { down: 1, distance: 10, yardsToEndzone: 75, team: home },
  end: { down: 2, distance: 9, yardsToEndzone: 74, team: home }
}

/**
 * A play for a test: a one-yard rush by the home team in the first quarter unless the overrides say otherwise. A test
 * that needs another case constructs it.
 */
export function play(overrides: Partial<Rush> = {}): Rush {
  return new Rush({ ...oneYardPlay, text: "Rush for 1 yard", ...overrides })
}

/**
 * A pass for a test: a one-yard completion by the home team in the first quarter unless the overrides say otherwise.
 */
export function completion(overrides: Partial<Completion> = {}): Completion {
  return new Completion({ ...oneYardPlay, text: "Pass complete for 1 yard", ...overrides })
}

/** The tags of these events, in order. */
export function tags(events: ReadonlyArray<GameEventKind>): ReadonlyArray<string> {
  return events.map((event) => event._tag)
}
