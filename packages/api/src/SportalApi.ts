import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { GuideUnreadable } from "./GuideUnreadable.ts"
import { LiveMessageJson } from "./LiveMessage.ts"

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
    HttpApiGroup.make("host").add(
      HttpApiEndpoint.get("health", "/health", {
        success: Schema.Struct({ version: Schema.String, startedAt: Schema.DateTimeUtcFromString })
      })
    )
  )
  .add(
    HttpApiGroup.make("live").add(
      HttpApiEndpoint.get("stream", "/live", {
        success: HttpApiSchema.WithHeaders(
          HttpApiSchema.StreamSse({
            events: Schema.Union([
              Schema.Struct({ event: Schema.Literal("message"), data: LiveMessageJson }),
              Schema.Struct({ event: Schema.Literal("keep-alive"), data: Schema.Literal("") })
            ])
          }),
          { "cache-control": Schema.Literal("no-cache") }
        )
      })
    )
  )
  .prefix("/api") {}
