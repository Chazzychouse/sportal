import { GameNotFound } from "@sportal/api/GameNotFound"
import { CalendarDate, GameList, GamesQuery } from "@sportal/api/GamesQuery"
import { ListedGame } from "@sportal/api/ListedGame"
import { ScheduleUnavailable } from "@sportal/api/ScheduleUnavailable"
import { Game, type GameId, type GameSnapshot, type PlaysChange, type PlaysPage } from "@sportal/domain/Game"
import { Play } from "@sportal/domain/Play"
import {
  Cache,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  HashMap,
  Layer,
  Option,
  Ref,
  Schema,
  Sink,
  Stream
} from "effect"
import { Director } from "./Director.ts"
import { HubConfig } from "./HubConfig.ts"
import { Provider } from "./provider/Provider.ts"
import { Source } from "./source/Source.ts"

/**
 * What the games API answers: a day's games, one game, and a game's plays, each once or live. Today is the
 * Director's slate, live; another day is the provider's listing for it, held in memory (a past day until the Hub
 * restarts, a later one for 10 minutes). A game off today's slate is found through a day already listed, and its plays
 * are fetched from the provider. Each live answer is one connection's own stream, sending only what changed.
 */
export class Schedule extends Context.Service<
  Schedule,
  {
    readonly list: (query: GamesQuery) => Effect.Effect<GameList, ScheduleUnavailable>
    readonly listLive: (query: GamesQuery) => Effect.Effect<Stream.Stream<GameList>, ScheduleUnavailable>
    readonly game: (id: GameId) => Effect.Effect<ListedGame, GameNotFound | ScheduleUnavailable>
    readonly gameLive: (
      id: GameId
    ) => Effect.Effect<Stream.Stream<ListedGame>, GameNotFound | ScheduleUnavailable>
    readonly plays: (
      id: GameId,
      page: { readonly before?: number | undefined; readonly limit?: number | undefined }
    ) => Effect.Effect<PlaysPage, GameNotFound | ScheduleUnavailable>
    readonly playsLive: (
      id: GameId
    ) => Effect.Effect<Stream.Stream<PlaysChange>, GameNotFound | ScheduleUnavailable>
  }
>()("sportal/hub/Schedule") {
  static readonly layer: Layer.Layer<Schedule, never, Director | Provider | Source | HubConfig> =
    Layer.effect(
      Schedule,
      Effect.gen(function* () {
        const director = yield* Director
        const provider = yield* Provider
        const source = yield* Source
        const config = yield* HubConfig
        const zone = yield* DateTime.zoneMakeNamedEffect(config.timeZone).pipe(Effect.orDie)
        // Each game a fetched day listed, by id, so a game off today's slate can be found.
        const held = yield* Ref.make(HashMap.empty<GameId, GameSnapshot>())

        const today = Effect.map(DateTime.now, (now) => dayOf(now, zone))

        const days = yield* Cache.makeWith(
          Effect.fnUntraced(function* (date: CalendarDate) {
            const games = yield* provider.listing(date).pipe(Effect.mapError(() => new ScheduleUnavailable()))
            const now = yield* today

            yield* Ref.update(held, (all) =>
              HashMap.setMany(
                all,
                games.map((game) => [game.id, game] as const)
              )
            )
            return { games, past: date < now }
          }),
          {
            capacity: 64,
            timeToLive: (exit) =>
              Exit.isSuccess(exit)
                ? exit.value.past
                  ? Duration.infinity
                  : Duration.minutes(10)
                : Duration.zero
          }
        )

        const fetchedPlays = yield* Cache.makeWith(
          (snapshot: GameSnapshot) =>
            provider
              .plays(snapshot.league, snapshot.id)
              .pipe(Effect.mapError(() => new ScheduleUnavailable())),
          {
            capacity: 256,
            timeToLive: (exit, snapshot) =>
              Exit.isFailure(exit)
                ? Duration.zero
                : snapshot.progress() === "over"
                  ? Duration.infinity
                  : Duration.minutes(1)
          }
        )

        /** Day `date`'s games, the current ones then each change: today's follow the slate, another day's never change. */
        const gamesOn = Effect.fnUntraced(function* (date: CalendarDate) {
          const now = yield* today
          if (date === now) {
            return director.slate.pipe(
              Stream.map((slate) =>
                slate.games.filter(
                  ({ snapshot }) => dayOf(snapshot.startsAt, zone) === date || snapshot.progress() === "live"
                )
              )
            )
          }
          const listed = yield* Cache.get(days, date)

          return Stream.make(listed.games.map(Game.of))
        })

        /**
         * Game `id`, the current one then each change: from today's slate, or once from a held day, with the plays
         * `playsOf` gives it.
         */
        const gameOf = Effect.fnUntraced(function* (
          id: GameId,
          playsOf: (snapshot: GameSnapshot) => Effect.Effect<ReadonlyArray<Play>, ScheduleUnavailable>
        ) {
          const slate = yield* first(director.slate)
          if (Option.isSome(slate.gameOf(id))) {
            return director.slate.pipe(
              Stream.map((each) => each.gameOf(id)),
              Stream.filter(Option.isSome),
              Stream.map(({ value }) => value),
              Stream.changes
            )
          }
          const all = yield* Ref.get(held)
          const snapshot = yield* Effect.fromOption(HashMap.get(all, id)).pipe(
            Effect.mapError(() => new GameNotFound())
          )
          const plays = yield* playsOf(snapshot)

          return Stream.make(new Game({ snapshot, plays: plays.toSorted(Play.order) }))
        })

        /** An off-slate game's plays, from the provider. */
        const playsFetched = (snapshot: GameSnapshot) => Cache.get(fetchedPlays, snapshot)

        /** `games` beside each one's availability now; rechecked every 30 seconds while the stream runs. */
        const listed = (
          games: Stream.Stream<ReadonlyArray<Game>>
        ): Stream.Stream<ReadonlyArray<ListedGame>> =>
          Stream.zipLatest(games, Stream.tick("30 seconds")).pipe(
            Stream.mapEffect(([current]) =>
              Effect.gen(function* () {
                const availabilityOf = yield* source.availability
                const now = yield* DateTime.now

                return current.map(({ snapshot }) => ({
                  snapshot,
                  availability: availabilityOf(snapshot, now)
                }))
              })
            )
          )

        const listLive = Effect.fn("Schedule.listLive")(function* (query: GamesQuery) {
          const now = yield* today
          const date = query.date ?? now
          const games = yield* gamesOn(date)

          return settled(
            listed(games).pipe(
              Stream.map((each): GameList => ({ date, games: GamesQuery.answer(query, each) })),
              Stream.changesWith(sameList)
            )
          )
        })

        const gameLive = Effect.fn("Schedule.gameLive")(function* (id: GameId) {
          const game = yield* gameOf(id, noPlays)

          return listed(Stream.map(game, (each) => [each])).pipe(
            Stream.map((each) => each[0]),
            Stream.filter((each) => each !== undefined),
            Stream.changesWith(sameListed)
          )
        })

        const playsLive = Effect.fn("Schedule.playsLive")(function* (id: GameId) {
          const game = yield* gameOf(id, playsFetched)

          return game.pipe(
            Stream.mapAccum(
              () => Option.none<Game>(),
              (earlier, next) => {
                const change = Option.match(earlier, {
                  onNone: () =>
                    Option.some<PlaysChange>({
                      _tag: "Reset",
                      plays: next.playsPage(undefined, Game.pageSize).plays
                    }),
                  onSome: (had) => next.playsChange(had)
                })
                return [Option.some(next), Option.toArray(change)] as const
              }
            )
          )
        })

        return Schedule.of({
          list: Effect.fn("Schedule.list")(function* (query: GamesQuery) {
            const answers = yield* listLive(query)

            return yield* first(answers)
          }),
          listLive,
          game: Effect.fn("Schedule.game")(function* (id: GameId) {
            const answers = yield* gameLive(id)

            return yield* first(answers)
          }),
          gameLive,
          plays: Effect.fn("Schedule.plays")(function* (id: GameId, page) {
            const game = yield* gameOf(id, playsFetched)
            const current = yield* first(game)

            return current.playsPage(page.before, page.limit ?? Game.pageSize)
          }),
          playsLive
        })
      })
    )
}

/** The calendar day `at` falls on in `zone`, as `YYYY-MM-DD`. */
function dayOf(at: DateTime.DateTime, zone: DateTime.TimeZone): CalendarDate {
  return CalendarDate.make(DateTime.formatIsoDate(DateTime.setZone(at, zone)))
}

/** The first value of `stream`, which always has one: a live answer starts with the current one. */
function first<A>(stream: Stream.Stream<A>): Effect.Effect<A> {
  return Stream.runHead(stream).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die("Schedule: a live answer ended before its first value"),
        onSome: Effect.succeed
      })
    )
  )
}

/** No plays: what a listed game, which never carries them, needs of an off-slate game. */
function noPlays(): Effect.Effect<ReadonlyArray<Play>> {
  return Effect.succeed([])
}

/** `changes` with its first value at once and each later one after 250 ms with no other. */
function settled<A>(changes: Stream.Stream<A>): Stream.Stream<A> {
  return Stream.unwrap(
    Effect.map(Stream.peel(changes, Sink.head()), ([current, rest]) =>
      Stream.concat(Stream.fromIterable(Option.toArray(current)), rest.pipe(Stream.debounce("250 millis")))
    )
  )
}

const sameList = Schema.toEquivalence(GameList)

const sameListed = Schema.toEquivalence(ListedGame)
