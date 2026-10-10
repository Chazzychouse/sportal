import { Layer } from "effect"
import { OtlpLogger, OtlpSerialization } from "effect/observability"

/** This page's logs, shipped over OTLP to the Hub, which relays them to the collector: service `sportal-web`. */
export const layer = OtlpLogger.layer({
  url: "/api/telemetry/logs",
  resource: {
    serviceName: "sportal-web",
    attributes: { "service.instance.id": instanceId() }
  },
  shutdownTimeout: "1 second"
}).pipe(Layer.provide(OtlpSerialization.layerJson))

/** A random id for this page load; `randomUUID` is missing over plain http, which a LAN device uses. */
function instanceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
