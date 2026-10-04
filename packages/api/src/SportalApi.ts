import { GameSnapshot, Network } from "@sportal/domain/Game"
import { ChannelUrlRefused, GuideUnreadable } from "@sportal/domain/Source"
import { Stage, StageCommand, StageRejection } from "@sportal/domain/Stage"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"

export class SportalApi extends HttpApi.make("sportal")
  .add(
    HttpApiGroup.make("slate").add(
      HttpApiEndpoint.get("current", "/slate", { success: Schema.Array(GameSnapshot) })
    )
  )
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
    // What the source knows about each network. These change every Display and every later game, so
    // they are not stage commands; the Stage follows through the live stream.
    HttpApiGroup.make("channels").add(
      HttpApiEndpoint.post("learn", "/channels/learn", {
        payload: Schema.Struct({ network: Network, url: Schema.String }),
        success: HttpApiSchema.NoContent,
        error: ChannelUrlRefused
      }),
      HttpApiEndpoint.post("notCarried", "/channels/not-carried", {
        payload: Schema.Struct({ network: Network }),
        success: HttpApiSchema.NoContent
      }),
      HttpApiEndpoint.post("forget", "/channels/forget", {
        payload: Schema.Struct({ network: Network }),
        success: HttpApiSchema.NoContent
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
