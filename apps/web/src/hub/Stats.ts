import type { CalendarDate } from "@sportal/api/GamesQuery"
import type { GameId } from "@sportal/domain/Game"
import type { GameStats } from "@sportal/domain/GameStats"
import type { LeagueId } from "@sportal/domain/League"
import { Duration, Effect, Option, Schedule, Stream } from "effect"
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

/**
 * The highlights of `date`'s final games of `league`, a day that is over: asked once while read, and again every five
 * minutes until an asking succeeds. Kept a day after nothing reads it.
 */
export const highlights = Atom.family((day: HighlightsDay) =>
  runtime.atom(askHighlights(day)).pipe(Atom.setIdleTTL("1 day"))
)

/**
 * The highlights of today's final games of `league`: asked while read and again every five minutes, so games that go
 * final later join them. A failed asking keeps the last answer. Kept five minutes after nothing reads it.
 */
export const highlightsToday = Atom.family((day: HighlightsDay) =>
  runtime
    .atom(Stream.fromEffectSchedule(askHighlights(day), Schedule.spaced(highlightsEvery)))
    .pipe(Atom.setIdleTTL(highlightsEvery))
)

/** A league's day whose highlights are asked for. */
interface HighlightsDay {
  readonly league: LeagueId
  readonly date: CalendarDate
}

const highlightsEvery = Duration.minutes(5)

/** One asking of `day`'s highlights, retried every five minutes until it succeeds. */
const askHighlights = Effect.fn("Stats.askHighlights")(
  function* (day: HighlightsDay) {
    const hub = yield* HubClient
    return yield* hub.highlights(day.league, day.date)
  },
  Effect.retry(Schedule.spaced(highlightsEvery))
)
