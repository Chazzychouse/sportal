import { SportalApi } from "@sportal/api/SportalApi"
import type { StageCommand, StageRejection } from "@sportal/domain/Stage"
import { Context, Effect, Layer, PubSub, type Schema, Stream } from "effect"
import type { HttpClientError } from "effect/http"
import { HttpApiClient } from "effect/http-api"

/**
 * This client's way to the Hub's HTTP API, and the stage commands that failed — refused by the Hub or never
 * reaching it — to whoever is listening.
 */
export class HubClient extends Context.Service<
  HubClient,
  {
    api: HttpApiClient.ForApi<typeof SportalApi>
    stageFailures: PubSub.PubSub<StageRejection | HttpClientError.HttpClientError>
  }
>()("sportal/web/HubClient") {
  static readonly layer = Layer.effect(
    HubClient,
    Effect.gen(function* () {
      const api = yield* HttpApiClient.make(SportalApi)
      const stageFailures = yield* PubSub.unbounded<StageRejection | HttpClientError.HttpClientError>()

      return { api, stageFailures }
    })
  )
}

/**
 * Sends a stage command. The resulting stage arrives on the live stream, not from this call; a command the Hub
 * refuses, or one that never reaches it, arrives on `stageFailures`.
 */
export function dispatch(command: StageCommand) {
  return HubClient.use((hub) =>
    answerRead(hub.api.stage.dispatch({ payload: { command } })).pipe(
      Effect.catch((failure) => PubSub.publish(hub.stageFailures, failure)),
      Effect.asVoid
    )
  )
}

/** Each stage command that failed, from when the stream starts. */
export const stageFailures = Stream.unwrap(
  Effect.gen(function* () {
    const hub = yield* HubClient

    return Stream.fromPubSub(hub.stageFailures)
  })
)

/** Passes a guide the shell read to the Hub. The tiles it changes arrive on the live stream. */
export function sendGuide(guide: string) {
  return HubClient.use((hub) => answerRead(hub.api.guide.read({ payload: { guide } })))
}

/**
 * The addresses a Remote on the home network can reach the Hub's machine at. It fails when the Hub could not be
 * asked — not running, or older than this UI.
 */
export const hostAddresses = HubClient.use((hub) => answerRead(hub.api.host.addresses()))

/** An answer this UI cannot read means it and the Hub disagree on the API: a defect, logged where it happens. */
function answerRead<A, E, R>(request: Effect.Effect<A, E | Schema.SchemaError, R>) {
  return request.pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.logError("The Hub's answer did not decode", error).pipe(Effect.andThen(Effect.die(error)))
    )
  )
}
