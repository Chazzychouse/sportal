import type { GameSnapshot, Progress } from "@sportal/domain/Game"
import type { Play } from "@sportal/domain/Play"
import { Cause, Context, Effect, Layer, Metric, Stream, SubscriptionRef } from "effect"
import * as HubStopping from "./HubStopping.ts"
import { type Delivery, Provider } from "./provider/Provider.ts"
import { Slate, SlateChange } from "./Slate.ts"

/**
 * The Hub's one holder of what is going on: the day's slate, taken from each frame its provider decodes as it
 * arrives.
 */
export class Director extends Context.Service<
  Director,
  {
    /** The slate as it is, then again each time a take changes it. */
    readonly slate: Stream.Stream<Slate>
  }
>()("sportal/hub/Director") {
  /**
   * Takes what the provider decodes, from an empty slate, gauging each game a take changed by its progress, and
   * logging each play it adds, as the take says. A take that raises a defect is logged, and the slate keeps what it
   * had; if the provider's frames ever end other than by the Hub stopping, that is logged.
   */
  static readonly layer: Layer.Layer<Director, never, Provider> = Layer.effect(
    Director,
    Effect.gen(function* () {
      const provider = yield* Provider
      const slate = yield* SubscriptionRef.make(Slate.empty)

      const take = Effect.fn("Director.take")(
        function* (deliveries: ReadonlyArray<Delivery>) {
          yield* Effect.annotateCurrentSpan({ "sportal.deliveries": deliveries.length })
          const before = yield* SubscriptionRef.get(slate)
          const [next, changes] = before.take(deliveries)
          if (next === before) return

          yield* SubscriptionRef.set(slate, next)
          yield* Effect.forEach(changes, observed, { discard: true })
        },
        Effect.catchDefect((defect) =>
          Effect.logError("Director: a take raised a defect; the slate keeps what it had", Cause.die(defect))
        )
      )

      yield* Effect.forkScoped(
        provider.deliveries.pipe(
          Stream.runForEach(take),
          HubStopping.loggedUnlessStopping(
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

/** A change the slate took, observed: a game's progress gauged (its series removed once delisted), or a play it added logged. */
function observed(change: SlateChange) {
  return SlateChange.$match(change, {
    Progressed: ({ game }) => gauge(game.snapshot, progressValues[game.snapshot.progress()]),
    Delisted: ({ game }) => forgotten(game.snapshot),
    Played: ({ game, play }) => loggedPlay(game.snapshot, play)
  })
}

function gauge(snapshot: GameSnapshot, value: number) {
  const attributes = { game: snapshot.id, league: snapshot.league, matchup: snapshot.matchup() }
  return Metric.update(Metric.withAttributes(gameState, attributes), value)
}

/** Removes `snapshot`'s game's series of `sportal_game_state`, so a game no listing names is not exported again. */
function forgotten(snapshot: GameSnapshot) {
  return Effect.map(Metric.MetricRegistry, (registry) =>
    [...registry]
      .filter(([, metadata]) => metadata.id === gameState.id && metadata.attributes?.["game"] === snapshot.id)
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

const gameState = Metric.gauge("sportal_game_state", {
  description: "A game's progress, by game: 1 upcoming, 2 live, 3 over; no series once no listing names it"
})
