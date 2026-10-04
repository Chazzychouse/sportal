import { type Broadcast, GameId, GameSnapshot, type GameStatus, Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Situation } from "@sportal/domain/Situation"
import { Team, TeamId } from "@sportal/domain/Team"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Provider, ProviderError } from "../Provider.ts"
import * as EspnPayload from "./EspnPayload.ts"

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
    score: Number.parseInt(competitor.score ?? "0", 10) || 0,
    // ESPN reports 99 for unranked teams.
    ...(competitor.curatedRank === undefined || competitor.curatedRank.current > 25
      ? {}
      : { ranking: competitor.curatedRank.current })
  })

  const s = competition.situation
  return Option.some(
    new GameSnapshot({
      id: GameId.make(event.id),
      league,
      kickoff: DateTime.toUtc(kickoff.value),
      status: toStatus(event.status.type),
      period: event.status.period,
      clock: event.status.displayClock,
      home: side(home),
      away: side(away),
      broadcasts: (competition.geoBroadcasts ?? []).flatMap(toBroadcast),
      ...(s === undefined
        ? {}
        : {
            situation: new Situation({
              isRedZone: s.isRedZone ?? false,
              homeTimeouts: s.homeTimeouts ?? 0,
              awayTimeouts: s.awayTimeouts ?? 0,
              ...(s.possession === undefined ? {} : { possession: TeamId.make(`${league}:${s.possession}`) }),
              // ESPN reports down -1 between plays (after a score, before a kickoff).
              ...(s.down === undefined || s.down < 1 ? {} : { down: s.down }),
              ...(s.distance === undefined ? {} : { distance: s.distance }),
              ...(s.yardLine === undefined ? {} : { yardLine: s.yardLine }),
              ...(s.lastPlay?.text === undefined ? {} : { lastPlay: s.lastPlay.text })
            })
          })
    })
  )
}

/** A TV or streaming broadcast; ESPN also lists radio, which no source plays. */
function toBroadcast(broadcast: {
  readonly type: { readonly shortName: string }
  readonly media: { readonly shortName: string }
}): Array<Broadcast> {
  const medium =
    broadcast.type.shortName === "TV"
      ? "tv"
      : broadcast.type.shortName === "Streaming"
        ? "streaming"
        : undefined
  return medium === undefined ? [] : [{ network: Network.make(broadcast.media.shortName), medium }]
}

function toStatus(type: { readonly name: string; readonly state: "pre" | "in" | "post" }): GameStatus {
  switch (type.name) {
    case "STATUS_HALFTIME":
      return "halftime"
    case "STATUS_DELAYED":
      return "delayed"
    case "STATUS_POSTPONED":
      return "postponed"
    case "STATUS_CANCELED":
      return "canceled"
  }
  return type.state === "pre" ? "scheduled" : type.state === "in" ? "live" : "final"
}
