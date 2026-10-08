import { Effect, Layer } from "effect"
import { Director } from "./Director.ts"
import { Provider, ProviderFeed } from "./provider/Provider.ts"
import type { Delivery } from "./slate/Delivery.ts"
import type { Source } from "./source/Source.ts"

/** The Director taking a fed provider, whose feed is provided too, for a test to deliver to; the test gives the source. */
export const directorOver: Layer.Layer<Director | ProviderFeed, never, Source> = Director.layer.pipe(
  Layer.provideMerge(Provider.layerTestFed)
)

/** Delivers one frame that says only `delivery`, and gives the Director's slate once it has taken it. */
export const delivered = Effect.fnUntraced(function* (delivery: Delivery) {
  const feed = yield* ProviderFeed
  const director = yield* Director

  yield* feed.deliver([delivery])
  return yield* director.slate
})
