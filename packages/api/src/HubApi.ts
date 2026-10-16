import { GameId, PlaysChange, PlaysPage } from "@sportal/domain/Game"
import { GameStats } from "@sportal/domain/GameStats"
import { Highlight } from "@sportal/domain/Highlight"
import { LeagueId } from "@sportal/domain/League"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { DisplayId } from "./DisplayId.ts"
import { DisplayMessage } from "./DisplayMessage.ts"
import { DisplayOffline } from "./DisplayOffline.ts"
import { GameNotFound } from "./GameNotFound.ts"
import { CalendarDate, GameList, GamesQuery } from "./GamesQuery.ts"
import { GuideUnreadable } from "./GuideUnreadable.ts"
import { ListedGame } from "./ListedGame.ts"
import { RemoteMessage } from "./RemoteMessage.ts"
import { ScheduleUnavailable } from "./ScheduleUnavailable.ts"
import { StatsUnavailable } from "./StatsUnavailable.ts"

/**
 * The Hub's whole API, over its one WebSocket per page at `/api/socket`, declared once: the Hub serves it and the web
 * derives its client from it. Each live query is a stream RPC, sending its current answer first, then each change, for
 * as long as its client reads it. Every other read and write is a request: one answer, or its error.
 */
export class HubApi extends RpcGroup.make(
  Rpc.make("listLive", { payload: GamesQuery, success: GameList, error: ScheduleUnavailable, stream: true }),
  Rpc.make("gameLive", {
    payload: { id: GameId },
    success: ListedGame,
    error: Schema.Union([GameNotFound, ScheduleUnavailable]),
    stream: true
  }),
  Rpc.make("playsLive", {
    payload: { id: GameId },
    success: PlaysChange,
    error: Schema.Union([GameNotFound, ScheduleUnavailable]),
    stream: true
  }),
  Rpc.make("statsLive", {
    payload: { id: GameId },
    success: GameStats,
    error: Schema.Union([GameNotFound, StatsUnavailable]),
    stream: true
  }),
  Rpc.make("inputs", { payload: { display: DisplayId }, success: DisplayMessage, stream: true }),
  Rpc.make("follow", { payload: { display: DisplayId }, success: RemoteMessage, stream: true }),
  Rpc.make("list", { payload: GamesQuery, success: GameList, error: ScheduleUnavailable }),
  Rpc.make("game", {
    payload: { id: GameId },
    success: ListedGame,
    error: Schema.Union([GameNotFound, ScheduleUnavailable])
  }),
  Rpc.make("plays", {
    payload: {
      id: GameId,
      before: Schema.optional(Schema.Finite.check(Schema.isInt())),
      limit: Schema.optional(
        Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 }))
      )
    },
    success: PlaysPage,
    error: Schema.Union([GameNotFound, ScheduleUnavailable])
  }),
  Rpc.make("stats", {
    payload: { id: GameId },
    success: GameStats,
    error: Schema.Union([GameNotFound, StatsUnavailable])
  }),
  Rpc.make("highlights", {
    payload: { league: LeagueId, date: CalendarDate },
    success: Schema.Array(Highlight),
    error: StatsUnavailable
  }),
  Rpc.make("readGuide", { payload: { guide: Schema.String }, error: GuideUnreadable }),
  Rpc.make("health", {
    success: Schema.Struct({ version: Schema.String, startedAt: Schema.DateTimeUtcFromString })
  }),
  Rpc.make("addresses", { success: Schema.Array(Schema.String) }),
  Rpc.make("report", { payload: { display: DisplayId, report: Schema.Json }, error: DisplayOffline }),
  Rpc.make("send", { payload: { display: DisplayId, input: Schema.Json }, error: DisplayOffline })
) {}
