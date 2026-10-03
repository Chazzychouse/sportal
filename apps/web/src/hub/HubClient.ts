import { SportalApi } from "@sportal/api/SportalApi"
import type { Network } from "@sportal/domain/Game"
import type { StageCommand } from "@sportal/domain/Stage"
import { Cause, Context, Effect, Layer, ManagedRuntime, Option, Predicate } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"

class HubClient extends Context.Service<HubClient, HttpApiClient.ForApi<typeof SportalApi>>()(
  "sportal/web/HubClient"
) {
  static readonly layer = Layer.effect(HubClient, HttpApiClient.make(SportalApi)).pipe(
    Layer.provide(FetchHttpClient.layer)
  )
}

const runtime = ManagedRuntime.make(HubClient.layer)

/** Sends a stage command. The resulting stage arrives on the live stream, not from this call. */
export function dispatch(command: StageCommand): void {
  runtime.runFork(HubClient.use((hub) => hub.stage.dispatch({ payload: { command } })))
}

/**
 * Tells the Hub the channel the user picked for `network`. Like the other channel commands, it resolves to
 * the message to show the user if the Hub did not take it; the Stage change arrives on the live stream.
 */
export function learnChannel(network: Network, url: string): Promise<Option.Option<string>> {
  return outcome(HubClient.use((hub) => hub.channels.learn({ payload: { network, url } })))
}

export function markNotCarried(network: Network): Promise<Option.Option<string>> {
  return outcome(HubClient.use((hub) => hub.channels.notCarried({ payload: { network } })))
}

export function forgetChannel(network: Network): Promise<Option.Option<string>> {
  return outcome(HubClient.use((hub) => hub.channels.forget({ payload: { network } })))
}

function outcome(command: Effect.Effect<void, unknown, HubClient>) {
  return runtime.runPromise(
    command.pipe(
      Effect.catchCause((cause) => {
        // Extract error or defect from cause
        let error: unknown
        for (const reason of cause.reasons) {
          if (Cause.isFailReason(reason)) {
            error = reason.error
            break
          } else if (Cause.isDieReason(reason)) {
            error = reason.defect
            break
          }
        }

        const message = Predicate.isTagged(error, "ChannelUrlRefused")
          ? "That is not a live channel. Pick one from the live guide."
          : "The Hub did not take that. Try again."
        return Effect.succeed(Option.some(message))
      }),
      Effect.map(() => Option.none())
    )
  )
}
