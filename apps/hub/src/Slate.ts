import type { GameSnapshot } from "@sportal/domain/Game"
import { Watchability } from "@sportal/domain/Watchability"
import { Context, DateTime, Effect, Layer, Option, Stream, SubscriptionRef } from "effect"
import { GameActors } from "./GameActors.ts"
import { Ingest } from "./ingest/Ingest.ts"

/**
 * The current slate and every game's watchability: each listed game as its actor has it, published on every listing
 * and every burst of actor changes. A burst settles after 250 ms with no new listing or actor change, on the layer's
 * clock; changes arriving more often than that, without a pause, publish nothing until they pause.
 */
export class Slate extends Context.Service<
  Slate,
  {
    readonly latest: Effect.Effect<{
      readonly slate: ReadonlyArray<GameSnapshot>
      readonly watchability: ReadonlyArray<Watchability>
    }>
    /** The latest first, then each new one. */
    readonly changes: Stream.Stream<{
      readonly slate: ReadonlyArray<GameSnapshot>
      readonly watchability: ReadonlyArray<Watchability>
    }>
  }
>()("sportal/hub/Slate") {
  static readonly layer = Layer.effect(
    Slate,
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const gameActors = yield* GameActors
      const state = yield* SubscriptionRef.make<{
        readonly slate: ReadonlyArray<GameSnapshot>
        readonly watchability: ReadonlyArray<Watchability>
      }>({ slate: [], watchability: [] })
      yield* Effect.forkScoped(
        Stream.zipLatestWith(ingest.listed, gameActors.changes, (listed, live) =>
          listed.map((game) =>
            Option.fromNullishOr(live.get(game.id)).pipe(
              Option.match({ onNone: () => game, onSome: (liveGame) => liveGame.snapshot })
            )
          )
        ).pipe(
          Stream.debounce("250 millis"),
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
      return Slate.of({ latest: SubscriptionRef.get(state), changes: SubscriptionRef.changes(state) })
    })
  )
}
