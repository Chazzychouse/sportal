import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, PubSub } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { dispatch, HubClient } from "./HubClient.ts"

describe("dispatch", () => {
  it.effect("should report a screen command the Hub refused, with its reason", () =>
    Effect.gen(function* () {
      const hub = yield* HubClient
      const failures = yield* PubSub.subscribe(hub.screenFailures)

      yield* dispatch({ _tag: "Clear", tile: 0 })
      const failure = yield* PubSub.take(failures)

      assert.isTrue(failure._tag === "ScreenRejection" && failure.reason === "empty-tile")
    }).pipe(
      Effect.scoped,
      Effect.provide(
        HubClient.layer.pipe(Layer.provide(answering(422, { _tag: "ScreenRejection", reason: "empty-tile" })))
      )
    )
  )

  it.effect(
    "should report a screen command that never reached the Hub where refused commands are reported",
    () =>
      Effect.gen(function* () {
        const hub = yield* HubClient
        const failures = yield* PubSub.subscribe(hub.screenFailures)

        const sent = yield* Effect.exit(dispatch({ _tag: "Unsolo" }))
        const failed = yield* PubSub.take(failures)

        assert.isTrue(sent._tag === "Success")
        assert.isTrue(failed._tag === "HttpClientError" && failed.reason._tag === "TransportError")
      }).pipe(Effect.scoped, Effect.provide(HubClient.layer.pipe(Layer.provide(unreachable))))
  )
})

const unreachable = Layer.succeed(
  HttpClient.HttpClient,
  onHub(
    HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection refused" })
        })
      )
    )
  )
)

function answering(status: number, body: unknown) {
  return Layer.succeed(
    HttpClient.HttpClient,
    onHub(
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
          )
        )
      )
    )
  )
}

/** The UI asks for paths on its own origin; a test has none, so it names one. */
function onHub(client: HttpClient.HttpClient) {
  return client.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://hub.test")))
}
