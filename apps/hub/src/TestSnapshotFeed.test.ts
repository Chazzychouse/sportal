import { assert, describe, it } from "@effect/vitest"
import { liveSnapshot } from "@sportal/domain/TestGame"
import { Effect, Ref, Stream } from "effect"
import { Provider } from "./provider/Provider.ts"
import { Delivery } from "./slate/Delivery.ts"
import { SnapshotFeed } from "./TestSnapshotFeed.ts"

describe("SnapshotFeed#deliver", () => {
  it.effect("should return once the provider's reader has taken the frame", () =>
    Effect.gen(function* () {
      const taken = yield* reading
      const feed = yield* SnapshotFeed
      const deliveries = [Delivery.cases.Snapshot.make({ snapshot: liveSnapshot() })]

      yield* feed.deliver(deliveries)
      const all = yield* Ref.get(taken)

      assert.deepStrictEqual(all, [deliveries])
    }).pipe(Effect.provide(SnapshotFeed.layer))
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
