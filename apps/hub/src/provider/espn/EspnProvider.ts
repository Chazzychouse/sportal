import { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import {
  DateTime,
  Duration,
  Effect,
  HashSet,
  Layer,
  Metric,
  Option,
  Predicate,
  Stream,
  SubscriptionRef
} from "effect"
import { HttpClient } from "effect/http"
import { HubConfig } from "../../HubConfig.ts"
import { Provider } from "../Provider.ts"
import { EspnState } from "./EspnState.ts"
import { FastCast, type Wanted } from "./FastCast.ts"
import { Frame } from "./Frame.ts"
import { ProviderUnavailable } from "./ProviderUnavailable.ts"

/**
 * ESPN as the provider: the site scoreboard of each league `HubConfig` names, polled, and FastCast pushing, every frame
 * folded, in the order it arrives, into one `EspnState` by one fold. Each league polls on its own, waiting after each
 * poll by its own listed games: 10 seconds while one is live, a minute within 30 minutes of a kickoff, and 15 minutes
 * otherwise; at most 30 seconds while its last poll failed or did not decode. A poll that does not connect is
 * `Unreachable` for its league, and one answered with a status other than 2xx `Refused`; either is logged and counted,
 * and is a `PollFailed` frame. It tells FastCast to follow every league's scoreboard topic and each listed game live or
 * within 30 minutes of kickoff, and keeps no document of a topic it no longer follows. Each run of `deliveries` polls
 * and follows on its own.
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
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderUnavailable({
                reason: Predicate.isTagged(cause.reason, "StatusCodeError") ? "Refused" : "Unreachable",
                league,
                cause
              })
          ),
          Effect.tapError((error) =>
            Effect.logWarning(
              "EspnProvider: a poll failed; keeping the last good listing for this league, if any",
              error
            ).pipe(Effect.andThen(Metric.update(Metric.withAttributes(providerErrors, { league }), 1)))
          ),
          Effect.trackDuration(Metric.withAttributes(pollDuration, { league }))
        )
    )
    // Outside the span, which records the failure before it becomes a frame.
    const polled = (league: LeagueId) =>
      Effect.catchTag(poll(league), "ProviderUnavailable", () => Effect.succeed(Frame.PollFailed({ league })))

    const deliveries = Stream.unwrap(
      Effect.gen(function* () {
        // What the fold last took, for `wanted` to read; only the fold sets it.
        const view = yield* SubscriptionRef.make(EspnState.empty)
        // When each league polls next; only the fold sets it, once it has taken that league's poll.
        const pollAt = new Map(
          yield* Effect.forEach(leagues, (league) =>
            Effect.map(SubscriptionRef.make(Option.none<DateTime.Utc>()), (at) => [league, at] as const)
          )
        )

        const pollsOf = (
          league: LeagueId,
          at: SubscriptionRef.SubscriptionRef<Option.Option<DateTime.Utc>>
        ) =>
          SubscriptionRef.changes(at).pipe(
            Stream.switchMap((next) => Stream.fromEffect(Effect.andThen(sleepUntil(next), polled(league))))
          )
        const polls = Stream.mergeAll(
          [...pollAt].map(([league, at]) => pollsOf(league, at)),
          { concurrency: "unbounded" }
        )
        const pushes = fastCast.follow(wantedOf(view, leagues))

        const takeFrame = Effect.fnUntraced(function* (state: EspnState, frame: Frame) {
          const [taken, said] = yield* state.take(frame)
          const now = yield* DateTime.now

          const league = pollLeagueOf(frame)
          const next = Option.isSome(league) ? taken.retained(leagues, now) : taken
          yield* SubscriptionRef.set(view, next)
          const nextPoll = Option.flatMap(league, (one) =>
            Option.map(Option.fromUndefinedOr(pollAt.get(one)), (at) =>
              SubscriptionRef.set(at, Option.some(DateTime.addDuration(now, interval(next, one, now))))
            )
          )
          yield* Option.getOrElse(nextPoll, () => Effect.void)

          return [next, [said]] as const
        })

        return Stream.merge(polls, pushes).pipe(Stream.mapAccumEffect(() => EspnState.empty, takeFrame))
      })
    )

    return Provider.of({ deliveries })
  })
)

/** The site scoreboard of `league` the Hub polls: today's games, every FBS game for college. */
function scoreboardUrl(league: LeagueId): string {
  const base = "https://site.api.espn.com/apis/site/v2/sports/football"
  return league === "nfl"
    ? `${base}/nfl/scoreboard`
    : `${base}/college-football/scoreboard?groups=80&limit=300`
}

/** Sleeps until `at`, or not at all when there is none yet or it has passed. */
function sleepUntil(at: Option.Option<DateTime.Utc>): Effect.Effect<void> {
  return Option.match(at, {
    onNone: () => Effect.void,
    onSome: (when) => Effect.flatMap(DateTime.now, (now) => Effect.sleep(DateTime.distance(now, when)))
  })
}

/**
 * What FastCast follows, read from `view` again on each change and once a minute from the last state seen, so a
 * kickoff coming into its window is followed with no frame to say so.
 */
function wantedOf(
  view: SubscriptionRef.SubscriptionRef<EspnState>,
  leagues: ReadonlyArray<LeagueId>
): Stream.Stream<Wanted> {
  return Stream.merge(
    SubscriptionRef.changes(view).pipe(Stream.map(Option.some)),
    Stream.tick("1 minute").pipe(Stream.as(Option.none<EspnState>()))
  ).pipe(
    Stream.mapAccum(
      (): Option.Option<EspnState> => Option.none(),
      (last, seen) => {
        const current = Option.orElse(seen, () => last)
        return [current, Option.toArray(current)] as const
      }
    ),
    Stream.mapEffect((current) => Effect.map(DateTime.now, (now) => current.wanted(leagues, now))),
    Stream.changes
  )
}

/** The league a poll's frame is of; none for a push. */
function pollLeagueOf(frame: Frame): Option.Option<LeagueId> {
  return Frame.$match(frame, {
    Polled: ({ league }) => Option.some(league),
    PollFailed: ({ league }) => Option.some(league),
    Pushed: () => Option.none(),
    Checkpoint: () => Option.none()
  })
}

/**
 * How long `league` waits before its next poll, by its own listed games. While its last poll failed or did not
 * decode, the wait is capped at 30 seconds so its scoreboard is read again soon; a live game still polls every 10
 * seconds. Reads only each game's progress and kickoff, so any league polls by it.
 */
function interval(state: EspnState, league: LeagueId, now: DateTime.Utc): Duration.Duration {
  const games = state.listing(league)
  const normal = games.some((game) => game.progress() === "live")
    ? Duration.seconds(10)
    : games.some((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
      ? Duration.minutes(1)
      : Duration.minutes(15)
  return HashSet.has(state.unlisted, league) ? Duration.min(normal, Duration.seconds(30)) : normal
}

const pollDuration = Metric.timer("sportal_poll_duration", {
  description: "How long one league's poll takes, by league"
})

const providerErrors = Metric.counter("sportal_provider_errors", {
  description: "Polls in which a league's provider failed",
  incremental: true
})
