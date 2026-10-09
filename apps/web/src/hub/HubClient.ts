import { SportalApi } from "@sportal/api/SportalApi"
import { Context, Effect, Layer, type Schema } from "effect"
import { HttpApiClient } from "effect/http-api"

/** This client's way to the Hub's HTTP API. */
export class HubClient extends Context.Service<HubClient, { api: HttpApiClient.ForApi<typeof SportalApi> }>()(
  "sportal/web/hub/HubClient"
) {
  static readonly layer = Layer.effect(
    HubClient,
    Effect.gen(function* () {
      const api = yield* HttpApiClient.make(SportalApi)

      return { api }
    })
  )
}

/** Passes a guide the shell read to the Hub. What it changes arrives on the live stream. */
export function sendGuide(guide: string) {
  return HubClient.use((hub) => answerRead(hub.api.guide.read({ payload: { guide } })))
}

/** An answer this UI cannot read means it and the Hub disagree on the API: a defect, logged where it happens. */
function answerRead<A, E, R>(request: Effect.Effect<A, E | Schema.SchemaError, R>) {
  return request.pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.logError("The Hub's answer did not decode", error).pipe(Effect.andThen(Effect.die(error)))
    )
  )
}
