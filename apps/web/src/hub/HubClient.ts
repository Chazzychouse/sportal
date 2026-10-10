import type { GuideUnreadable } from "@sportal/api/GuideUnreadable"
import { SportalApi } from "@sportal/api/SportalApi"
import { Context, Effect, Layer, type Schema } from "effect"
import type { HttpClient, HttpClientError } from "effect/http"
import { HttpApiClient } from "effect/http-api"

/** This client's way to the Hub's HTTP API. */
export class HubClient extends Context.Service<
  HubClient,
  {
    /** Passes a guide the shell read to the Hub. What it changes arrives on the live stream. */
    readonly sendGuide: (
      guide: string
    ) => Effect.Effect<void, GuideUnreadable | HttpClientError.HttpClientError>
  }
>()("sportal/web/hub/HubClient") {
  static readonly layer: Layer.Layer<HubClient, never, HttpClient.HttpClient> = Layer.effect(
    HubClient,
    Effect.gen(function* () {
      const api = yield* HttpApiClient.make(SportalApi)

      const sendGuide = Effect.fn("HubClient.sendGuide")(function* (guide: string) {
        yield* answerRead(api.guide.read({ payload: { guide } }))
      })
      return HubClient.of({ sendGuide })
    })
  )

  /** A Hub client that hands each guide to `sendGuide`. */
  static layerTest(sendGuide: (guide: string) => Effect.Effect<void>): Layer.Layer<HubClient> {
    return Layer.succeed(HubClient, HubClient.of({ sendGuide }))
  }
}

/** An answer this UI cannot read means it and the Hub disagree on the API: a defect, logged where it happens. */
function answerRead<A, E, R>(request: Effect.Effect<A, E | Schema.SchemaError, R>) {
  return request.pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.logError("The Hub's answer did not decode", error).pipe(Effect.andThen(Effect.die(error)))
    )
  )
}
