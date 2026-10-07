import { Array as Arr, Effect, Layer, Metric, Option, Result, Stream } from "effect"
import { FeedLog } from "./FeedLog.ts"
import { HubConfig } from "./HubConfig.ts"
import { loggedUnlessStopping } from "./HubStopping.ts"
import { LiveSlate } from "./LiveSlate.ts"
import { Provider } from "./provider/Provider.ts"

/**
 * Polls each league on the provider's polling Schedule and runs its push on the slate's demand, subscribed to again
 * on its reconnect Schedule, appending every frame to the feed log; the slate takes what it appends.
 */
export const layer: Layer.Layer<never, never, HubConfig | Provider | FeedLog | LiveSlate> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { leagues } = yield* HubConfig
      const provider = yield* Provider
      const feedLog = yield* FeedLog
      const slate = yield* LiveSlate

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

      // The Schedule is given the slate's games once it has taken the poll's listings, and the leagues that failed.
      const polled = Effect.gen(function* () {
        const { failed, last } = yield* poll()
        const taken = yield* Option.match(last, {
          onNone: () => slate.latest,
          onSome: slate.through
        })
        return { slate: taken.games(leagues), failed }
      })
      yield* Effect.forkScoped(Effect.repeat(polled, provider.polling))

      yield* Effect.forkScoped(
        provider.push(slate.demand).pipe(
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
          Stream.retry(provider.reconnect),
          Stream.runForEach(feedLog.append),
          // The feed ends by completing, by a defect, or by a failure once `reconnect` is done, and nothing pushes again.
          loggedUnlessStopping(
            "Ingest: the live feed stopped; only the poll reaches the slate until the Hub restarts",
            "the feed's stream ended"
          )
        )
      )
    })
  )

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
