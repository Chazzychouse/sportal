import { LiveMessage, type SlateChanged } from "@sportal/api/LiveMessage"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { Play } from "@sportal/domain/Play"
import { Cause, Context, Effect, Layer, Metric, Schema, Stream, SubscriptionRef } from "effect"
import * as HubStopping from "./HubStopping.ts"
import { type Delivery, Provider } from "./provider/Provider.ts"
import { Slate, SlateChange } from "./Slate.ts"
import { Source } from "./source/Source.ts"

/**
 * The Hub's one holder of what is going on: the day's slate, taken from each frame its provider decodes as it
 * arrives, and published beside where each game can be streamed now.
 */
export class Director extends Context.Service<
  Director,
  {
    readonly slate: Effect.Effect<Slate>
    /**
     * The slate as the live stream sends it, beside each game's availability: the latest first, then again whenever
     * the slate or any game's availability changes.
     */
    readonly published: Stream.Stream<SlateChanged>
  }
>()("sportal/hub/Director") {
  /**
   * Takes what the provider decodes, from an empty slate, gauging each game a take changed by its progress, and
   * logging each play it adds, as the take says. A take that raises a defect is logged, and the slate keeps what it
   * had; if the provider's frames ever end other than by the Hub stopping, that is logged. Publishes the slate beside
   * every source's answer for each game whenever either changes.
   */
  static readonly layer: Layer.Layer<Director, never, Provider | Source> = Layer.effect(
    Director,
    Effect.gen(function* () {
      const provider = yield* Provider
      const source = yield* Source
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

      // Whenever the slate changes, or the source's answers may have: the slate as it is now.
      const slateOrAnswers = Stream.merge(
        SubscriptionRef.changes(slate).pipe(Stream.map(() => undefined)),
        source.changes
      ).pipe(Stream.mapEffect(() => SubscriptionRef.get(slate)))
      const published = slateOrAnswers.pipe(
        Stream.mapEffect((current) =>
          Effect.map(source.availability, (availabilityOf) => current.published(availabilityOf))
        ),
        Stream.changesWith(samePublished)
      )

      return Director.of({
        slate: SubscriptionRef.get(slate),
        published
      })
    })
  )
}

/** A change the slate took, observed: a game's progress gauged (0 once delisted), or a play it added logged. */
function observed(change: SlateChange) {
  return SlateChange.$match(change, {
    Progressed: ({ game }) => gauge(game.snapshot, progressValues[game.snapshot.progress()]),
    Delisted: ({ game }) => gauge(game.snapshot, 0),
    Played: ({ game, play }) => loggedPlay(game.snapshot, play)
  })
}

function gauge(snapshot: GameSnapshot, value: number) {
  const attributes = { game: snapshot.id, league: snapshot.league, matchup: snapshot.matchup() }
  return Metric.update(Metric.withAttributes(gameState, attributes), value)
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

const samePublished = Schema.toEquivalence(LiveMessage.cases.SlateChanged)

// Each progress's value on `sportal_game_state`. Written as a record so that a new progress fails to compile here.
const progressValues = { upcoming: 1, live: 2, over: 3 } satisfies Record<
  ReturnType<GameSnapshot["progress"]>,
  number
>

const gameState = Metric.gauge("sportal_game_state", {
  description: "A game's progress, by game: 1 upcoming, 2 live, 3 over, 0 once no listing names it"
})
