import { Effect, Layer, Option } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  type HttpServerRequest,
  HttpServerResponse
} from "effect/http"
import { HubConfig } from "./HubConfig.ts"

/**
 * Relays a Display's OTLP logs, posted to `/api/telemetry/logs`, to the collector the Hub reports to; with no
 * collector, takes them and drops them. A failed relay warns once.
 */
export const layer: Layer.Layer<never, never, HubConfig | HttpClient.HttpClient | HttpRouter.HttpRouter> =
  Layer.unwrap(
    Effect.gen(function* () {
      const { otlpUrl } = yield* HubConfig
      const client = yield* HttpClient.HttpClient
      const warnOnce = yield* Effect.cached(
        Effect.logWarning("The Hub cannot relay a Display's logs to the collector")
      )

      const relay = (url: URL, request: HttpServerRequest.HttpServerRequest) =>
        request.arrayBuffer.pipe(
          Effect.flatMap((body) => {
            const contentType = request.headers["content-type"] ?? "application/json"
            const endpoint = `${url.href.replace(/\/$/, "")}/v1/logs`
            return client.execute(
              HttpClientRequest.post(endpoint).pipe(
                HttpClientRequest.bodyUint8Array(new Uint8Array(body), contentType)
              )
            )
          }),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.as(HttpServerResponse.empty({ status: 204 })),
          Effect.catch(() => warnOnce.pipe(Effect.as(HttpServerResponse.empty({ status: 502 }))))
        )

      return HttpRouter.add("POST", "/api/telemetry/logs", (request) =>
        Option.match(otlpUrl, {
          onNone: () => Effect.succeed(HttpServerResponse.empty({ status: 204 })),
          onSome: (url) => relay(url, request)
        })
      )
    })
  )
