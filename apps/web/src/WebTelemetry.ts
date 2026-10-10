import { Layer } from "effect"
import { OtlpLogger, OtlpSerialization } from "effect/observability"

/** This page's logs, shipped over OTLP to the Hub, which relays them to the collector: service `sportal-web`. */
export const layer = OtlpLogger.layer({
  url: "/api/telemetry/logs",
  resource: {
    serviceName: "sportal-web",
    attributes: { "service.instance.id": crypto.randomUUID() }
  },
  shutdownTimeout: "1 second"
}).pipe(Layer.provide(OtlpSerialization.layerJson))
