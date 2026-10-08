import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { DateTime, Duration, Effect, Layer, Option, Schedule } from "effect"
import { Headers, HttpClient, HttpClientError } from "effect/http"
import { Frame } from "../../Frame.ts"
import { type Polling, Provider, ProviderUnavailable } from "../Provider.ts"
import { FastCast } from "./FastCast.ts"

/**
 * ESPN as the provider: the site scoreboard polled and FastCast pushing, their frames read by `EspnDecoder`. A poll
 * that does not connect is `Unreachable` for its league, and one answered with a status other than 2xx `Refused`.
 * Polled every 10 seconds while a game is live, every minute within 30 minutes of a kickoff, and every 15 minutes
 * otherwise; at most 30 seconds after a poll in which a league failed. FastCast decides what it follows and reconnects
 * itself, so its push ignores the demand and is never subscribed to again.
 */
export const layer: Layer.Layer<Provider, never, FastCast | HttpClient.HttpClient> = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const fastCast = yield* FastCast
    const client = http.pipe(HttpClient.filterStatusOk)

    const poll = Effect.fn("EspnProvider.poll")(
      function* (league: LeagueId) {
        yield* Effect.annotateCurrentSpan("sportal.league", league)
        const response = yield* client.get(scoreboardUrl(league))
        const body = yield* response.text
        const receivedAt = yield* DateTime.now

        const sentAt = Option.getOrUndefined(
          Option.flatMap(Headers.get(response.headers, "date"), (date) => DateTime.make(date))
        )
        return new Frame({ receivedAt, sentAt, source: "poll", channel: league, kind: "whole", body })
      },
      (effect, league) =>
        Effect.mapError(
          effect,
          (cause) =>
            new ProviderUnavailable({
              reason: cause.reason instanceof HttpClientError.StatusCodeError ? "Refused" : "Unreachable",
              league,
              cause
            })
        )
    )

    return Provider.of({
      poll,
      push: () => fastCast.frames,
      polling: Schedule.forever.pipe(
        Schedule.setInputType<Schedule.Input<Polling>>(),
        Schedule.modifyDelay(({ input, now }) =>
          Effect.succeed(interval(input.slate, DateTime.makeUnsafe(now), input.failed.length > 0))
        )
      ),
      reconnect: Schedule.recurs(0)
    })
  })
)

/** The site scoreboard of `league` the Hub polls: today's games, every FBS game for college. */
export function scoreboardUrl(league: LeagueId): string {
  return league === "nfl"
    ? `${siteUrl(league)}/scoreboard`
    : `${siteUrl(league)}/scoreboard?groups=80&limit=300`
}

/** ESPN's site API for `league`, which its scoreboard and its game summaries are under. */
export function siteUrl(league: LeagueId): string {
  const base = "https://site.api.espn.com/apis/site/v2/sports/football"
  return league === "nfl" ? `${base}/nfl` : `${base}/college-football`
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
  const normal = slate.some((game) => game.progress() === "live")
    ? Duration.seconds(10)
    : slate.some((game) => game.isLiveOrKicksOffWithin(FastCast.kickoffWindow, now))
      ? Duration.minutes(1)
      : Duration.minutes(15)
  return anyFailed ? Duration.min(normal, Duration.seconds(30)) : normal
}
