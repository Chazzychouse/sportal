import { Effect, Layer, Scheduler } from "effect"
import { FetchHttpClient } from "effect/http"
import { Atom } from "effect/reactivity"
import { HubClient } from "./hub/HubClient.ts"
import { Shell } from "./shell/Shell.ts"

/**
 * The one runtime the web UI's effects run in: the Hub client and the Shell. Tests swap `runtime.layer`.
 */
export const runtime = Atom.runtime(
  Layer.mergeAll(HubClient.layer, Shell.layer).pipe(Layer.provide(FetchHttpClient.layer))
)

/** Runs a mounted atom's effect before the browser paints what changed. */
export function beforePaint<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  // The registry's scheduler is React's low-priority callback, which can run after paint; on microtasks the shell
  // moves or hides the videos before the browser paints the tiles that changed.
  return Effect.provideService(self, Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"))
}

/** Logs at error level when `what` dies, then lets it end as before. */
export function logDefect(what: string) {
  return <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.tapDefect(self, (defect) => Effect.logError(`${what} died`, defect))
}
