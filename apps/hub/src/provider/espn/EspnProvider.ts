import type { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect, Layer, Option } from "effect"
import { Headers, HttpClient } from "effect/http"
import { Provider, ProviderError } from "../Provider.ts"
import * as EspnDecode from "./EspnDecode.ts"

export const layer = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

    const poll = (league: LeagueId) =>
      Effect.gen(function* () {
        const response = yield* client.get(scoreboardUrl(league))
        const body = yield* response.text
        return {
          receivedAt: yield* DateTime.now,
          sentAt: Option.getOrUndefined(
            Option.flatMap(Headers.get(response.headers, "date"), (date) => DateTime.make(date))
          ),
          feed: "poll",
          channel: league,
          kind: "response",
          body
        } as const
      }).pipe(
        Effect.mapError((cause) => new ProviderError({ league, cause })),
        Effect.withSpan("EspnProvider.poll", { attributes: { "sportal.league": league } })
      )

    return Provider.of({ poll, decode: EspnDecode.decode })
  })
)

function scoreboardUrl(league: LeagueId): string {
  const base = "https://site.api.espn.com/apis/site/v2/sports/football"
  return league === "nfl"
    ? `${base}/nfl/scoreboard`
    : `${base}/college-football/scoreboard?groups=80&limit=300`
}
