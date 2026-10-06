import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Stream } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { dispatch, HubClient, stageFailures } from "./HubClient.ts"

describe("dispatch", () => {
  it.effect("reports a stage command the Hub refused, with its reason", () =>
    Effect.gen(function* () {
      const reported = yield* Stream.runHead(stageFailures).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* dispatch({ _tag: "Clear", tile: 0 })
      const failure = Option.getOrThrow(yield* Fiber.join(reported))
      assert.isTrue(failure._tag === "StageRejection" && failure.reason === "empty-tile")
    }).pipe(
      Effect.provide(
        HubClient.layer.pipe(Layer.provide(answering(422, { _tag: "StageRejection", reason: "empty-tile" })))
      )
    )
  )

  it.effect("reports a stage command that never reached the Hub where refused commands are reported", () =>
    Effect.gen(function* () {
      const reported = yield* Stream.runHead(stageFailures).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const sent = yield* Effect.exit(dispatch({ _tag: "Unsolo" }))
      assert.isTrue(sent._tag === "Success")
      const failure = yield* Fiber.join(reported)
      assert.isTrue(Option.isSome(failure))
      const failed = Option.getOrThrow(failure)
      assert.isTrue(failed._tag === "HttpClientError" && failed.reason._tag === "TransportError")
    }).pipe(Effect.provide(HubClient.layer.pipe(Layer.provide(unreachable))))
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
