import { Context, Deferred, Effect, Layer, Option, Queue, Ref, Stream } from "effect"
import { Provider } from "./provider/Provider.ts"
import type { Delivery } from "./slate/Delivery.ts"

/**
 * The snapshot feed, which tests drive: a provider whose frames say what a test delivers. `deliver` returns once the
 * provider's reader has taken the frame and asked for the next, so a Board has taken it.
 */
export class SnapshotFeed extends Context.Service<
  SnapshotFeed,
  {
    /** One frame saying `deliveries`. */
    deliver(deliveries: ReadonlyArray<Delivery>): Effect.Effect<void>
  }
>()("sportal/hub/SnapshotFeed") {
  /** The snapshot feed, and it as the provider. */
  static readonly layer: Layer.Layer<SnapshotFeed | Provider> = Layer.effectContext(
    Effect.gen(function* () {
      const frames = yield* Queue.unbounded<{
        readonly deliveries: ReadonlyArray<Delivery>
        readonly taken: Deferred.Deferred<void>
      }>()
      const reading = yield* Ref.make(Option.none<Deferred.Deferred<void>>())

      // Each pull first marks the frame before it taken: the reader asks for the next only once it has taken that one.
      const next = Effect.gen(function* () {
        const previous = yield* Ref.get(reading)
        yield* Effect.forEach(Option.toArray(previous), (taken) => Deferred.succeed(taken, undefined))
        const frame = yield* Queue.take(frames)
        yield* Ref.set(reading, Option.some(frame.taken))
        return frame.deliveries
      })

      const deliver = Effect.fnUntraced(function* (deliveries: ReadonlyArray<Delivery>) {
        const taken = yield* Deferred.make<void>()
        yield* Queue.offer(frames, { deliveries, taken })
        yield* Deferred.await(taken)
      })

      return Context.make(SnapshotFeed, SnapshotFeed.of({ deliver })).pipe(
        Context.add(Provider, Provider.of({ deliveries: Stream.fromEffectRepeat(next) }))
      )
    })
  )
}
