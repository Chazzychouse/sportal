import type { GameNotFound } from "@sportal/api/GameNotFound"
import type { CalendarDate } from "@sportal/api/GamesQuery"
import { StatsUnavailable } from "@sportal/api/StatsUnavailable"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { GameStats } from "@sportal/domain/GameStats"
import type { Highlight } from "@sportal/domain/Highlight"
import type { LeagueId } from "@sportal/domain/League"
import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  RcMap,
  Schedule as Recurrence,
  Schema,
  Stream,
  SubscriptionRef
} from "effect"
import { HubConfig } from "./HubConfig.ts"
import { Provider } from "./provider/Provider.ts"
import { Schedule } from "./Schedule.ts"

/**
 * A game's stats, from its provider's summary. An upcoming game's are empty, and nothing is fetched. An over game's
 * are fetched once and kept for the Hub's run. A live game's are fetched when asked once, and while any live answer
 * follows them, again every `HubConfig.statsRefresh`, one fetch however many follow; a refresh that fails is logged and
 * the last stats stand. A day's highlights in a league are its final games', each final game's stats fetched once,
 * four at a time; a game whose stats are unavailable is logged and left out.
 */
export class Stats extends Context.Service<
  Stats,
  {
    readonly stats: (id: GameId) => Effect.Effect<GameStats, GameNotFound | StatsUnavailable>
    readonly statsLive: (
      id: GameId
    ) => Effect.Effect<Stream.Stream<GameStats, StatsUnavailable>, GameNotFound | StatsUnavailable>
    readonly highlights: (
      league: LeagueId,
      date: CalendarDate
    ) => Effect.Effect<ReadonlyArray<Highlight>, StatsUnavailable>
  }
>()("sportal/hub/Stats") {
  static readonly layer: Layer.Layer<Stats, never, Schedule | Provider | HubConfig> = Layer.effect(
    Stats,
    Effect.gen(function* () {
      const schedule = yield* Schedule
      const provider = yield* Provider
      const config = yield* HubConfig

      const fetched = ({ league, game }: Summarized) =>
        provider.stats(league, game).pipe(Effect.mapError(() => new StatsUnavailable()))

      const finals = yield* Cache.makeWith(fetched, {
        capacity: 1024,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
      })

      // Each followed live game's latest stats, refreshed while anything holds it.
      const following = yield* RcMap.make({
        lookup: Effect.fnUntraced(function* (game: Summarized) {
          const latest = yield* SubscriptionRef.make(Option.none<GameStats>())
          const refresh = fetched(game).pipe(
            Effect.flatMap((stats) => SubscriptionRef.set(latest, Option.some(stats))),
            Effect.catch((error) =>
              Effect.logWarning(
                "Stats: a live game's stats could not be fetched; its last stats stand",
                error
              ).pipe(Effect.annotateLogs({ game: game.game }))
            )
          )

          yield* refresh.pipe(Effect.repeat(Recurrence.spaced(config.statsRefresh)), Effect.forkScoped)
          return latest
        })
      })

      const statsOf = (snapshot: GameSnapshot): Effect.Effect<GameStats, StatsUnavailable> => {
        const game = summarized(snapshot)
        const byProgress = {
          upcoming: () => Effect.succeed(GameStats.empty(snapshot.id)),
          live: () => fetched(game),
          over: () => Cache.get(finals, game)
        }
        return byProgress[snapshot.progress()]()
      }

      const followedFrom = (snapshot: GameSnapshot): Stream.Stream<GameStats, StatsUnavailable> => {
        const game = summarized(snapshot)
        const byProgress = {
          upcoming: () => Stream.succeed(GameStats.empty(snapshot.id)),
          live: () =>
            Stream.unwrap(
              Effect.map(RcMap.get(following, game), (latest) =>
                SubscriptionRef.changes(latest).pipe(
                  Stream.filter(Option.isSome),
                  Stream.map(({ value }) => value)
                )
              )
            ),
          over: () => Stream.fromEffect(Cache.get(finals, game))
        }
        return byProgress[snapshot.progress()]()
      }

      return Stats.of({
        stats: Effect.fn("Stats.stats")(function* (id: GameId) {
          const { snapshot } = yield* schedule
            .game(id)
            .pipe(Effect.catchTag("ScheduleUnavailable", unavailable))

          return yield* statsOf(snapshot)
        }),
        statsLive: Effect.fn("Stats.statsLive")(function* (id: GameId) {
          const games = yield* schedule.gameLive(id).pipe(Effect.catchTag("ScheduleUnavailable", unavailable))

          return games.pipe(
            Stream.map(({ snapshot }) => snapshot),
            Stream.changesWith((a, b) => a.progress() === b.progress()),
            Stream.switchMap(followedFrom),
            Stream.changesWith(sameStats)
          )
        }),
        highlights: Effect.fn("Stats.highlights")(function* (league: LeagueId, date: CalendarDate) {
          const day = yield* schedule
            .list({ date, league: [league], progress: ["over"] })
            .pipe(Effect.mapError(() => new StatsUnavailable()))
          const finished = day.games
            .map(({ snapshot }) => snapshot)
            .filter(({ status }) => status === "final")

          const each = yield* Effect.forEach(
            finished,
            (snapshot) =>
              Cache.get(finals, summarized(snapshot)).pipe(
                Effect.map(({ highlights }) => highlights),
                Effect.catch((error) =>
                  Effect.logWarning(
                    "Stats: a final game's highlights are left out; its stats are unavailable",
                    error
                  ).pipe(Effect.annotateLogs({ game: snapshot.id }), Effect.as([]))
                )
              ),
            { concurrency: 4 }
          )
          return each.flat()
        })
      })
    })
  )
}

/** A game whose summary is asked for: its league, which says where, and its id. */
interface Summarized {
  readonly league: LeagueId
  readonly game: GameId
}

function summarized(snapshot: GameSnapshot): Summarized {
  return { league: snapshot.league, game: snapshot.id }
}

function unavailable() {
  return Effect.fail(new StatsUnavailable())
}

const sameStats = Schema.toEquivalence(GameStats)
