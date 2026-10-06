import { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Team, TeamId } from "@sportal/domain/Team"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Provider, ProviderError } from "../Provider.ts"
import * as EspnPayload from "./EspnPayload.ts"
import * as EspnSnapshot from "./EspnSnapshot.ts"

export const layer = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

    const slate = Effect.fn("EspnProvider.slate")(function* (league: LeagueId) {
      const scoreboard = yield* client.get(scoreboardUrl(league)).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(EspnPayload.Scoreboard)),
        Effect.mapError((cause) => new ProviderError({ league, cause }))
      )
      return yield* slateOf(league, scoreboard)
    })

    return Provider.of({ slate })
  })
)

/** The snapshots in one ESPN scoreboard; an event that does not decode is skipped and logged. */
export const slateOf = Effect.fn("EspnProvider.slateOf")(function* (
  league: LeagueId,
  scoreboard: typeof EspnPayload.Scoreboard.Type
) {
  const snapshots: Array<GameSnapshot> = []
  for (const raw of scoreboard.events) {
    const event = decodeEvent(raw)
    if (Option.isNone(event)) {
      yield* Effect.logWarning("EspnProvider: skipped an event that failed to decode", raw)
      continue
    }
    const snapshot = toSnapshot(league, event.value)
    if (Option.isSome(snapshot)) snapshots.push(snapshot.value)
  }
  return snapshots
})

const decodeEvent = Schema.decodeUnknownOption(EspnPayload.Event)

function scoreboardUrl(league: LeagueId): string {
  const base = "https://site.api.espn.com/apis/site/v2/sports/football"
  return league === "nfl"
    ? `${base}/nfl/scoreboard`
    : `${base}/college-football/scoreboard?groups=80&limit=300`
}

function toSnapshot(league: LeagueId, event: typeof EspnPayload.Event.Type): Option.Option<GameSnapshot> {
  const competition = event.competitions[0]
  const home = competition.competitors.find((c) => c.homeAway === "home")
  const away = competition.competitors.find((c) => c.homeAway === "away")
  const kickoff = DateTime.make(event.date)
  if (home === undefined || away === undefined || Option.isNone(kickoff)) return Option.none()

  const side = (competitor: typeof home) => ({
    team: new Team({
      id: TeamId.make(`${league}:${competitor.team.id}`),
      abbreviation: competitor.team.abbreviation,
      name: competitor.team.displayName,
      location: competitor.team.location ?? competitor.team.displayName,
      shortName: competitor.team.shortDisplayName ?? competitor.team.displayName,
      ...(competitor.team.logo === undefined ? {} : { logo: competitor.team.logo })
    }),
    score: competitor.score ?? 0,
    ranking: competitor.curatedRank?.current
  })

  return Option.some(
    new GameSnapshot({
      id: GameId.make(event.id),
      league,
      kickoff: DateTime.toUtc(kickoff.value),
      status: event.status.type,
      period: event.status.period,
      clock: event.status.displayClock,
      home: side(home),
      away: side(away),
      broadcasts: (competition.geoBroadcasts ?? []).flatMap((broadcast) =>
        EspnSnapshot.broadcast(broadcast.type.shortName, broadcast.media.shortName)
      ),
      ...(competition.situation === undefined
        ? {}
        : { situation: EspnSnapshot.situation(league, competition.situation, home.team.id) })
    })
  )
}
