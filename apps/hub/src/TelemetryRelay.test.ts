import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/http"
import { HubConfig } from "./HubConfig.ts"
import * as TelemetryRelay from "./TelemetryRelay.ts"

describe("TelemetryRelay", () => {
  it.effect("should forward a Display's logs to the collector's logs endpoint", () =>
    relayed("collector", (sent) =>
      Effect.gen(function* () {
        yield* post('{"resourceLogs":[]}')

        const requests = yield* Ref.get(sent)
        assert.strictEqual(requests.length, 1)
        const request = requests[0] as HttpClientRequest.HttpClientRequest
        assert.strictEqual(request.method, "POST")
        assert.strictEqual(request.url, "http://collector.test:4318/v1/logs")
        assert.strictEqual(request.headers["content-type"], "application/json")
        assert.strictEqual(bodyText(request), '{"resourceLogs":[]}')
      })
    )
  )

  it.effect("should answer 204 once the collector took them", () =>
    relayed("collector", () =>
      Effect.gen(function* () {
        const response = yield* post("{}")

        assert.strictEqual(response.status, 204)
      })
    )
  )

  it.effect("should answer 502 when the collector cannot be reached", () =>
    relayed("unreachable", () =>
      Effect.gen(function* () {
        const response = yield* post("{}")

        assert.strictEqual(response.status, 502)
      })
    )
  )
})

const post = (body: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((http) =>
      http.execute(
        HttpClientRequest.post("/api/telemetry/logs").pipe(
          HttpClientRequest.bodyText(body, "application/json")
        )
      )
    )
  )

const bodyText = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""

function relayed<A, E, R>(
  collector: "collector" | "unreachable",
  test: (sent: Ref.Ref<ReadonlyArray<HttpClientRequest.HttpClientRequest>>) => Effect.Effect<A, E, R>
) {
  return Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([])
    const fake = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        collector === "unreachable"
          ? Effect.fail(
              new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) })
            )
          : Ref.update(sent, (all) => [...all, request]).pipe(
              Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
            )
      )
    )
    const config = HubConfig.layerTest({ SPORTAL_OTLP_URL: "http://collector.test:4318" })
    const relay = HttpRouter.serve(TelemetryRelay.layer).pipe(
      Layer.provide(fake),
      Layer.provide(config),
      Layer.provideMerge(NodeHttpServer.layerTest)
    )

    return yield* test(sent).pipe(Effect.scoped, Effect.provide(relay))
  })
}
