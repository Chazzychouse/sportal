import { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { DateTime, Duration, Effect, HashMap, Layer, Option, Result, Stream, SubscriptionRef } from "effect"
import { HttpClient } from "effect/http"
import { HubConfig } from "../../HubConfig.ts"
import { Delivery, Provider } from "../Provider.ts"
import * as EspnEvent from "./EspnEvent.ts"
import { FastCast, type Wanted } from "./FastCast.ts"
import type { Frame } from "./Frame.ts"
import { GameTopics } from "./GameTopics.ts"
import { Topic } from "./Topic.ts"

/**
 * ESPN as the provider: the site scoreboard of each league `HubConfig` names, polled, beside FastCast's game topics,
 * with no order between the two. Each league polls on its own, each poll its league's `Listing`, and waits after it by
 * its own last good listing: 10 seconds while a game is live, a minute while one kicks off within 30 minutes, and 15
 * minutes otherwise; at most 30 seconds after a poll that failed or did not decode. A poll's request and body read are
 * bounded to 20 seconds; a poll that fails, times out, or does not decode is logged, says nothing, and keeps the last
 * good listing. It tells FastCast to follow each listed game live or within 30 minutes of kickoff, folds FastCast's
 * frames into one `GameTopics`, and after each listing keeps no document of a topic it no longer follows. Each run of
 * `deliveries` polls and follows on its own.
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
        Effect.flatMap((body) => EspnEvent.listingOf(league, body)),
        Effect.asSome,
        Effect.catch((error) =>
          Effect.logWarning(
            "EspnProvider: a poll failed; keeping the last good listing for this league, if any",
            error
          ).pipe(Effect.annotateLogs({ league }), Effect.as(Option.none()))
        )
      )

    const deliveries = Stream.unwrap(
      Effect.gen(function* () {
        // Each league's last good listing; only its poll sets it.
        const listings = yield* SubscriptionRef.make<Listings>(HashMap.empty())
        // What the game topics' fold last took, for `wanted` to read; only the fold sets it.
        const view = yield* SubscriptionRef.make(GameTopics.empty)

        const pollsOf = (league: LeagueId) =>
          Stream.unfold(
            { games: noGames, wait: Duration.zero },
            Effect.fnUntraced(function* ({ games, wait }) {
              yield* Effect.sleep(wait)
              const listed = yield* polled(league)
              if (Option.isSome(listed)) {
                yield* SubscriptionRef.update(listings, (all) => HashMap.set(all, league, listed.value))
              }
              const now = yield* DateTime.now

              const last = Option.getOrElse(listed, () => games)
              const said = Option.toArray(
                Option.map(listed, (listing) => Delivery.Listing({ league, games: listing }))
              )
              return [said, { games: last, wait: waitAfter(last, Option.isNone(listed), now) }] as const
            })
          )
        const polls = Stream.mergeAll(
          leagues.map((league) => pollsOf(league)),
          { concurrency: "unbounded" }
        )

        // A frame is taken; a listing keeps only the topics wanted at the clock's now, and says nothing.
        const taken = Effect.fnUntraced(function* (topics: GameTopics, each: Result.Result<Frame, Listings>) {
          const [next, said] = yield* Result.match(each, {
            onSuccess: (frame) => Effect.map(topics.take(frame), ([after, one]) => [after, [one]] as const),
            onFailure: (latest) =>
              Effect.map(DateTime.now, (now) => [topics.retainedFor(gamesOf(latest), now), []] as const)
          })

          yield* SubscriptionRef.set(view, next)
          return [next, said] as const
        })
        const gameTopics = fastCast.follow(wantedOf(listings, view)).pipe(
          Stream.mergeResult(SubscriptionRef.changes(listings)),
          Stream.mapAccumEffect(() => GameTopics.empty, taken)
        )

        return Stream.merge(polls, gameTopics)
      })
    )

    return Provider.of({ deliveries })
  })
)

/** Each league's last good listing. */
type Listings = HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>

/** The site scoreboard of `league` the Hub polls: today's games, every FBS game for college. */
function scoreboardUrl(league: LeagueId): string {
  const base = "https://site.api.espn.com/apis/site/v2/sports/football"
  return league === "nfl"
    ? `${base}/nfl/scoreboard`
    : `${base}/college-football/scoreboard?groups=80&limit=300`
}

const noGames: ReadonlyArray<GameSnapshot> = []

/**
 * How long a league waits after a poll, by its last good listing `games`: 10 seconds while one is live, a minute while
 * one kicks off within `GameSnapshot.kickoffWindow`, and 15 minutes otherwise; at most 30 seconds when this poll
 * `failed` or did not decode, so its scoreboard is read again soon.
 */
function waitAfter(
  games: ReadonlyArray<GameSnapshot>,
  failed: boolean,
  now: DateTime.Utc
): Duration.Duration {
  const normal = games.some((game) => game.progress() === "live")
    ? Duration.seconds(10)
    : games.some((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
      ? Duration.minutes(1)
      : Duration.minutes(15)
  return failed ? Duration.min(normal, Duration.seconds(30)) : normal
}

/** Every game `listings` lists. */
function gamesOf(listings: Listings): ReadonlyArray<GameSnapshot> {
  return [...HashMap.values(listings)].flat()
}

/**
 * What FastCast follows, read from `listings` and `view` on each change of either and once a minute, so a kickoff
 * coming into its window is followed with no frame to say so.
 */
function wantedOf(
  listings: SubscriptionRef.SubscriptionRef<Listings>,
  view: SubscriptionRef.SubscriptionRef<GameTopics>
): Stream.Stream<Wanted> {
  const wanted = Effect.gen(function* () {
    const listed = yield* SubscriptionRef.get(listings)
    const topics = yield* SubscriptionRef.get(view)
    const now = yield* DateTime.now

    const followed = Topic.wantedAt(gamesOf(listed), now)
    return HashMap.fromIterable(
      [...followed].map((topic) => [topic, topics.isSynced(topic) ? "Synced" : "AwaitingCheckpoint"] as const)
    )
  })
  return Stream.merge(SubscriptionRef.changes(listings), SubscriptionRef.changes(view)).pipe(
    Stream.merge(Stream.tick("1 minute")),
    Stream.mapEffect(() => wanted),
    Stream.changes
  )
}
