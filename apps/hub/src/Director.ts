import type { Classification } from "@sportal/domain/Classification"
import { Classifier } from "@sportal/domain/Classifier"
import type { GameId, GameSnapshot, GameStatus, Progress } from "@sportal/domain/Game"
import type { Play } from "@sportal/domain/Play"
import { Slate, SlateChange } from "@sportal/domain/Slate"
import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Metric,
  Option,
  Ref,
  Semaphore,
  Stream,
  SubscriptionRef
} from "effect"
import { Delivery, Provider } from "./provider/Provider.ts"
import { loggedUnlessStopping } from "./Shutdown.ts"

export class Director extends Context.Service<
  Director,
  {
    readonly slate: Stream.Stream<Slate>
    /** Each listed game's classification, by its id: the current ones, then each time a take or an expiry changes them. */
    readonly classifications: Stream.Stream<ReadonlyMap<GameId, Classification>>
  }
>()("sportal/hub/Director") {
  static readonly layer: Layer.Layer<Director, never, Provider> = Layer.effect(
    Director,
    Effect.gen(function* () {
      const provider = yield* Provider
      const slate = yield* SubscriptionRef.make(Slate.empty)
      const classifier = yield* Ref.make(Classifier.empty)
      const classifications = yield* SubscriptionRef.make<ReadonlyMap<GameId, Classification>>(new Map())
      const expiry = yield* SubscriptionRef.make(Option.none<DateTime.Utc>())
      const serial = yield* Semaphore.make(1)

      const classify = Effect.fnUntraced(function* (changes: ReadonlyArray<SlateChange>) {
        const current = yield* SubscriptionRef.get(slate)
        const now = yield* DateTime.now
        const had = yield* Ref.get(classifier)
        const before = yield* SubscriptionRef.get(classifications)
        const [next, classified] = had.step(current, changes, now)

        yield* Ref.set(classifier, next)
        yield* SubscriptionRef.set(classifications, classified)
        yield* SubscriptionRef.set(expiry, next.nextExpiry())
        const moved = current.games.filter(
          ({ snapshot }) => before.get(snapshot.id)?.moment._tag !== classified.get(snapshot.id)?.moment._tag
        )
        yield* Effect.forEach(moved, ({ snapshot }) => loggedMoment(snapshot, classified.get(snapshot.id)), {
          discard: true
        })
      })

      const take = Effect.fn("Director.take")(
        function* (delivery: Delivery) {
          const before = yield* SubscriptionRef.get(slate)
          const [next, changes] = Delivery.$match(delivery, {
            Listing: ({ league, games }) => before.relisted(league, games),
            Plays: ({ game, plays }) => before.playsTaken(game, plays)
          })
          if (next === before) return

          yield* SubscriptionRef.set(slate, next)
          yield* Effect.forEach(changes, observed, { discard: true })
          yield* classify(changes)
        },
        serial.withPermits(1),
        Effect.catchDefect((defect) =>
          Effect.logError("Director: a take raised a defect; the slate keeps what it had", Cause.die(defect))
        )
      )

      const expire = Effect.fn("Director.expire")(
        function* () {
          yield* classify([])
        },
        serial.withPermits(1),
        Effect.catchDefect((defect) =>
          Effect.logError("Director: classifying at an expiry raised a defect", Cause.die(defect))
        )
      )

      yield* Effect.forkScoped(
        provider.deliveries.pipe(
          Stream.runForEach(take),
          loggedUnlessStopping(
            "Director: the provider's frames stopped; the slate stays as it is until the Hub restarts",
            "the provider's frames ended"
          )
        ),
        { startImmediately: true }
      )

      const expiries = SubscriptionRef.changes(expiry).pipe(
        Stream.switchMap(
          Option.match({ onNone: () => Stream.never, onSome: (at) => Stream.fromEffect(sleptUntil(at)) })
        )
      )
      yield* Effect.forkScoped(Stream.runForEach(expiries, expire), { startImmediately: true })

      return Director.of({
        slate: SubscriptionRef.changes(slate),
        classifications: SubscriptionRef.changes(classifications)
      })
    })
  )
}

function observed(change: SlateChange) {
  return SlateChange.$match(change, {
    Progressed: ({ game }) => gaugeGame(game.snapshot, progressValues[game.snapshot.progress()]),
    Delisted: ({ game }) => forgotten(game.snapshot),
    Played: ({ game, play }) => loggedPlay(game.snapshot, play)
  })
}

const gaugeGame = Effect.fnUntraced(function* (snapshot: GameSnapshot, progress: number) {
  const now = yield* DateTime.now
  const attributes = { game: snapshot.id, league: snapshot.league, matchup: snapshot.matchup() }
  const away = { ...attributes, side: "away", team: snapshot.away.team.abbreviation }
  const home = { ...attributes, side: "home", team: snapshot.home.team.abbreviation }

  yield* Metric.update(Metric.withAttributes(gameState, attributes), progress)
  yield* Metric.update(Metric.withAttributes(gameStatus, attributes), statusValues[snapshot.status])
  yield* Metric.update(Metric.withAttributes(gameScore, away), snapshot.away.score)
  yield* Metric.update(Metric.withAttributes(gameScore, home), snapshot.home.score)
  yield* Metric.update(Metric.withAttributes(gamePeriod, attributes), snapshot.period)
  yield* Metric.update(Metric.withAttributes(gameClock, attributes), snapshot.secondsLeft())
  yield* Metric.update(
    Metric.withAttributes(gameKickoff, attributes),
    DateTime.toEpochSeconds(snapshot.kickoff)
  )
  yield* Metric.update(Metric.withAttributes(gameUpdatedAt, attributes), DateTime.toEpochSeconds(now))
})

/** Sleeps until `at`, at once when it has passed. */
const sleptUntil = Effect.fnUntraced(function* (at: DateTime.Utc) {
  const now = yield* DateTime.now

  yield* Effect.sleep(Duration.max(DateTime.distance(now, at), Duration.zero))
})

function loggedMoment(snapshot: GameSnapshot, classification: Classification | undefined) {
  if (classification === undefined) return Effect.void
  const matchup = snapshot.matchup()
  return Effect.logInfo(`Director: ${matchup} ${classification.moment._tag} (${classification.score})`).pipe(
    Effect.annotateLogs({
      game: snapshot.id,
      league: snapshot.league,
      matchup,
      moment: classification.moment._tag
    })
  )
}

/** Removes `snapshot`'s game's current metric series, so a game no listing names is not exported again. */
function forgotten(snapshot: GameSnapshot) {
  return Effect.map(Metric.MetricRegistry, (registry) =>
    [...registry]
      .filter(
        ([, metadata]) => currentGameMetrics.has(metadata.id) && metadata.attributes?.game === snapshot.id
      )
      .forEach(([key]) => {
        registry.delete(key)
      })
  )
}

function loggedPlay(snapshot: GameSnapshot, play: Play) {
  const matchup = snapshot.matchup()
  return Effect.logInfo(`Director: ${matchup} Q${play.period} ${play.clock} ${play.text}`).pipe(
    Effect.annotateLogs({
      game: snapshot.id,
      league: snapshot.league,
      matchup,
      play: play._tag,
      scoring: play.scoring
    })
  )
}

// Each progress's value on `sportal_game_state`. Written as a record so that a new progress fails to compile here.
const progressValues = { upcoming: 1, live: 2, over: 3 } satisfies Record<Progress, number>

const statusValues = {
  scheduled: 1,
  live: 2,
  halftime: 3,
  delayed: 4,
  final: 5,
  postponed: 6,
  canceled: 7
} satisfies Record<GameStatus, number>

const gameState = Metric.gauge("sportal_game_state", {
  description: "A game's progress, by game: 1 upcoming, 2 live, 3 over; no series once no listing names it"
})

const gameStatus = Metric.gauge("sportal_game_status", {
  description:
    "A listed game's status: 1 scheduled, 2 live, 3 halftime, 4 delayed, 5 final, 6 postponed, 7 canceled"
})

const gameScore = Metric.gauge("sportal_game_score", {
  description: "A listed game's points by away or home side and team abbreviation"
})

const gamePeriod = Metric.gauge("sportal_game_period", {
  description: "A listed game's current period"
})

const gameClock = Metric.gauge("sportal_game_clock", {
  description: "A listed game's seconds remaining in its current period"
})

const gameKickoff = Metric.gauge("sportal_game_kickoff", {
  description: "A listed game's kickoff in Unix seconds"
})

const gameUpdatedAt = Metric.gauge("sportal_game_updated_at", {
  description: "When the Director accepted a listed game's snapshot, in Unix seconds"
})

const currentGameMetrics = new Set([
  gameState.id,
  gameStatus.id,
  gameScore.id,
  gamePeriod.id,
  gameClock.id,
  gameKickoff.id,
  gameUpdatedAt.id
])
