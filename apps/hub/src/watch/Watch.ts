import type { GameSnapshot } from "@sportal/domain/Game"
import { Watchability } from "@sportal/domain/Watchability"
import { Context, DateTime, Effect, Layer, Stream, SubscriptionRef } from "effect"
import { Ingest } from "../ingest/Ingest.ts"

/**
 * Every game's watchability, folded forward on each slate Ingest publishes, on Ingest's clock: real time on a game
 * day, scenario time in a scenario. The Director reads it; the live stream carries it.
 */
export class Watch extends Context.Service<
  Watch,
  {
    readonly latest: Effect.Effect<{
      readonly slate: ReadonlyArray<GameSnapshot>
      readonly watchability: ReadonlyArray<Watchability>
    }>
    /** The current slate and watchability first, then each new one. */
    readonly changes: Stream.Stream<{
      readonly slate: ReadonlyArray<GameSnapshot>
      readonly watchability: ReadonlyArray<Watchability>
    }>
  }
>()("sportal/hub/Watch") {
  static readonly layer = Layer.effect(
    Watch,
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const state = yield* SubscriptionRef.make<{
        readonly slate: ReadonlyArray<GameSnapshot>
        readonly watchability: ReadonlyArray<Watchability>
      }>({ slate: [], watchability: [] })
      yield* Effect.forkScoped(
        ingest.changes.pipe(
          Stream.runForEach((slate) =>
            DateTime.now.pipe(
              Effect.flatMap((now) =>
                SubscriptionRef.update(state, (current) => ({
                  slate,
                  watchability: Watchability.fold(current, slate, now)
                }))
              )
            )
          )
        ),
        { startImmediately: true }
      )
      return Watch.of({ latest: SubscriptionRef.get(state), changes: SubscriptionRef.changes(state) })
    })
  )
}
