import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { DisplayId } from "./DisplayId.ts"
import { DisplayOffline } from "./DisplayOffline.ts"
import { GuideUnreadable } from "./GuideUnreadable.ts"
import { LiveMessageJson } from "./LiveMessage.ts"
import { RemoteMessageJson } from "./RemoteMessage.ts"

export class SportalApi extends HttpApi.make("sportal")
  .add(
    HttpApiGroup.make("guide").add(
      HttpApiEndpoint.post("read", "/guide", {
        payload: Schema.Struct({ guide: Schema.String }),
        success: HttpApiSchema.NoContent,
        error: GuideUnreadable
      })
    )
  )
  .add(
    HttpApiGroup.make("host")
      .add(
        HttpApiEndpoint.get("health", "/health", {
          success: Schema.Struct({ version: Schema.String, startedAt: Schema.DateTimeUtcFromString })
        })
      )
      .add(HttpApiEndpoint.get("addresses", "/addresses", { success: Schema.Array(Schema.String) }))
  )
  .add(
    HttpApiGroup.make("live").add(HttpApiEndpoint.get("stream", "/live", { success: sse(LiveMessageJson) }))
  )
  .add(
    HttpApiGroup.make("displays")
      .add(
        HttpApiEndpoint.get("inputs", "/displays/:id/inputs", {
          params: { id: DisplayId },
          success: sse(Schema.fromJsonString(Schema.Json))
        })
      )
      .add(
        HttpApiEndpoint.put("report", "/displays/:id", {
          params: { id: DisplayId },
          payload: Schema.Json,
          success: HttpApiSchema.NoContent,
          error: DisplayOffline
        })
      )
      .add(
        HttpApiEndpoint.get("follow", "/displays/:id", {
          params: { id: DisplayId },
          success: sse(RemoteMessageJson)
        })
      )
      .add(
        HttpApiEndpoint.post("send", "/displays/:id/inputs", {
          params: { id: DisplayId },
          payload: Schema.Json,
          success: HttpApiSchema.NoContent,
          error: DisplayOffline
        })
      )
  )
  .prefix("/api") {}

/** A server-sent event stream whose `message` events carry `data`, with keep-alive events between them. */
function sse<A>(data: Schema.Codec<A, string>) {
  return HttpApiSchema.WithHeaders(
    HttpApiSchema.StreamSse({
      events: Schema.Union([
        Schema.Struct({ event: Schema.Literal("message"), data }),
        Schema.Struct({ event: Schema.Literal("keep-alive"), data: Schema.Literal("") })
      ])
    }),
    { "cache-control": Schema.Literal("no-cache") }
  )
}
