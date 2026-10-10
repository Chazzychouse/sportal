import { Effect, Layer, Option, Stream } from "effect"
import { Director } from "./Director.ts"
import { type Delivery, Provider } from "./provider/Provider.ts"
import { ProviderFeed } from "./provider/ProviderFeed.ts"

/** The Director taking a fed provider, whose feed is provided too, for a test to deliver to. */
export const directorOver: Layer.Layer<Director | ProviderFeed> = Director.layer.pipe(
  Layer.provideMerge(Provider.layerTest)
)

/** The Director's slate as it is now. */
export const latest = Director.use((director) => Stream.runHead(director.slate)).pipe(
  Effect.map(Option.getOrThrow)
)

/** Delivers one frame that says only `delivery`, and gives the Director's slate once it has taken it. */
export const delivered = Effect.fnUntraced(function* (delivery: Delivery) {
  const feed = yield* ProviderFeed

  yield* feed.deliver([delivery])
  return yield* latest
})
