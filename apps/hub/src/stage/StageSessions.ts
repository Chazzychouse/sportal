import type { GameId } from "@sportal/domain/Game"
import { ChannelAvailability } from "@sportal/domain/Source"
import { Stage, type StageCommand, type StageRejection } from "@sportal/domain/Stage"
import { Context, Effect, Layer, Result, Stream, SubscriptionRef } from "effect"
import { Ingest } from "../ingest/Ingest.ts"
import { Source } from "../source/Source.ts"

export class StageSessions extends Context.Service<
  StageSessions,
  {
    readonly stage: Effect.Effect<Stage>
    readonly changes: Stream.Stream<Stage>
    dispatch(command: StageCommand): Effect.Effect<Stage, StageRejection>
  }
>()("sportal/hub/StageSessions") {
  static readonly layer = Layer.effect(
    StageSessions,
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const source = yield* Source
      const current = yield* SubscriptionRef.make(Stage.initial)

      const dispatch = Effect.fn("StageSessions.dispatch")(function* (command: StageCommand) {
        const availabilityOf = yield* availabilityOnSlate(ingest, source)
        // One atomic step: concurrent dispatches queue up, and a rejection leaves the Stage as it was.
        return yield* SubscriptionRef.modifyEffect(current, (stage) => {
          const result = stage.apply(command, availabilityOf)
          return Result.isFailure(result)
            ? Effect.fail(result.failure)
            : Effect.succeed([result.success, result.success] as const)
        })
      })

      // When the source learns or forgets a channel, every tile it affects changes on every Display.
      const refresh = Effect.gen(function* () {
        const availabilityOf = yield* availabilityOnSlate(ingest, source)
        yield* SubscriptionRef.update(current, (stage) => stage.refresh(availabilityOf))
      })
      yield* Effect.forkScoped(source.changes.pipe(Stream.runForEach(() => refresh)), {
        startImmediately: true
      })

      return StageSessions.of({
        stage: SubscriptionRef.get(current),
        changes: SubscriptionRef.changes(current),
        dispatch
      })
    })
  )
}

/** Where each game on the current slate can be streamed; a game no longer on the slate is not carried. */
function availabilityOnSlate(ingest: typeof Ingest.Service, source: typeof Source.Service) {
  return Effect.gen(function* () {
    const slate = yield* ingest.slate
    const lineup = yield* source.lineup
    return (id: GameId): ChannelAvailability => {
      const game = slate.find((candidate) => candidate.id === id)
      return game === undefined ? ChannelAvailability.NotCarried() : lineup.availabilityOf(game)
    }
  })
}
