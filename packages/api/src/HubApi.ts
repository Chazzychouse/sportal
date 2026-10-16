import { GameId, PlaysChange } from "@sportal/domain/Game"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { DisplayId } from "./DisplayId.ts"
import { DisplayMessage } from "./DisplayMessage.ts"
import { GameNotFound } from "./GameNotFound.ts"
import { GameList, GamesQuery } from "./GamesQuery.ts"
import { ListedGame } from "./ListedGame.ts"
import { RemoteMessage } from "./RemoteMessage.ts"
import { ScheduleUnavailable } from "./ScheduleUnavailable.ts"

/**
 * The Hub's API over its one WebSocket per page, at `/api/socket`, declared once: the Hub serves it and the web derives
 * its client from it. Each live query is a stream RPC, sending its current answer first, then each change, for as long
 * as its client reads it.
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
  Rpc.make("inputs", { payload: { display: DisplayId }, success: DisplayMessage, stream: true }),
  Rpc.make("follow", { payload: { display: DisplayId }, success: RemoteMessage, stream: true })
) {}
