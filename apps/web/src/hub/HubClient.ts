import { SportalApi } from "@sportal/api/SportalApi"
import type { Network } from "@sportal/domain/Game"
import type { StageCommand, StageRejection } from "@sportal/domain/Stage"
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

/**
 * Sends a stage command. The resulting stage arrives on the live stream, not from this call; a command the Hub
 * refuses reaches every `onStageRejected` listener.
 */
export function dispatch(command: StageCommand): void {
  runtime.runFork(
    HubClient.use((hub) => hub.stage.dispatch({ payload: { command } })).pipe(
      Effect.catchTag("StageRejection", (rejection) =>
        Effect.sync(() => {
          for (const listener of rejectionListeners) listener(rejection.reason)
        })
      )
    )
  )
}

/** Calls `listener` with the reason for each stage command the Hub refuses. Returns a function that stops the calls. */
export function onStageRejected(listener: (reason: StageRejection["reason"]) => void): () => void {
  rejectionListeners.add(listener)
  return () => {
    rejectionListeners.delete(listener)
  }
}

const rejectionListeners = new Set<(reason: StageRejection["reason"]) => void>()

/** Passes a guide the shell read to the Hub. The tiles it changes arrive on the live stream. */
export function sendGuide(guide: string): void {
  runtime.runFork(HubClient.use((hub) => hub.guide.read({ payload: { guide } })))
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
      // Any failure, expected or not, becomes a notice on the tile; only a refused channel gets its own words.
      Effect.matchCause({
        onSuccess: () => Option.none(),
        onFailure: (cause) =>
          Option.some(
            Option.exists(Cause.findErrorOption(cause), (error) =>
              Predicate.isTagged(error, "ChannelUrlRefused")
            )
              ? "That is not a live channel. Pick one from the live guide."
              : "The Hub did not take that. Try again."
          )
      })
    )
  )
}
