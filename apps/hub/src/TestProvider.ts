import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Layer } from "effect"
import { Provider, ProviderError } from "./provider/Provider.ts"

/** A live game `id` in `period`, at 10:00 on the clock. */
export function game(id: string, period = 1) {
  return snapshot({ id: GameId.make(id), status: "live", period, clock: "10:00" })
}

/**
 * A provider that answers each poll with the next scripted response, and the last one after that, inside a
 * `provider.slate` span. A `"fail"` response fails the poll.
 */
export function scripted(responses: ReadonlyArray<ReadonlyArray<GameSnapshot> | "fail">) {
  let call = 0
  return Layer.succeed(
    Provider,
    Provider.of({
      slate: (league) => {
        const response = responses[Math.min(call++, responses.length - 1)]
        return (
          response === "fail" || response === undefined
            ? Effect.fail(new ProviderError({ league, cause: "down" }))
            : Effect.succeed(response)
        ).pipe(Effect.withSpan("provider.slate"))
      }
    })
  )
}
