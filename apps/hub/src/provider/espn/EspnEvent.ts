import { type Broadcast, GameId, GameSnapshot, GameStatus, Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Situation } from "@sportal/domain/Situation"
import { Team, TeamId } from "@sportal/domain/Team"
import { type DateTime, Effect, Schema, SchemaGetter, SchemaIssue } from "effect"
import { type EspnSituation, type EspnStatus, FastCastEvent, SiteEvent } from "./EspnPayload.ts"

/**
 * One game as the site scoreboard spells it, read as a `league` `GameSnapshot`. An event without a home and an away
 * team does not decode.
 */
export function EspnEvent(league: LeagueId) {
  return SiteEvent.pipe(
    Schema.decodeTo(Schema.toType(GameSnapshot), {
      decode: SchemaGetter.transformEffect((event) => {
        const [competition] = event.competitions
        return snapshot(league, {
          id: event.id,
          kickoff: event.date,
          status: event.status,
          competitors: competition.competitors.map(({ homeAway, score, curatedRank, team }) => ({
            ...team,
            homeAway,
            score,
            rank: curatedRank?.current
          })),
          broadcasts: (competition.geoBroadcasts ?? []).map(({ type, media }) => ({
            medium: type.shortName,
            network: media.shortName
          })),
          situation: competition.situation
        })
      }),
      encode: SchemaGetter.forbidden(() => "A GameSnapshot cannot be encoded back to an ESPN event")
    })
  )
}

/**
 * One game as a FastCast scoreboard topic's document spells it, read as what it moves: its status, period, clock,
 * scores, and situation. An event without a home and an away team does not decode.
 */
export function PushedEvent(league: LeagueId) {
  return FastCastEvent.pipe(
    Schema.decodeTo(Schema.toType(Moved), {
      decode: SchemaGetter.transformEffect((event) => moved(league, event)),
      encode: SchemaGetter.forbidden(() => "A pushed event cannot be encoded back to an ESPN event")
    })
  )
}

/** The snapshot an event says, once the site feed's spelling is read into one shape. */
const snapshot = Effect.fnUntraced(function* (
  league: LeagueId,
  event: {
    readonly id: string
    readonly kickoff: DateTime.Utc
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
    }>
    readonly broadcasts: ReadonlyArray<{ readonly medium: string; readonly network: string }>
    readonly situation: EspnSituation | undefined
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
    ...(competitor.rank === undefined || competitor.rank > 25 ? {} : { ranking: competitor.rank })
  })
  return new GameSnapshot({
    id: GameId.make(event.id),
    league,
    kickoff: event.kickoff,
    status: statusOf(event.status.type),
    period: event.status.period,
    clock: event.status.displayClock,
    home: side(home),
    away: side(away),
    broadcasts: event.broadcasts.flatMap(({ medium, network }) => broadcast(medium, network)),
    ...(event.situation === undefined ? {} : { situation: situation(league, event.situation, home.id) })
  })
})

const Moved = Schema.Struct({
  id: GameId,
  status: GameStatus,
  period: Schema.Int,
  clock: Schema.String,
  homeScore: Schema.Int,
  awayScore: Schema.Int,
  situation: Schema.optional(Situation)
})

/** What a FastCast event moves. */
const moved = Effect.fnUntraced(function* (league: LeagueId, event: typeof FastCastEvent.Type) {
  const home = event.competitors.find((competitor) => competitor.homeAway === "home")
  const away = event.competitors.find((competitor) => competitor.homeAway === "away")
  if (home === undefined || away === undefined) {
    return yield* Effect.fail(
      new SchemaIssue.InvalidValue({ message: "An event needs a home and an away team" }, event)
    )
  }
  return {
    id: GameId.make(event.id),
    status: statusOf(event.fullStatus.type),
    period: event.fullStatus.period,
    clock: event.fullStatus.displayClock,
    homeScore: scoreOf(home.score),
    awayScore: scoreOf(away.score),
    ...(event.situation === undefined ? {} : { situation: situation(league, event.situation, home.id) })
  }
})

// A score is digits, or nothing before kickoff, which reads as 0.
function scoreOf(score: string | undefined): number {
  return Number.parseInt(score ?? "", 10) || 0
}

// ESPN also lists radio, which no source plays.
function broadcast(medium: string, network: string): Array<Broadcast> {
  return medium === "TV"
    ? [{ network: Network.make(network), medium: "tv" }]
    : medium === "Streaming"
      ? [{ network: Network.make(network), medium: "streaming" }]
      : []
}

/** The domain `Situation`; the league and the home team's id orient its possession and yard line. */
function situation(league: LeagueId, raw: EspnSituation, homeTeamId: string): Situation {
  return new Situation({
    homeTimeouts: raw.homeTimeouts ?? 0,
    awayTimeouts: raw.awayTimeouts ?? 0,
    ...(raw.possession === undefined ? {} : { possession: teamId(league, raw.possession) }),
    // ESPN reports down -1 between plays (after a score, before a kickoff).
    ...(raw.down === undefined || raw.down < 1 ? {} : { down: raw.down }),
    distance: raw.distance,
    // ESPN counts the yard line from the home goal line; the domain counts it to the goal the team with
    // the ball attacks. Without a team on the ball it cannot be oriented.
    ...(raw.yardLine === undefined || raw.possession === undefined
      ? {}
      : { yardLine: raw.possession === homeTeamId ? 100 - raw.yardLine : raw.yardLine }),
    lastPlay: raw.lastPlay?.text
  })
}

function statusOf(type: EspnStatus["type"]): GameStatus {
  return byName.get(type.name) ?? byState[type.state]
}

// The statuses ESPN's name says, whatever its state; any other name reads as its state's.
const byName: ReadonlyMap<string, GameStatus> = new Map([
  ["STATUS_HALFTIME", "halftime"],
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
