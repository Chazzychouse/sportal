import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { LiveGame } from "@sportal/domain/LiveGame"
import {
  Array as Arr,
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  Ref,
  Result,
  Schedule,
  Stream,
  SubscriptionRef
} from "effect"
import { GameActors } from "../GameActors.ts"
import { LiveFeed } from "../provider/LiveFeed.ts"
import { Provider } from "../provider/Provider.ts"
import * as Cadence from "./Cadence.ts"

/**
 * Polls each league at the Cadence, keeping its last good listing, and sends what it got to the game actors. Beside
 * the poll it runs the live feed, sending each pushed game the leagues have listed to its actor.
 */
export class Ingest extends Context.Service<
  Ingest,
  {
    /** What the leagues last listed, in poll order, on every poll even when nothing changed. */
    readonly listed: Stream.Stream<ReadonlyArray<GameSnapshot>>
  }
>()("sportal/hub/Ingest") {
  static readonly layer = (leagues: ReadonlyArray<LeagueId>) =>
    Layer.effect(
      Ingest,
      Effect.gen(function* () {
        const provider = yield* Provider
        const gameActors = yield* GameActors
        const liveFeed = yield* LiveFeed
        const listed = yield* SubscriptionRef.make<ReadonlyArray<GameSnapshot>>([])
        // The last good slate per league, so one league failing does not blank the other.
        const byLeague = yield* Ref.make<ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>>(new Map())

        const poll = Effect.fn("Ingest.poll")(function* () {
          const results = yield* Effect.forEach(leagues, (league) =>
            provider.slate(league).pipe(
              Effect.tap((slate) => Ref.update(byLeague, (kept) => new Map(kept).set(league, slate))),
              Effect.tapError((error) =>
                Effect.logWarning(
                  "Ingest: provider failed; keeping the last good slate for this league, if any",
                  error
                ).pipe(Effect.andThen(Metric.update(Metric.withAttributes(providerErrors, { league }), 1)))
              ),
              Effect.result
            )
          )
          const failed = results.filter(Result.isFailure).map((result) => result.failure.league)
          const kept = yield* Ref.get(byLeague)
          const games = leagues.flatMap((league) => kept.get(league) ?? [])
          // Only this poll's games: a failed league's kept games are not resent, so their actors go stale.
          yield* Effect.forEach(
            results.filter(Result.isSuccess).flatMap((result) => result.success),
            (snapshot) => gameActors.receive(snapshot, "poll"),
            { concurrency: "unbounded", discard: true }
          )
          yield* SubscriptionRef.set(listed, games)
          yield* Effect.annotateCurrentSpan({ "sportal.leagues": leagues, "sportal.failed_leagues": failed })
          const live = yield* gameActors.liveGames
          return { slate: LiveGame.asActorsHaveThem(games, live), failed }
        }, Effect.trackDuration(pollDuration))

        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const { slate, failed } = yield* poll()
              yield* Effect.sleep(Cadence.interval(slate, yield* DateTime.now, failed.length > 0))
            })
          )
        )

        // A pushed game carries FastCast's names, so it is sent as its listed game advanced to the push.
        const push = Effect.fn("Ingest.push")(function* (pushed: ReadonlyArray<GameSnapshot>) {
          const kept = yield* Ref.get(byLeague)
          const [advanced, unlisted] = Arr.partition(pushed, (game) =>
            Option.fromNullishOr(kept.get(game.league)?.find((listedGame) => listedGame.id === game.id)).pipe(
              Option.match({
                onNone: () => Result.fail(game),
                onSome: (listedGame) => Result.succeed(listedGame.advancedTo(game))
              })
            )
          )
          yield* Effect.forEach(
            unlisted,
            (game) => Metric.update(Metric.withAttributes(liveFeedUnlisted, { league: game.league }), 1),
            { discard: true }
          )
          yield* Effect.forEach(advanced, (snapshot) => gameActors.receive(snapshot, "push"), {
            concurrency: "unbounded",
            discard: true
          })
          yield* Effect.annotateCurrentSpan({
            "sportal.leagues": Arr.dedupe(pushed.map((game) => game.league)),
            "sportal.games": pushed.length,
            "sportal.unlisted": unlisted.length
          })
        })

        yield* Effect.forkScoped(
          liveFeed.games(leagues).pipe(
            Stream.tapError((error) =>
              Effect.logWarning(
                `Ingest: the live feed failed (${error.reason}); subscribing again`,
                error
              ).pipe(
                Effect.andThen(
                  Metric.update(Metric.withAttributes(liveFeedErrors, { reason: error.reason }), 1)
                )
              )
            ),
            Stream.retry(reconnect),
            Stream.runForEach(push),
            // Every failure is retried, so the feed ends only by completing or by a defect, and nothing pushes again.
            Effect.onExitIf(
              (exit) => !(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)),
              (exit) =>
                Effect.logError(
                  "Ingest: the live feed stopped; only the poll reaches the actors until the Hub restarts",
                  Exit.isFailure(exit) ? exit.cause : "the feed's stream ended"
                )
            )
          )
        )

        return Ingest.of({ listed: SubscriptionRef.changes(listed) })
      })
    )
}

const pollDuration = Metric.timer("sportal_poll_duration", {
  description: "How long one poll of every league takes"
})

const providerErrors = Metric.counter("sportal_provider_errors", {
  description: "Polls in which a league's provider failed",
  incremental: true
})

const liveFeedErrors = Metric.counter("sportal_live_feed_errors", {
  description: "Times the live feed failed and was subscribed to again, by why it failed",
  incremental: true
})

const liveFeedUnlisted = Metric.counter("sportal_live_feed_unlisted", {
  description: "Pushed games no poll has listed yet, so not sent",
  incremental: true
})

// Backoff from 1 s, each delay jittered and capped at a minute; Stream.retry resets it once the feed delivers again.
const reconnect = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.minutes(1))))
)
