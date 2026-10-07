import type { Slate } from "@sportal/domain/Slate"
import {
  Array as Arr,
  DateTime,
  Effect,
  Equivalence,
  Layer,
  Metric,
  Option,
  Result,
  Sink,
  Stream
} from "effect"
import { FeedLog } from "./feed-log/FeedLog.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubStopping from "./HubStopping.ts"
import { LiveSlate } from "./LiveSlate.ts"
import { LiveFeedDemand, Provider } from "./provider/Provider.ts"

/**
 * Polls each league on the provider's polling Schedule and runs its push on the live feed's demand, subscribed to again
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
        provider.push(Stream.unwrap(demandOf(slate))).pipe(
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
          HubStopping.loggedUnlessStopping(
            "Ingest: the live feed stopped; only the poll reaches the slate until the Hub restarts",
            "the feed's stream ended"
          )
        )
      )
    })
  )

/**
 * What the live feed should follow, afresh on each run: the current games first, then each change of which games they
 * are, and each channel a frame the slate took live asked to resync.
 */
const demandOf = Effect.fnUntraced(function* (slate: LiveSlate["Service"]) {
  // Subscribed to the resyncs before the first games are peeled off, so the games come first and every resync after
  // them is in the demand.
  const resyncs = yield* Stream.toPull(slate.resyncs)
  const [first, rest] = yield* Stream.peel(currentGames(slate.changes), Sink.head())
  const resynced = Stream.fromPull(Effect.succeed(resyncs)).pipe(
    Stream.map((channel) => LiveFeedDemand.Resync({ channel }))
  )
  return Stream.fromIterable(Option.toArray(first)).pipe(Stream.concat(Stream.merge(rest, resynced)))
})

/** The current games of each of `changes`, again on each change of which games they are. */
function currentGames(changes: Stream.Stream<Slate>): Stream.Stream<LiveFeedDemand> {
  return changes.pipe(
    Stream.mapEffect((slate) =>
      Effect.map(DateTime.now, (now) =>
        [...slate.live.values()]
          .filter((liveGame) => liveGame.isCurrent(now))
          .map((liveGame) => liveGame.snapshot)
      )
    ),
    Stream.changesWith((self, that) =>
      sameIds(
        self.map((game) => game.id),
        that.map((game) => game.id)
      )
    ),
    Stream.map((games) => LiveFeedDemand.Games({ games }))
  )
}

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
