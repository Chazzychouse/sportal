import {
  Array as Arr,
  DateTime,
  Duration,
  Effect,
  Equivalence,
  Layer,
  Metric,
  Option,
  Result,
  Schedule,
  Stream
} from "effect"
import { FeedLog } from "../FeedLog.ts"
import { HubConfig } from "../HubConfig.ts"
import { loggedUnlessStopping } from "../HubStopping.ts"
import { LiveGames } from "../LiveGames.ts"
import { Provider } from "../provider/Provider.ts"

/**
 * Polls each league on the provider's polling Schedule and runs its push, appending every frame to the feed log; the
 * live games fold what it appends.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { leagues } = yield* HubConfig
    const provider = yield* Provider
    const feedLog = yield* FeedLog
    const liveGames = yield* LiveGames

    const poll = Effect.fn("Ingest.poll")(function* () {
      const results = yield* Effect.forEach(leagues, (league) =>
        provider.poll(league).pipe(
          Effect.flatMap(feedLog.append),
          Effect.tapError((error) =>
            Effect.logWarning(
              "Ingest: provider failed; keeping the last good listing for this league, if any",
              error
            ).pipe(Effect.andThen(Metric.update(Metric.withAttributes(providerErrors, { league }), 1)))
          ),
          Effect.result
        )
      )
      const failed = results.flatMap((result) =>
        Result.isFailure(result) && result.failure.league !== undefined ? [result.failure.league] : []
      )
      yield* Effect.annotateCurrentSpan({ "sportal.leagues": leagues, "sportal.failed_leagues": failed })
      return {
        failed,
        last: Arr.last(results.filter(Result.isSuccess).map((result) => result.success.seq))
      }
    }, Effect.trackDuration(pollDuration))

    // The Schedule is given the fold's slate once it has taken the poll's listings, and the leagues that failed.
    const polled = Effect.gen(function* () {
      const { failed, last } = yield* poll()
      const folded = yield* Option.match(last, { onNone: () => liveGames.latest, onSome: liveGames.through })
      return { slate: folded.slate(leagues), failed }
    })
    yield* Effect.forkScoped(Effect.repeat(polled, provider.polling))

    // The current games' snapshots, again on each change to which games they are. Each subscriber gets the
    // current ones first, so a reconnecting push subscribes to them all again.
    const wanted = liveGames.changes.pipe(
      Stream.mapEffect((folded) =>
        Effect.map(DateTime.now, (now) =>
          [...folded.live.values()]
            .filter((liveGame) => liveGame.isCurrent(now))
            .map((liveGame) => liveGame.snapshot)
        )
      ),
      Stream.changesWith((self, that) =>
        sameIds(
          self.map((game) => game.id),
          that.map((game) => game.id)
        )
      )
    )

    yield* Effect.forkScoped(
      provider.push(leagues, wanted, liveGames.resyncs).pipe(
        Stream.tapError((error) =>
          Effect.logWarning(`Ingest: the live feed failed (${error.reason}); subscribing again`, error).pipe(
            Effect.andThen(Metric.update(Metric.withAttributes(liveFeedErrors, { reason: error.reason }), 1))
          )
        ),
        Stream.retry(reconnect),
        Stream.runForEach(feedLog.append),
        // Every failure is retried, so the feed ends only by completing or by a defect, and nothing pushes again.
        loggedUnlessStopping(
          "Ingest: the live feed stopped; only the poll reaches the fold until the Hub restarts",
          "the feed's stream ended"
        )
      )
    )
  })
)

const sameIds = Arr.makeEquivalence(Equivalence.String)

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

// Backoff from 1 s, each delay jittered and capped at a minute; Stream.retry resets it once the feed delivers again.
const reconnect = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.minutes(1))))
)
