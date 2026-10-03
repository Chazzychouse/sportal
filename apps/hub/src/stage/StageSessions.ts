import type { GameId } from "@sportal/domain/Game"
import * as Stage from "@sportal/domain/Stage"
import { Context, Effect, Layer, Option, Result, type Stream, SubscriptionRef } from "effect"
import { Ingest } from "../ingest/Ingest.ts"
import { Source } from "../source/Source.ts"

export class StageSessions extends Context.Service<
  StageSessions,
  {
    readonly stage: Effect.Effect<Stage.Stage>
    readonly changes: Stream.Stream<Stage.Stage>
    dispatch(command: Stage.StageCommand): Effect.Effect<Stage.Stage, Stage.StageRejection>
  }
>()("sportal/hub/StageSessions") {
  static readonly layer = Layer.effect(
    StageSessions,
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const source = yield* Source
      const current = yield* SubscriptionRef.make(Stage.initial)

      const dispatch = Effect.fn("StageSessions.dispatch")(function* (command: Stage.StageCommand) {
        const slate = yield* ingest.slate
        const locate = (id: GameId) =>
          Option.fromNullishOr(slate.find((game) => game.id === id)).pipe(Option.flatMap(source.locate))
        // One atomic step: concurrent dispatches queue up, and a rejection leaves the Stage as it was.
        return yield* SubscriptionRef.modifyEffect(current, (stage) => {
          const result = Stage.apply(stage, command, locate)
          return Result.isFailure(result)
            ? Effect.fail(result.failure)
            : Effect.succeed([result.success, result.success] as const)
        })
      })

      return StageSessions.of({
        stage: SubscriptionRef.get(current),
        changes: SubscriptionRef.changes(current),
        dispatch
      })
    })
  )
}
