import type { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect, Layer, Option, Stream, SubscriptionRef } from "effect"
import { HttpClient } from "effect/http"
import { HubConfig } from "../../HubConfig.ts"
import { Provider } from "../Provider.ts"
import { EspnState } from "./EspnState.ts"
import { FastCast, type Wanted } from "./FastCast.ts"
import { Frame } from "./Frame.ts"

/**
 * ESPN as the provider: the site scoreboard of each league `HubConfig` names, polled, and FastCast pushing, every frame
 * folded, in the order it arrives, into one `EspnState` by one fold. Each league polls on its own, waiting after each
 * poll by its own listed games: 10 seconds while one is live, a minute within 30 minutes of a kickoff, and 15 minutes
 * otherwise; at most 30 seconds while its last poll failed or did not decode. A poll's request and body read are
 * bounded to 20 seconds; a poll that fails or times out is logged and is a `PollFailed` frame. It tells FastCast to
 * follow every league's scoreboard topic and each listed game live or within 30 minutes of kickoff, and keeps no
 * document of a topic it no longer follows. Each run of `deliveries` polls and follows on its own.
 */
export const layer: Layer.Layer<Provider, never, FastCast | HttpClient.HttpClient | HubConfig> = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const { leagues } = yield* HubConfig
    const http = yield* HttpClient.HttpClient
    const fastCast = yield* FastCast
    const client = http.pipe(HttpClient.filterStatusOk)

    const polled = (league: LeagueId) =>
      client.get(scoreboardUrl(league)).pipe(
        Effect.flatMap((response) => response.text),
        Effect.timeout("20 seconds"),
        Effect.map((body) => Frame.Polled({ league, body })),
        Effect.catch((error) =>
          Effect.logWarning(
            "EspnProvider: a poll failed; keeping the last good listing for this league, if any",
            error
          ).pipe(Effect.annotateLogs({ league }), Effect.as(Frame.PollFailed({ league })))
        )
      )

    const deliveries = Stream.unwrap(
      Effect.gen(function* () {
        // What the fold last took, for `wanted` to read; only the fold sets it.
        const view = yield* SubscriptionRef.make(EspnState.empty)
        // When each league polls next; only the fold sets it, once it has taken that league's poll.
        const pollRefs = yield* Effect.forEach(leagues, (league) =>
          Effect.map(SubscriptionRef.make(Option.none<DateTime.Utc>()), (at) => [league, at] as const)
        )
        const pollAt = new Map(pollRefs)

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
          const [next, said] = yield* state.take(frame, leagues)
          const now = yield* DateTime.now
          const league = pollLeagueOf(frame)

          yield* SubscriptionRef.set(view, next)
          if (Option.isSome(league)) {
            const at = pollAt.get(league.value)
            if (at !== undefined) {
              const nextPoll = DateTime.addDuration(now, next.pollInterval(league.value, now))
              yield* SubscriptionRef.set(at, Option.some(nextPoll))
            }
          }

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
 * What FastCast follows, read from `view` on each change and once a minute, so a kickoff coming into its window is
 * followed with no frame to say so.
 */
function wantedOf(
  view: SubscriptionRef.SubscriptionRef<EspnState>,
  leagues: ReadonlyArray<LeagueId>
): Stream.Stream<Wanted> {
  return Stream.merge(
    SubscriptionRef.changes(view),
    Stream.tick("1 minute").pipe(Stream.mapEffect(() => SubscriptionRef.get(view)))
  ).pipe(
    Stream.mapEffect((state) => Effect.map(DateTime.now, (now) => state.wanted(leagues, now))),
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
