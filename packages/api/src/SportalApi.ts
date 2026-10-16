import { GameId, PlaysPage } from "@sportal/domain/Game"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { DisplayId } from "./DisplayId.ts"
import { DisplayOffline } from "./DisplayOffline.ts"
import { GameNotFound } from "./GameNotFound.ts"
import { GameList, GamesQuery } from "./GamesQuery.ts"
import { GuideUnreadable } from "./GuideUnreadable.ts"
import { ListedGame } from "./ListedGame.ts"
import { ScheduleUnavailable } from "./ScheduleUnavailable.ts"

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
    HttpApiGroup.make("games")
      .add(
        HttpApiEndpoint.get("list", "/games", {
          query: GamesQuery.fields,
          success: GameList,
          error: ScheduleUnavailable
        })
      )
      .add(
        HttpApiEndpoint.get("game", "/games/:id", {
          params: { id: GameId },
          success: ListedGame,
          error: [GameNotFound, ScheduleUnavailable]
        })
      )
      .add(
        HttpApiEndpoint.get("plays", "/games/:id/plays", {
          params: { id: GameId },
          query: {
            before: Schema.optional(Schema.FiniteFromString.check(Schema.isInt())),
            limit: Schema.optional(
              Schema.FiniteFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 }))
            )
          },
          success: PlaysPage,
          error: [GameNotFound, ScheduleUnavailable]
        })
      )
  )
  .add(
    HttpApiGroup.make("displays")
      .add(
        HttpApiEndpoint.put("report", "/displays/:id", {
          params: { id: DisplayId },
          payload: Schema.Json,
          success: HttpApiSchema.NoContent,
          error: DisplayOffline
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
