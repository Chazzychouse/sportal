import type { DisplayId } from "@sportal/api/DisplayId"
import type { DisplayOffline } from "@sportal/api/DisplayOffline"
import type { GameNotFound } from "@sportal/api/GameNotFound"
import type { CalendarDate } from "@sportal/api/GamesQuery"
import type { GuideUnreadable } from "@sportal/api/GuideUnreadable"
import type { ScheduleUnavailable } from "@sportal/api/ScheduleUnavailable"
import type { StatsUnavailable } from "@sportal/api/StatsUnavailable"
import type { GameId } from "@sportal/domain/Game"
import { GameStats } from "@sportal/domain/GameStats"
import type { Highlight } from "@sportal/domain/Highlight"
import type { LeagueId } from "@sportal/domain/League"
import type { Play } from "@sportal/domain/Play"
import { Context, Effect, Layer, type Schema } from "effect"
import type { RpcClientError } from "effect/rpc"
import { HubSocket } from "./HubSocket.ts"

/** This client's requests and writes to the Hub, over the Hub socket. */
export class HubClient extends Context.Service<
  HubClient,
  {
    /** Passes a guide the shell read to the Hub. What it changes arrives on the live queries. */
    readonly sendGuide: (
      guide: string
    ) => Effect.Effect<void, GuideUnreadable | RpcClientError.RpcClientError>
    /** The addresses a Remote on the home network can reach the Hub's machine at. */
    readonly addresses: Effect.Effect<ReadonlyArray<string>, RpcClientError.RpcClientError>
    /** Tells the Hub this Display's report, for its Remotes. */
    readonly report: (
      id: DisplayId,
      report: Schema.Json
    ) => Effect.Effect<void, DisplayOffline | RpcClientError.RpcClientError>
    /** Sends one input to the Display `id`, from a Remote. */
    readonly send: (
      id: DisplayId,
      input: Schema.Json
    ) => Effect.Effect<void, DisplayOffline | RpcClientError.RpcClientError>
    /** Game `id`'s stats, once. */
    readonly stats: (
      id: GameId
    ) => Effect.Effect<GameStats, GameNotFound | StatsUnavailable | RpcClientError.RpcClientError>
    /** The highlights of `date`'s final games of `league`. */
    readonly highlights: (
      league: LeagueId,
      date: CalendarDate
    ) => Effect.Effect<ReadonlyArray<Highlight>, StatsUnavailable | RpcClientError.RpcClientError>
    /** Every play of game `id`, newest first, asked a page at a time. */
    readonly plays: (
      id: GameId
    ) => Effect.Effect<
      ReadonlyArray<Play>,
      GameNotFound | ScheduleUnavailable | RpcClientError.RpcClientError
    >
  }
>()("sportal/web/hub/HubClient") {
  static readonly layer: Layer.Layer<HubClient, never, HubSocket> = Layer.effect(
    HubClient,
    Effect.gen(function* () {
      const { client } = yield* HubSocket

      const sendGuide = Effect.fn("HubClient.sendGuide")(function* (guide: string) {
        yield* client.readGuide({ guide })
      })
      const addresses = client.addresses()
      const report = Effect.fn("HubClient.report")(function* (id: DisplayId, json: Schema.Json) {
        yield* client.report({ display: id, report: json })
      })
      const send = Effect.fn("HubClient.send")(function* (id: DisplayId, input: Schema.Json) {
        yield* client.send({ display: id, input })
      })
      const stats = Effect.fn("HubClient.stats")(function* (id: GameId) {
        return yield* client.stats({ id })
      })
      const highlights = Effect.fn("HubClient.highlights")(function* (league: LeagueId, date: CalendarDate) {
        return yield* client.highlights({ league, date })
      })
      const plays = Effect.fn("HubClient.plays")(function* (id: GameId) {
        const all: Array<Play> = []
        let before: number | undefined
        while (true) {
          const page = yield* client.plays({ id, before, limit: 200 })
          all.push(...page.plays)
          const last = page.plays.at(-1)
          if (!page.more || last === undefined) return all
          before = last.sequence
        }
      })
      return HubClient.of({ sendGuide, addresses, report, send, stats, highlights, plays })
    })
  )

  /**
   * A Hub client whose calls are `fakes`; each one not given does nothing, `addresses` lists none, `stats` are empty,
   * and `highlights` and `plays` none.
   */
  static layerTest(fakes: Partial<HubClient["Service"]> = {}): Layer.Layer<HubClient> {
    return Layer.succeed(
      HubClient,
      HubClient.of({
        sendGuide: () => Effect.void,
        addresses: Effect.succeed([]),
        report: () => Effect.void,
        send: () => Effect.void,
        stats: (id) => Effect.succeed(GameStats.empty(id)),
        highlights: () => Effect.succeed([]),
        plays: () => Effect.succeed([]),
        ...fakes
      })
    )
  }
}
