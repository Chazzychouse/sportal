import type { Classification } from "@sportal/domain/Classification"
import { Classifier } from "@sportal/domain/Classifier"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { Play } from "@sportal/domain/Play"
import { Slate, SlateChange } from "@sportal/domain/Slate"
import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
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
        const moved = current.games.filter(({ snapshot }) => {
          const had = before.get(snapshot.id)
          return had !== undefined && had.moment._tag !== classified.get(snapshot.id)?.moment._tag
        })
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
          yield* observed(changes)
          yield* classify(changes)
        },
        serial.withPermits(1),
        Effect.catchDefect((defect) =>
          Effect.logError(
            "Director: a take raised a defect; what it had not yet set is unchanged",
            Cause.die(defect)
          )
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

/**
 * A take's plays logged: each by itself, except a game's backfill (`Slate.backfill`), such as every game's plays so far
 * when the Hub starts, which is one line.
 */
function observed(changes: ReadonlyArray<SlateChange>) {
  const played = changes.filter(SlateChange.$is("Played"))
  if (played.length > Slate.backfill) return loggedBackfill(played)
  return Effect.forEach(played, ({ game, play }) => loggedPlay(game.snapshot, play), { discard: true })
}

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

/** One line for a game's backfilled plays: a take's plays are all its one game's. */
function loggedBackfill(played: ReadonlyArray<Extract<SlateChange, { readonly _tag: "Played" }>>) {
  const first = played[0]
  if (first === undefined) return Effect.void
  const { snapshot } = first.game
  const matchup = snapshot.matchup()
  return Effect.logInfo(`Director: ${matchup} caught up on ${played.length} plays`).pipe(
    Effect.annotateLogs({ game: snapshot.id, league: snapshot.league, matchup })
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
