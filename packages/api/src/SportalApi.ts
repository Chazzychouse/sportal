import { GuideUnreadable } from "@sportal/domain/Guide"
import { Screen, ScreenCommand, ScreenRejection } from "@sportal/domain/Screen"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"

export class SportalApi extends HttpApi.make("sportal")
  .add(
    HttpApiGroup.make("screen").add(
      HttpApiEndpoint.get("current", "/screen", { success: Screen }),
      HttpApiEndpoint.post("dispatch", "/screen/commands", {
        payload: Schema.Struct({ command: ScreenCommand }),
        success: Screen,
        error: ScreenRejection
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
