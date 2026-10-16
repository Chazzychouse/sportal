import {
  type Broadcast,
  GameId,
  GameSnapshot,
  type GameStatus,
  Network,
  type Odds,
  type TeamRecord
} from "@sportal/domain/Game"
import { League, type LeagueId } from "@sportal/domain/League"
import { FootballSituation } from "@sportal/domain/Situation"
import { Team, TeamId } from "@sportal/domain/Team"
import { Array as Arr, type DateTime, Effect, Schema, SchemaGetter, SchemaIssue } from "effect"
import { EspnLeague } from "./EspnLeague.ts"
import { type EspnOdds, type EspnSituation, type EspnStatus, Scoreboard, SiteEvent } from "./EspnPayload.ts"

/**
 * League `league`'s listed games, as a poll's `body`, its whole site scoreboard, shows them; an event that does not
 * decode is skipped.
 */
export const listingOf = Effect.fnUntraced(function* (league: LeagueId, body: string) {
  const decode = decodeEvent.get(league)
  if (decode === undefined) {
    return yield* Effect.fail(
      new SchemaIssue.InvalidValue({ message: "ESPN does not serve this league to the Hub" }, league)
    )
  }
  const scoreboard = yield* decodeScoreboard(body)

  const games = yield* Effect.forEach(scoreboard.events, (event) => Effect.option(decode(event)))
  return Arr.getSomes(games)
})

/**
 * One game as the site scoreboard spells it, read as a `league` `GameSnapshot`. An event without a home and an away
 * team does not decode.
 */
function espnEvent(league: LeagueId) {
  return SiteEvent.pipe(
    Schema.decodeTo(Schema.toType(GameSnapshot), {
      decode: SchemaGetter.transformEffect((event) => {
        const [competition] = event.competitions
        return snapshot(league, {
          id: event.id,
          startsAt: event.date,
          status: event.status,
          competitors: competition.competitors.map(({ homeAway, score, curatedRank, records, team }) => ({
            ...team,
            homeAway,
            score,
            rank: curatedRank?.current,
            record: (records?.find(({ type }) => type === "total") ?? records?.[0])?.summary
          })),
          broadcasts: (competition.geoBroadcasts ?? []).map(({ type, media }) => ({
            medium: type.shortName,
            network: media.shortName
          })),
          situation: competition.situation,
          odds: competition.odds?.[0]
        })
      }),
      encode: SchemaGetter.forbidden(() => "A GameSnapshot cannot be encoded back to an ESPN event")
    })
  )
}

/** The snapshot an event says, once the site feed's spelling is read into one shape. */
const snapshot = Effect.fnUntraced(function* (
  league: LeagueId,
  event: {
    readonly id: string
    readonly startsAt: DateTime.Utc
    readonly status: EspnStatus
    readonly competitors: ReadonlyArray<{
      readonly homeAway: "home" | "away"
      readonly id: string
      readonly abbreviation: string
      readonly displayName: string
      readonly location?: string | undefined
      readonly shortDisplayName?: string | undefined
      readonly logo?: string | undefined
      readonly color?: string | undefined
      readonly alternateColor?: string | undefined
      readonly score?: string | undefined
      readonly rank?: number | undefined
      readonly record?: string | undefined
    }>
    readonly broadcasts: ReadonlyArray<{ readonly medium: string; readonly network: string }>
    readonly situation: EspnSituation | undefined
    readonly odds: EspnOdds | undefined
  }
) {
  const home = event.competitors.find((competitor) => competitor.homeAway === "home")
  const away = event.competitors.find((competitor) => competitor.homeAway === "away")
  if (home === undefined || away === undefined) {
    return yield* Effect.fail(
      new SchemaIssue.InvalidValue({ message: "An event needs a home and an away team" }, event)
    )
  }
  const side = (competitor: typeof home) => ({
    team: new Team({
      id: teamId(league, competitor.id),
      abbreviation: competitor.abbreviation,
      name: competitor.displayName,
      location: competitor.location ?? competitor.displayName,
      shortName: competitor.shortDisplayName ?? competitor.displayName,
      logo: competitor.logo,
      color: competitor.color,
      alternateColor: competitor.alternateColor
    }),
    score: scoreOf(competitor.score),
    // ESPN ranks an unranked team 99, which reads as no ranking.
    ...(competitor.rank === undefined || competitor.rank > 25 ? {} : { ranking: competitor.rank }),
    ...recordOf(competitor.record)
  })
  return new GameSnapshot({
    id: GameId.make(event.id),
    league,
    startsAt: event.startsAt,
    status: statusOf(event.status.type),
    period: event.status.period,
    ...clockOf(league, event.status),
    statusText: event.status.type.shortDetail,
    home: side(home),
    away: side(away),
    broadcasts: event.broadcasts.flatMap(({ medium, network }) => broadcast(medium, network)),
    ...(event.situation === undefined || League.of(league).sport !== "football"
      ? {}
      : { situation: situation(league, event.situation, home.id) }),
    ...oddsOf(event.odds)
  })
})

/**
 * The seconds left on the clock, when the period runs on one: a college overtime has none (ESPN shows it as 0:00
 * throughout), nor does any sport but football yet.
 */
function clockOf(league: LeagueId, status: EspnStatus): { clock?: number } {
  const timed = League.of(league).sport === "football" && !(league === "fbs" && status.period >= 5)
  return timed ? { clock: Math.round(status.clock) } : {}
}

// A score is digits, or nothing before the start, which reads as 0.
function scoreOf(score: string | undefined): number {
  return Number.parseInt(score ?? "", 10) || 0
}

// A record reads "wins-losses", or "wins-losses-ties" in the NFL; the ties are left out.
function recordOf(summary: string | undefined): { record?: TeamRecord } {
  const [wins, losses] = (summary ?? "").split("-").map((part) => Number.parseInt(part, 10))
  if (wins === undefined || losses === undefined || !Number.isInteger(wins) || !Number.isInteger(losses))
    return {}
  return { record: { wins, losses } }
}

// ESPN's spread is signed for the home team; the domain keeps its size and the side each team's odds mark favored.
function oddsOf(odds: EspnOdds | undefined): { odds?: Odds } {
  if (odds?.spread === undefined) return {}
  const favorite =
    odds.homeTeamOdds?.favorite === true ? "home" : odds.awayTeamOdds?.favorite === true ? "away" : undefined
  return {
    odds: {
      spread: Math.abs(odds.spread),
      ...(favorite === undefined ? {} : { favorite }),
      ...(odds.overUnder === undefined ? {} : { overUnder: odds.overUnder })
    }
  }
}

// ESPN also lists radio, which no source plays.
function broadcast(medium: string, network: string): Array<Broadcast> {
  return medium === "TV"
    ? [{ network: Network.make(network), medium: "tv" }]
    : medium === "Streaming"
      ? [{ network: Network.make(network), medium: "streaming" }]
      : []
}

/** The domain `FootballSituation`; the league and the home team's id orient its possession and yard line. */
function situation(league: LeagueId, raw: EspnSituation, homeTeamId: string): FootballSituation {
  return new FootballSituation({
    homeTimeouts: raw.homeTimeouts ?? 0,
    awayTimeouts: raw.awayTimeouts ?? 0,
    ...(raw.possession === undefined ? {} : { possession: teamId(league, raw.possession) }),
    // ESPN reports down -1 between plays (after a score, before a kick).
    ...(raw.down === undefined || raw.down < 1 ? {} : { down: raw.down }),
    distance: raw.distance,
    // ESPN counts the yard line from the home goal line; the domain counts it to the goal the team with
    // the ball attacks. Without a team on the ball it cannot be oriented.
    ...(raw.yardLine === undefined || raw.possession === undefined
      ? {}
      : { yardLine: raw.possession === homeTeamId ? 100 - raw.yardLine : raw.yardLine })
  })
}

function statusOf(type: EspnStatus["type"]): GameStatus {
  return byName.get(type.name) ?? byState[type.state]
}

// The statuses ESPN's name says, whatever its state; any other name reads as its state's.
const byName: ReadonlyMap<string, GameStatus> = new Map([
  ["STATUS_HALFTIME", "break"],
  ["STATUS_END_PERIOD", "break"],
  ["STATUS_DELAYED", "delayed"],
  ["STATUS_POSTPONED", "postponed"],
  ["STATUS_CANCELED", "canceled"]
])

const byState = { pre: "scheduled", in: "live", post: "final" } as const satisfies Readonly<
  Record<EspnStatus["type"]["state"], GameStatus>
>

/** The `TeamId` of ESPN's team `id` in `league`: ESPN's ids are only unique within a league. */
export function teamId(league: LeagueId, id: string): TeamId {
  return TeamId.make(`${league}:${id}`)
}

const decodeScoreboard = Schema.decodeUnknownEffect(Schema.fromJsonString(Scoreboard))

// Each league's site event decode, built once.
const decodeEvent: ReadonlyMap<LeagueId, ReturnType<typeof decodeEventOf>> = new Map(
  EspnLeague.followed.map(({ league }) => [league, decodeEventOf(league)])
)

function decodeEventOf(league: LeagueId) {
  return Schema.decodeUnknownEffect(espnEvent(league))
}
