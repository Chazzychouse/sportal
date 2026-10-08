import { Cause, Context, Effect, Layer, Stream, SubscriptionRef } from "effect"
import * as HubStopping from "../HubStopping.ts"
import { Provider } from "../provider/Provider.ts"
import type { Delivery } from "./Delivery.ts"
import { Slate } from "./Slate.ts"

/** The one holder of the day's slate: it takes each frame its provider decodes, as it arrives. */
export class Board extends Context.Service<
  Board,
  {
    readonly latest: Effect.Effect<Slate>
    /** The latest first, then each change. */
    readonly changes: Stream.Stream<Slate>
  }
>()("sportal/hub/slate/Board") {
  /**
   * Takes what the provider decodes, from an empty slate. A take that raises a defect is logged, and the slate keeps
   * what it had. If the provider's frames ever end other than by the Hub stopping, that is logged.
   */
  static readonly layer: Layer.Layer<Board, never, Provider> = Layer.effect(
    Board,
    Effect.gen(function* () {
      const provider = yield* Provider
      const slate = yield* SubscriptionRef.make(Slate.empty)

      const take = Effect.fn("Board.take")(
        function* (deliveries: ReadonlyArray<Delivery>) {
          yield* Effect.annotateCurrentSpan({ "sportal.deliveries": deliveries.length })
          const before = yield* SubscriptionRef.get(slate)
          const next = before.take(deliveries)
          if (next === before) return

          yield* SubscriptionRef.set(slate, next)
        },
        Effect.catchDefect((defect) =>
          Effect.logError("Board: a take raised a defect; the slate keeps what it had", Cause.die(defect))
        )
      )

      yield* Effect.forkScoped(
        provider.deliveries.pipe(
          Stream.runForEach(take),
          HubStopping.loggedUnlessStopping(
            "Board: the provider's frames stopped; the slate stays as it is until the Hub restarts",
            "the provider's frames ended"
          )
        ),
        { startImmediately: true }
      )

      return Board.of({ latest: SubscriptionRef.get(slate), changes: SubscriptionRef.changes(slate) })
    })
  )

  /** A still board of `slate`: no take, no change after it. */
  static layerTest(slate: Slate): Layer.Layer<Board> {
    return Layer.succeed(Board, Board.of({ latest: Effect.succeed(slate), changes: Stream.make(slate) }))
  }
}
