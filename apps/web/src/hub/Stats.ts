import type { CalendarDate } from "@sportal/api/GamesQuery"
import type { GameId } from "@sportal/domain/Game"
import type { GameStats } from "@sportal/domain/GameStats"
import type { LeagueId } from "@sportal/domain/League"
import { Effect, Option } from "effect"
import { Atom } from "effect/reactivity"
import { runtime } from "../WebRuntime.ts"
import { HubClient } from "./HubClient.ts"
import * as LiveStream from "./LiveStream.ts"

/** Game `id`'s stats, asked once while read: a game that is not live. */
export const stats = Atom.family((id: GameId) =>
  runtime.atom(
    Effect.gen(function* () {
      const hub = yield* HubClient
      return yield* hub.stats(id)
    })
  )
)

/** Game `id`'s stats, live: none before the first answer. Asked of the Hub only while read: a live game. */
export const statsLive = Atom.family((id: GameId) =>
  LiveStream.of(
    (client) => client.statsLive({ id }),
    Option.none<GameStats>(),
    (_, answer) => Option.some(answer)
  )
)

/** The highlights of `date`'s final games of `league`, asked once per page. */
export const highlights = Atom.family((day: { readonly league: LeagueId; readonly date: CalendarDate }) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const hub = yield* HubClient
        return yield* hub.highlights(day.league, day.date)
      })
    )
    .pipe(Atom.keepAlive)
)
