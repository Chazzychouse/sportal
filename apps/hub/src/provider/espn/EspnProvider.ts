import { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import {
  DateTime,
  Duration,
  Effect,
  Layer,
  Metric,
  Option,
  Predicate,
  Schedule,
  Stream,
  SubscriptionRef
} from "effect"
import { HttpClient } from "effect/http"
import { HubConfig } from "../../HubConfig.ts"
import { Delivery } from "../../slate/Delivery.ts"
import { Provider } from "../Provider.ts"
import { EspnState } from "./EspnState.ts"
import { FastCast } from "./FastCast.ts"
import { Frame } from "./Frame.ts"
import { ProviderUnavailable } from "./ProviderUnavailable.ts"

/**
 * ESPN as the provider: the site scoreboard of each league `HubConfig` names, polled, and FastCast pushing, every frame
 * folded once into one `EspnState`. It polls every league, then waits by every game the state lists (a push moves a
 * listed game forward): 10 seconds while a game is live, a minute within 30 minutes of a kickoff, and 15 minutes
 * otherwise; at most 30 seconds after a poll in which a league failed or did not decode. A poll that does not connect is
 * `Unreachable` for its league, and one answered with a status other than 2xx `Refused`; either is logged and counted,
 * and delivers no frame.
 */
export const layer: Layer.Layer<Provider, never, FastCast | HttpClient.HttpClient | HubConfig> = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const { leagues } = yield* HubConfig
    const http = yield* HttpClient.HttpClient
    const fastCast = yield* FastCast
    const client = http.pipe(HttpClient.filterStatusOk)
    const state = yield* SubscriptionRef.make(EspnState.empty)

    // One frame at a time into the one state: what it said.
    const taken = (frame: Frame) =>
      SubscriptionRef.modifyEffect(state, (current) =>
        Effect.map(current.take(frame), ([next, deliveries]) => [deliveries, next] as const)
      )

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
      const polled = yield* Effect.forEach(leagues, (league) => polledOf(league, poll(league), taken))
      const failed = polled.flatMap(({ league, said }) => (Option.isNone(said) ? [league] : []))
      yield* Effect.annotateCurrentSpan({ "sportal.leagues": leagues, "sportal.failed_leagues": failed })
      return polled
    }, Effect.trackDuration(pollDuration))

    const polls = Stream.fromEffectSchedule(pollEveryLeague(), polling(state)).pipe(
      Stream.flatMap((polled) => Stream.fromIterable(polled.flatMap(({ said }) => Option.toArray(said))))
    )
    const pushes = fastCast.frames.pipe(Stream.mapEffect(taken))

    return Provider.of({ deliveries: Stream.merge(polls, pushes) })
  })
)

/** The site scoreboard of `league` the Hub polls: today's games, every FBS game for college. */
function scoreboardUrl(league: LeagueId): string {
  const base = "https://site.api.espn.com/apis/site/v2/sports/football"
  return league === "nfl"
    ? `${base}/nfl/scoreboard`
    : `${base}/college-football/scoreboard?groups=80&limit=300`
}

/** One league's part of a poll: what its frame said, none when the poll failed. */
interface Polled {
  readonly league: LeagueId
  readonly said: Option.Option<ReadonlyArray<Delivery>>
}

/** `league`'s part of a poll by `polling`, its frame `taken` into the state; a failure is logged and counted. */
const polledOf = Effect.fnUntraced(function* (
  league: LeagueId,
  polling: Effect.Effect<Frame, ProviderUnavailable>,
  taken: (frame: Frame) => Effect.Effect<ReadonlyArray<Delivery>>
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
  const said = yield* Option.match(frame, {
    onNone: () => Effect.succeedNone,
    onSome: (polled) => Effect.map(taken(polled), Option.some)
  })
  return { league, said } satisfies Polled
})

/**
 * ESPN's polling policy: after each poll, wait as `interval` says of every game `state` lists then. A league whose poll
 * failed or did not list caps the wait at 30 seconds.
 */
function polling(
  state: SubscriptionRef.SubscriptionRef<EspnState>
): Schedule.Schedule<Duration.Duration, ReadonlyArray<Polled>> {
  return Schedule.fromStep(
    Effect.succeed((now: number, polled: ReadonlyArray<Polled>) =>
      Effect.map(SubscriptionRef.get(state), (current) => {
        const wait = interval(current.games(), polled.some(unlisted), DateTime.makeUnsafe(now))
        const step: [Duration.Duration, Duration.Duration] = [wait, wait]
        return step
      })
    )
  )
}

/** Whether a league's part of a poll listed nothing: the poll failed, or its scoreboard did not decode. */
function unlisted({ said }: Polled): boolean {
  return !Option.exists(said, (deliveries) => deliveries.some(Delivery.guards.Listing))
}

/**
 * How long to wait before the next poll, given every listed game. When a league failed in the last poll or its
 * scoreboard did not decode, the wait is capped at 30 seconds so that scoreboard is read again soon; a live game still
 * polls every 10 seconds. Reads only each game's progress and kickoff, so any league polls by it.
 */
function interval(
  games: ReadonlyArray<GameSnapshot>,
  anyUnlisted: boolean,
  now: DateTime.Utc
): Duration.Duration {
  const normal = games.some((game) => game.progress() === "live")
    ? Duration.seconds(10)
    : games.some((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
      ? Duration.minutes(1)
      : Duration.minutes(15)
  return anyUnlisted ? Duration.min(normal, Duration.seconds(30)) : normal
}

const pollDuration = Metric.timer("sportal_poll_duration", {
  description: "How long one poll of every league takes"
})

const providerErrors = Metric.counter("sportal_provider_errors", {
  description: "Polls in which a league's provider failed",
  incremental: true
})
