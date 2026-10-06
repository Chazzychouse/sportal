import { GuideUnreadable } from "@sportal/domain/Guide"
import { Stage, StageCommand, StageRejection } from "@sportal/domain/Stage"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"

export class SportalApi extends HttpApi.make("sportal")
  .add(
    HttpApiGroup.make("stage").add(
      HttpApiEndpoint.get("current", "/stage", { success: Stage }),
      HttpApiEndpoint.post("dispatch", "/stage/commands", {
        payload: Schema.Struct({ command: StageCommand }),
        success: Stage,
        error: StageRejection
      })
    )
  )
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
    // Where a Remote on the home network can reach this machine, and whether the Hub is up.
    HttpApiGroup.make("host").add(
      HttpApiEndpoint.get("addresses", "/addresses", { success: Schema.Array(Schema.String) }),
      HttpApiEndpoint.get("health", "/health", {
        success: Schema.Struct({ version: Schema.String, startedAt: Schema.DateTimeUtcFromString })
      })
    )
  )
  .prefix("/api") {}
