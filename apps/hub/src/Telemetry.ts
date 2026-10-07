import { Crypto, Effect, Layer, Logger, Option, type PlatformError, References } from "effect"
import { HttpClient } from "effect/http"
import { Otlp } from "effect/observability"
import { HubConfig } from "./HubConfig.ts"

/**
 * The Hub's minimum log level and console format (Effect's console logger, or one JSON object per line), and,
 * when `SPORTAL_OTLP_URL` is set, its spans, logs, and metrics exported over OTLP under a `service.instance.id` of
 * its own.
 */
export const layer: Layer.Layer<
  never,
  PlatformError.PlatformError,
  HubConfig | HttpClient.HttpClient | Crypto.Crypto
> = Layer.unwrap(
  Effect.gen(function* () {
    const { logLevel, logFormat, otlpUrl, version, scenario } = yield* HubConfig
    const console = Layer.mergeAll(
      Layer.succeed(References.MinimumLogLevel, logLevel),
      logFormat === "json" ? Logger.layer([Logger.consoleJson]) : Layer.empty
    )
    if (Option.isNone(otlpUrl)) return console

    // The exporter itself reports a failed export only at Debug, so a collector that is down would go unnoticed.
    const warnOnce = yield* Effect.cached(
      Effect.logWarning(`Telemetry cannot reach the collector at ${otlpUrl.value.href}`)
    )
    const httpClient = yield* HttpClient.HttpClient
    const client = HttpClient.tapError(httpClient, () => warnOnce)
    const crypto = yield* Crypto.Crypto
    // Prometheus keys series by instance, so two Hubs at once (a live one and a scenario) stay apart.
    const instanceId = yield* crypto.randomUUIDv4
    return Otlp.layerJson({
      baseUrl: otlpUrl.value.href,
      resource: {
        serviceName: "sportal-hub",
        serviceVersion: version,
        attributes: {
          "service.instance.id": instanceId,
          "sportal.mode": Option.match(scenario, {
            onNone: () => "live",
            onSome: (name) => `scenario:${name}`
          })
        }
      },
      shutdownTimeout: "1 second"
    }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)), Layer.provideMerge(console))
  })
)
