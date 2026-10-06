import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { DateTime, Duration, Effect, Layer, Option, Schedule, Stream } from "effect"
import { Headers, HttpClient } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import { Provider, ProviderError } from "../Provider.ts"
import * as EspnDecode from "./EspnDecode.ts"
import * as FastCast from "./FastCast.ts"

/**
 * ESPN as the provider: the site scoreboard polled, FastCast pushing, both decoded by `EspnDecode`. A poll that does
 * not connect is `Unreachable` for its league, and one answered with a status other than 2xx `Refused`. Polled every
 * 10 seconds while a game is live, every minute within 30 minutes of a kickoff, and every 15 minutes otherwise; at
 * most 30 seconds after a poll in which a league failed.
 */
export const layer: Layer.Layer<Provider, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =
  Layer.effect(
    Provider,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const provide = Stream.provideContext(
        yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>()
      )

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
          Effect.mapError(
            (cause) =>
              new ProviderError({
                reason: cause.reason._tag === "StatusCodeError" ? "Refused" : "Unreachable",
                league,
                cause
              })
          ),
          Effect.withSpan("EspnProvider.poll", { attributes: { "sportal.league": league } })
        )

      return Provider.of({
        poll,
        push: (leagues, wanted, resync) => provide(FastCast.push(leagues, wanted, resync)),
        decode: EspnDecode.decode,
        polling: Schedule.forever.pipe(
          Schedule.setInputType<{
            readonly slate: ReadonlyArray<GameSnapshot>
            readonly failed: ReadonlyArray<LeagueId>
          }>(),
          Schedule.modifyDelay(({ input, now }) =>
            Effect.succeed(interval(input.slate, DateTime.makeUnsafe(now), input.failed.length > 0))
          )
        )
      })
    })
  )

function scoreboardUrl(league: LeagueId): string {
  const base = "https://site.api.espn.com/apis/site/v2/sports/football"
  return league === "nfl"
    ? `${base}/nfl/scoreboard`
    : `${base}/college-football/scoreboard?groups=80&limit=300`
}

/**
 * How long to wait before the next poll, given the slate the last one left. When a league failed in it (`anyFailed`),
 * the wait is capped at 30 seconds so a missing or stale slate is retried soon; a live slate still polls every 10
 * seconds. Reads only each game's progress and kickoff, so any league polls by it.
 */
function interval(
  slate: ReadonlyArray<GameSnapshot>,
  now: DateTime.Utc,
  anyFailed: boolean
): Duration.Duration {
  const kickoffSoon = (game: GameSnapshot) =>
    game.progress() === "upcoming" &&
    DateTime.isLessThanOrEqualTo(game.kickoff, DateTime.add(now, { minutes: 30 }))
  const normal = slate.some((game) => game.progress() === "live")
    ? Duration.seconds(10)
    : slate.some(kickoffSoon)
      ? Duration.minutes(1)
      : Duration.minutes(15)
  return anyFailed ? Duration.min(normal, Duration.seconds(30)) : normal
}
