import { GameId, PlaysChange, PlaysPage } from "@sportal/domain/Game"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { DisplayId } from "./DisplayId.ts"
import { DisplayOffline } from "./DisplayOffline.ts"
import { GameNotFound } from "./GameNotFound.ts"
import { GameList, GameListJson, GamesQuery } from "./GamesQuery.ts"
import { GuideUnreadable } from "./GuideUnreadable.ts"
import { ListedGame, ListedGameJson } from "./ListedGame.ts"
import { RemoteMessageJson } from "./RemoteMessage.ts"
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
        HttpApiEndpoint.get("listLive", "/games/live", {
          query: GamesQuery.fields,
          success: sse(GameListJson),
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
        HttpApiEndpoint.get("gameLive", "/games/:id/live", {
          params: { id: GameId },
          success: sse(ListedGameJson),
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
      .add(
        HttpApiEndpoint.get("playsLive", "/games/:id/plays/live", {
          params: { id: GameId },
          success: sse(Schema.fromJsonString(PlaysChange)),
          error: [GameNotFound, ScheduleUnavailable]
        })
      )
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
