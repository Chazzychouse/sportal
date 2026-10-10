import type { DisplayId } from "@sportal/api/DisplayId"
import type { DisplayOffline } from "@sportal/api/DisplayOffline"
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
    /** The addresses a Remote on the home network can reach the Hub's machine at. */
    readonly addresses: Effect.Effect<ReadonlyArray<string>, HttpClientError.HttpClientError>
    /** Tells the Hub this Display's report, for its Remotes. */
    readonly report: (
      id: DisplayId,
      report: Schema.Json
    ) => Effect.Effect<void, DisplayOffline | HttpClientError.HttpClientError>
    /** Sends one input to the Display `id`, from a Remote. */
    readonly send: (
      id: DisplayId,
      input: Schema.Json
    ) => Effect.Effect<void, DisplayOffline | HttpClientError.HttpClientError>
  }
>()("sportal/web/hub/HubClient") {
  static readonly layer: Layer.Layer<HubClient, never, HttpClient.HttpClient> = Layer.effect(
    HubClient,
    Effect.gen(function* () {
      const api = yield* HttpApiClient.make(SportalApi)

      const sendGuide = Effect.fn("HubClient.sendGuide")(function* (guide: string) {
        yield* answerRead(api.guide.read({ payload: { guide } }))
      })
      const addresses = answerRead(api.host.addresses())
      const report = Effect.fn("HubClient.report")(function* (id: DisplayId, json: Schema.Json) {
        yield* answerRead(api.displays.report({ params: { id }, payload: json }))
      })
      const send = Effect.fn("HubClient.send")(function* (id: DisplayId, input: Schema.Json) {
        yield* answerRead(api.displays.send({ params: { id }, payload: input }))
      })
      return HubClient.of({ sendGuide, addresses, report, send })
    })
  )

  /** A Hub client whose calls are `fakes`; each one not given does nothing, and `addresses` lists none. */
  static layerTest(fakes: Partial<HubClient["Service"]> = {}): Layer.Layer<HubClient> {
    return Layer.succeed(
      HubClient,
      HubClient.of({
        sendGuide: () => Effect.void,
        addresses: Effect.succeed([]),
        report: () => Effect.void,
        send: () => Effect.void,
        ...fakes
      })
    )
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
