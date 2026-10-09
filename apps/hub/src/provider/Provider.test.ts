import { assert, describe, it } from "@effect/vitest"
import { liveSnapshot } from "@sportal/domain/TestGame"
import { Effect, Fiber, Ref, Stream } from "effect"
import { Delivery, Provider, ProviderFeed } from "./Provider.ts"

describe("ProviderFeed#deliver", () => {
  it.effect("should return once the provider's reader has taken the frame", () =>
    Effect.gen(function* () {
      const taken = yield* reading
      const feed = yield* ProviderFeed
      const deliveries = [Delivery.Snapshot({ snapshot: liveSnapshot() })]

      yield* feed.deliver(deliveries)
      const all = yield* Ref.get(taken)

      assert.deepStrictEqual(all, [deliveries])
    }).pipe(Effect.provide(Provider.layerTest))
  )
})

describe("ProviderFeed#end", () => {
  it.effect("should end the provider's frames after those already delivered", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const feed = yield* ProviderFeed
      const deliveries = [Delivery.Snapshot({ snapshot: liveSnapshot() })]
      const all = yield* provider.deliveries.pipe(
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true })
      )

      yield* feed.deliver(deliveries)
      yield* feed.end
      const collected = yield* Fiber.join(all)

      assert.deepStrictEqual(collected, [deliveries])
    }).pipe(Effect.provide(Provider.layerTest))
  )
})

/** A reader of the provider, in a fiber of its own, keeping each frame it takes. */
const reading = Effect.gen(function* () {
  const provider = yield* Provider
  const taken = yield* Ref.make<ReadonlyArray<ReadonlyArray<Delivery>>>([])
  yield* provider.deliveries.pipe(
    Stream.runForEach((deliveries) => Ref.update(taken, (all) => [...all, deliveries])),
    Effect.forkScoped({ startImmediately: true })
  )
  return taken
})
