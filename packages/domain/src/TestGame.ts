import { DateTime } from "effect"
import { type Broadcast, GameId, GameSnapshot, Network, type Odds } from "./Game.ts"
import { Highlight, HighlightId } from "./Highlight.ts"
import type { LeagueId } from "./League.ts"
import { FootballDetail, Play, PlayId } from "./Play.ts"
import { BaseballSituation, FootballSituation } from "./Situation.ts"
import type { Slate } from "./Slate.ts"
import { Team, TeamId } from "./Team.ts"

/** A game snapshot for a test: an FBS scheduled game unless the overrides say otherwise. */
export function snapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return new GameSnapshot({
    id: GameId.make("1"),
    league: "fbs",
    startsAt: DateTime.makeUnsafe("2026-10-03T16:00:00Z"),
    status: "scheduled",
    period: 0,
    statusText: "Sat 12:00 PM",
    home: { team: team("HOME"), score: 0 },
    away: { team: team("AWAY"), score: 0 },
    broadcasts: [],
    ...overrides
  })
}

/** A live game snapshot for a test: in the first period with 10:00 on the clock unless the overrides say otherwise. */
export function liveSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return snapshot({ status: "live", period: 1, clock: 600, statusText: "10:00 - 1st", ...overrides })
}

/** A football situation for a test: the home team's first and ten at midfield, three timeouts each, unless the overrides say otherwise. */
export function situation(overrides: Partial<FootballSituation> = {}): FootballSituation {
  return new FootballSituation({
    possession: team("HOME").id,
    down: 1,
    distance: 10,
    yardLine: 50,
    homeTimeouts: 3,
    awayTimeouts: 3,
    ...overrides
  })
}

/** A baseball situation for a test: the top of an inning with nobody on and no count, unless the overrides say otherwise. */
export function baseballSituation(overrides: Partial<BaseballSituation> = {}): BaseballSituation {
  return new BaseballSituation({
    half: "top",
    outs: 0,
    balls: 0,
    strikes: 0,
    onFirst: false,
    onSecond: false,
    onThird: false,
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

/** A football play's detail for a test: a one-yard run by the home team from its 25 unless the overrides say otherwise. */
export function footballDetail(overrides: Partial<FootballDetail> = {}): FootballDetail {
  return new FootballDetail({
    kind: "run",
    yards: 1,
    start: { down: 1, distance: 10, yardsToEndzone: 75, team: home },
    end: { down: 2, distance: 9, yardsToEndzone: 74, team: home },
    ...overrides
  })
}

/** A play for a test: a one-yard run by the home team at 15:00 of the first quarter unless the overrides say otherwise. */
export function play(overrides: Partial<Play> = {}): Play {
  return new Play({
    id: PlayId.make("1"),
    sequence: 1,
    period: 1,
    clock: "15:00",
    text: "Rush for 1 yard",
    type: { id: "5", text: "Rush" },
    scoring: false,
    homeScore: 0,
    awayScore: 0,
    team: home,
    detail: footballDetail(),
    ...overrides
  })
}

/** Game `id`'s snapshot, as `slate` has it. */
export function snapshotIn(slate: Slate, id: GameId): GameSnapshot | undefined {
  return slate.games.find(({ snapshot }) => snapshot.id === id)?.snapshot
}

/** Game `id`'s plays, as `slate` has them; none when the slate lacks it. */
export function playsIn(slate: Slate, id: GameId): ReadonlyArray<Play> {
  return slate.games.find(({ snapshot }) => snapshot.id === id)?.plays ?? []
}

/** A pregame line for a test: the home team favored by 3, unless the overrides say otherwise. */
export function odds(overrides: Partial<Odds> = {}): Odds {
  return { favorite: "home", spread: 3, ...overrides }
}

/** A snapshot's two sides for a test: the home and away teams with these scores, ranked when `rankings` says. */
export function sides(home: number, away: number, rankings: { home?: number; away?: number } = {}) {
  return {
    home: {
      team: team("HOME"),
      score: home,
      ...(rankings.home === undefined ? {} : { ranking: rankings.home })
    },
    away: {
      team: team("AWAY"),
      score: away,
      ...(rankings.away === undefined ? {} : { ranking: rankings.away })
    }
  }
}

/** A highlight for a test: a 30-second clip of game "1" unless the overrides say otherwise. */
export function highlight(overrides: Partial<Highlight> = {}): Highlight {
  return new Highlight({
    id: HighlightId.make("h1"),
    game: GameId.make("1"),
    headline: "A touchdown",
    duration: 30,
    video: "https://video.test/h1.mp4",
    ...overrides
  })
}
