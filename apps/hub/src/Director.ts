import type { GameSnapshot } from "@sportal/domain/Game"
import type { Play } from "@sportal/domain/Play"
import { Slate, SlateChange } from "@sportal/domain/Slate"
import { Cause, Context, Effect, Layer, Semaphore, Stream, SubscriptionRef } from "effect"
import { Delivery, Provider } from "./provider/Provider.ts"
import { loggedUnlessStopping } from "./Shutdown.ts"

export class Director extends Context.Service<
  Director,
  {
    /** The slate: the current one, then each one a take makes. */
    readonly slate: Stream.Stream<Slate>
  }
>()("sportal/hub/Director") {
  static readonly layer: Layer.Layer<Director, never, Provider> = Layer.effect(
    Director,
    Effect.gen(function* () {
      const provider = yield* Provider
      const slate = yield* SubscriptionRef.make(Slate.empty)
      const serial = yield* Semaphore.make(1)

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
        },
        serial.withPermits(1),
        Effect.catchDefect((defect) =>
          Effect.logError(
            "Director: a take raised a defect; what it had not yet set is unchanged",
            Cause.die(defect)
          )
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

      return Director.of({ slate: SubscriptionRef.changes(slate) })
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
  return Effect.logInfo(`Director: ${matchup} period ${play.period} ${play.clock} ${play.text}`).pipe(
    Effect.annotateLogs({
      game: snapshot.id,
      league: snapshot.league,
      matchup,
      play: play.type.text,
      scoring: play.scoring
    })
  )
}
