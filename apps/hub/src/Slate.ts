import type { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import type { Watchability } from "@sportal/domain/Watchability"
import { Context, DateTime, Effect, Layer, Stream, SubscriptionRef } from "effect"
import { LiveGames } from "./LiveGames.ts"

/**
 * The current slate: each listed game with its watchability, leagues in order, as the fold has it, published
 * on every burst of changes to the fold. A game the fold does not hold (one not yet current, or over) is judged
 * fresh. A burst settles after 250 ms with no further change, on the layer's clock; changes arriving more often than
 * that, without a pause, publish nothing until they pause.
 */
export class Slate extends Context.Service<
  Slate,
  {
    readonly latest: Effect.Effect<
      ReadonlyArray<{ readonly game: GameSnapshot; readonly watchability: Watchability }>
    >
    /** The latest first, then each new one. */
    readonly changes: Stream.Stream<Listed>
  }
>()("sportal/hub/Slate") {
  static readonly layer: Layer.Layer<Slate, never, LiveGames> = Layer.effect(
    Slate,
    Effect.gen(function* () {
      const liveGames = yield* LiveGames
      const state = yield* SubscriptionRef.make<Listed>([])
      yield* Effect.forkScoped(
        liveGames.changes.pipe(
          Stream.debounce("250 millis"),
          Stream.runForEach((folded) =>
            Effect.flatMap(DateTime.now, (now) =>
              SubscriptionRef.set(
                state,
                folded
                  .slate(LeagueId.literals)
                  .map((game) => ({ game, watchability: folded.watchabilityOf(game, now) }))
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

type Listed = ReadonlyArray<{ readonly game: GameSnapshot; readonly watchability: Watchability }>
