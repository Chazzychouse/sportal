import { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import {
  DateTime,
  Duration,
  Effect,
  HashMap,
  Layer,
  Metric,
  Option,
  Predicate,
  Schedule,
  Stream
} from "effect"
import { HttpClient } from "effect/http"
import { HubConfig } from "../../HubConfig.ts"
import { Provider } from "../Provider.ts"
import * as EspnDecoder from "./EspnDecoder.ts"
import { FastCast } from "./FastCast.ts"
import { Frame } from "./Frame.ts"
import { ProviderUnavailable } from "./ProviderUnavailable.ts"

/**
 * ESPN as the provider: the site scoreboard of each league `HubConfig` names, polled, and FastCast pushing, their
 * frames read by `EspnDecoder`. It polls every league, then waits by the games those scoreboards last showed (a league
 * that failed or did not decode keeps its last good games): 10 seconds while a game is live, a minute within 30 minutes
 * of a kickoff, and 15 minutes otherwise; at most 30 seconds after a poll in which a league failed or did not decode.
 * A poll that does not connect is `Unreachable` for its league, and one answered with a status other than 2xx
 * `Refused`; either is logged and counted, and delivers no frame.
 */
export const layer: Layer.Layer<Provider, never, FastCast | HttpClient.HttpClient | HubConfig> = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const { leagues } = yield* HubConfig
    const http = yield* HttpClient.HttpClient
    const fastCast = yield* FastCast
    const client = http.pipe(HttpClient.filterStatusOk)

    const poll = Effect.fn("EspnProvider.poll")(
      function* (league: LeagueId) {
        yield* Effect.annotateCurrentSpan("sportal.league", league)
        const response = yield* client.get(scoreboardUrl(league))
        const body = yield* response.text

        return Frame.Polled({ league, body })
      },
      (effect, league) =>
        Effect.mapError(
          effect,
          (cause) =>
            new ProviderUnavailable({
              reason: Predicate.isTagged(cause.reason, "StatusCodeError") ? "Refused" : "Unreachable",
              league,
              cause
            })
        )
    )
    // Its timer keeps the name the dashboards read.
    const pollEveryLeague = Effect.fn("EspnProvider.pollEveryLeague")(function* () {
      const polled = yield* Effect.forEach(leagues, (league) => polledOf(league, poll(league)))
      const failed = polled.flatMap(({ league, frame }) => (Option.isNone(frame) ? [league] : []))
      yield* Effect.annotateCurrentSpan({ "sportal.leagues": leagues, "sportal.failed_leagues": failed })
      return polled
    }, Effect.trackDuration(pollDuration))

    const polls = Stream.fromEffectSchedule(pollEveryLeague(), polling).pipe(
      Stream.flatMap((polled) => Stream.fromIterable(polled.flatMap(({ frame }) => Option.toArray(frame))))
    )

    return Provider.of({ deliveries: EspnDecoder.decode(Stream.merge(polls, fastCast.frames)) })
  })
)

/** The site scoreboard of `league` the Hub polls: today's games, every FBS game for college. */
function scoreboardUrl(league: LeagueId): string {
  const base = "https://site.api.espn.com/apis/site/v2/sports/football"
  return league === "nfl"
    ? `${base}/nfl/scoreboard`
    : `${base}/college-football/scoreboard?groups=80&limit=300`
}

/**
 * One league's part of a poll: its frame, none when the poll failed, and the games its scoreboard shows, none when the
 * poll failed or the scoreboard did not decode.
 */
interface Polled {
  readonly league: LeagueId
  readonly frame: Option.Option<Frame>
  readonly games: Option.Option<ReadonlyArray<GameSnapshot>>
}

/** `league`'s part of a poll by `polling`, whose failure is logged and counted. */
const polledOf = Effect.fnUntraced(function* (
  league: LeagueId,
  polling: Effect.Effect<Frame, ProviderUnavailable>
) {
  const frame = yield* polling.pipe(
    Effect.tapError((error) =>
      Effect.logWarning(
        "EspnProvider: a poll failed; keeping the last good listing for this league, if any",
        error
      ).pipe(Effect.andThen(Metric.update(Metric.withAttributes(providerErrors, { league }), 1)))
    ),
    Effect.option
  )
  const games = yield* Option.match(frame, {
    onNone: () => Effect.succeedNone,
    onSome: ({ body }) => Effect.option(gamesShown(league, body))
  })
  return { league, frame, games } satisfies Polled
})

/**
 * The games `league`'s scoreboard `body` shows, as its listing reads them; an event that does not decode is left out.
 */
const gamesShown = Effect.fnUntraced(function* (league: LeagueId, body: string) {
  const scoreboard = yield* EspnDecoder.byLeague[league].decodeScoreboard(body)
  return yield* EspnDecoder.gamesOf(league, scoreboard.events)
})

/**
 * ESPN's polling policy: each poll waits as `interval` says of the games each league's scoreboard last showed. A
 * league that failed or did not decode keeps the games it last showed, and its failure caps the wait at 30 seconds.
 */
const polling: Schedule.Schedule<
  HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>,
  ReadonlyArray<Polled>
> = Schedule.fromStep(
  Effect.sync(() => {
    // Effect's `fromStep` gives the step no previous state, so the closure carries it, as Effect's own Schedules do:
    // fresh for each run, and only ever rebound to a new immutable value.
    let shown = HashMap.empty<LeagueId, ReadonlyArray<GameSnapshot>>()
    return (now: number, polled: ReadonlyArray<Polled>) => {
      shown = shownAfter(shown, polled)
      const next: [HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>, Duration.Duration] = [
        shown,
        interval(shown, polled, DateTime.makeUnsafe(now))
      ]
      return Effect.succeed(next)
    }
  })
)

/** `shown`, with each league `polled` read again replaced by what its scoreboard shows now. */
function shownAfter(
  shown: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>,
  polled: ReadonlyArray<Polled>
): HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>> {
  return polled.reduce(
    (carried, { league, games }) =>
      Option.match(games, { onNone: () => carried, onSome: (read) => HashMap.set(carried, league, read) }),
    shown
  )
}

/**
 * How long to wait before the next poll, given the games each league last showed. When a league failed in the last
 * poll or its scoreboard did not decode, the wait is capped at 30 seconds so that scoreboard is read again soon; a live
 * game, its own league's included, still polls every 10 seconds. Reads only each game's progress and kickoff, so any
 * league polls by it.
 */
function interval(
  shown: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>,
  polled: ReadonlyArray<Polled>,
  now: DateTime.Utc
): Duration.Duration {
  const games = [...HashMap.values(shown)].flat()
  const anyUnread = polled.some(({ games }) => Option.isNone(games))
  const normal = games.some((game) => game.progress() === "live")
    ? Duration.seconds(10)
    : games.some((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
      ? Duration.minutes(1)
      : Duration.minutes(15)
  return anyUnread ? Duration.min(normal, Duration.seconds(30)) : normal
}

const pollDuration = Metric.timer("sportal_poll_duration", {
  description: "How long one poll of every league takes"
})

const providerErrors = Metric.counter("sportal_provider_errors", {
  description: "Polls in which a league's provider failed",
  incremental: true
})
