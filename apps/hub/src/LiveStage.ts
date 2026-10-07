import { ChannelAvailability } from "@sportal/domain/Channel"
import type { GameId } from "@sportal/domain/Game"
import { Stage, type StageCommand, type StageRejection } from "@sportal/domain/Stage"
import { Context, Effect, Layer, Option, Stream, SubscriptionRef } from "effect"
import { LiveSlate } from "./LiveSlate.ts"
import { Source } from "./source/Source.ts"

export class LiveStage extends Context.Service<
  LiveStage,
  {
    readonly stage: Effect.Effect<Stage>
    readonly changes: Stream.Stream<Stage>
    dispatch(command: StageCommand): Effect.Effect<Stage, StageRejection>
  }
>()("sportal/hub/LiveStage") {
  static readonly layer = Layer.effect(
    LiveStage,
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      const source = yield* Source
      const current = yield* SubscriptionRef.make(Stage.initial)
      // Where each game on the current slate can be streamed; a game no longer on the slate has none.
      const availabilityOnSlate = Effect.gen(function* () {
        const { games } = yield* slate.published
        const availabilityOf = yield* source.availability
        return (id: GameId): Option.Option<ChannelAvailability> =>
          Option.fromNullishOr(games.find((game) => game.id === id)).pipe(Option.map(availabilityOf))
      })

      const dispatch = Effect.fn("LiveStage.dispatch")(function* (command: StageCommand) {
        // One atomic step: concurrent dispatches queue up, and a rejection leaves the Stage as it was.
        // Availability is read inside it, so a refresh that lands first is never overwritten with a stale read.
        return yield* SubscriptionRef.modifyEffect(current, (stage) =>
          Effect.gen(function* () {
            const availabilityOf = yield* availabilityOnSlate
            const result = stage.apply(command, (id) =>
              Option.getOrElse(availabilityOf(id), () => ChannelAvailability.NotCarried({ why: "NoStream" }))
            )
            const next = yield* Effect.fromResult(result)
            return [next, next] as const
          })
        )
      })

      // When what the source answers changes, every tile it affects changes on every Display.
      const refresh = SubscriptionRef.updateEffect(current, (stage) =>
        availabilityOnSlate.pipe(Effect.map((availabilityOf) => stage.refresh(availabilityOf)))
      )
      yield* Effect.forkScoped(source.changes.pipe(Stream.runForEach(() => refresh)), {
        startImmediately: true
      })

      return LiveStage.of({
        stage: SubscriptionRef.get(current),
        changes: SubscriptionRef.changes(current),
        dispatch
      })
    })
  )
}
