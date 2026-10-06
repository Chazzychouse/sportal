import { Effect, Fiber, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { useSyncExternalStore } from "react"
import { HubClient } from "./HubClient.ts"
import { LiveStream } from "./LiveStream.ts"

/** The one runtime the web UI runs the Hub client and the live stream in; React handlers run their effects here. */
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(HubClient.layer.pipe(Layer.provide(FetchHttpClient.layer)), LiveStream.layer)
)

/** Everything the Hub has told this client, and whether the live stream is up, kept current. */
export function useLive() {
  return useSyncExternalStore(subscribe, () => runtime.runSync(LiveStream.use(SubscriptionRef.get)))
}

function subscribe(listener: () => void) {
  const fiber = runtime.runFork(
    LiveStream.use((live) =>
      SubscriptionRef.changes(live).pipe(Stream.runForEach(() => Effect.sync(listener)))
    )
  )
  return () => {
    runtime.runFork(Fiber.interrupt(fiber))
  }
}
