import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { GuideUnreadable } from "./GuideUnreadable.ts"

export class SportalApi extends HttpApi.make("sportal")
  .add(
    // A guide the shell read from the source's guide page, passed on unchanged; the Hub decodes it.
    HttpApiGroup.make("guide").add(
      HttpApiEndpoint.post("read", "/guide", {
        payload: Schema.Struct({ guide: Schema.String }),
        success: HttpApiSchema.NoContent,
        error: GuideUnreadable
      })
    )
  )
  .add(
    // Whether the Hub is up.
    HttpApiGroup.make("host").add(
      HttpApiEndpoint.get("health", "/health", {
        success: Schema.Struct({ version: Schema.String, startedAt: Schema.DateTimeUtcFromString })
      })
    )
  )
  .prefix("/api") {}
