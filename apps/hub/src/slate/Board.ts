import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { Cause, Context, Effect, Layer, Metric, Stream, SubscriptionRef } from "effect"
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
   * Takes what the provider decodes, from an empty slate, gauging each game whose snapshot a take changed by its
   * progress. A take that raises a defect is logged, and the slate keeps what it had. If the provider's frames ever end other than by the Hub stopping, that is logged.
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
          yield* gaugeChanged(before, next)
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

/** Each game's progress gauge where `next` changed its snapshot from `before`; a game no longer listed gauges 0. */
const gaugeChanged = Effect.fnUntraced(function* (before: Slate, next: Slate) {
  if (next.games === before.games) return

  const ids = new Set<GameId>([...before.games.keys(), ...next.games.keys()])
  yield* Effect.forEach(
    ids,
    (id) => {
      const had = before.games.get(id)
      const has = next.games.get(id)
      if (has === had) return Effect.void
      const game = has ?? had
      if (game === undefined) return Effect.void

      const attributes = { game: game.id, league: game.league, matchup: game.matchup() }
      const value = has === undefined ? 0 : progressValues[has.progress()]
      return Metric.update(Metric.withAttributes(gameState, attributes), value)
    },
    { discard: true }
  )
})

// Each progress's value on `sportal_game_state`. Written as a record so that a new progress fails to compile here.
const progressValues = { upcoming: 1, live: 2, over: 3 } satisfies Record<
  ReturnType<GameSnapshot["progress"]>,
  number
>

const gameState = Metric.gauge("sportal_game_state", {
  description: "A game's progress, by game: 1 upcoming, 2 live, 3 over, 0 once no listing names it"
})
