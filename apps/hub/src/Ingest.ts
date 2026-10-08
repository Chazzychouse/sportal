import { Effect, Layer, Stream } from "effect"
import { FeedLog } from "./feed-log/FeedLog.ts"
import * as HubStopping from "./HubStopping.ts"
import { Provider } from "./provider/Provider.ts"

/**
 * Appends every frame the provider delivers to the feed log, for as long as the Hub runs. The provider runs itself, so
 * nothing else flows: the slate takes what the log has. If its frames ever stop other than by the Hub stopping, that is
 * logged.
 */
export const layer: Layer.Layer<never, never, Provider | FeedLog> = Layer.effectDiscard(
  Effect.gen(function* () {
    const provider = yield* Provider
    const feedLog = yield* FeedLog

    yield* Effect.forkScoped(
      provider.frames.pipe(
        Stream.runForEach(feedLog.append),
        HubStopping.loggedUnlessStopping(
          "Ingest: the provider's frames stopped; nothing reaches the slate until the Hub restarts",
          "the provider's frames ended"
        )
      )
    )
  })
)
