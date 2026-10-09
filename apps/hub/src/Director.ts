import type { ChannelAvailability } from "@sportal/domain/Channel"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { Play } from "@sportal/domain/Play"
import { Screen, type ScreenCommand, type ScreenRejection } from "@sportal/domain/Screen"
import { Cause, Context, Effect, Layer, Metric, Option, Stream, SubscriptionRef } from "effect"
import * as HubStopping from "./HubStopping.ts"
import { type Delivery, Provider } from "./provider/Provider.ts"
import { Slate, SlateChange } from "./Slate.ts"
import { Source } from "./source/Source.ts"

/**
 * The Hub's one holder of what is going on: the day's slate, taken from each frame its provider decodes as it
 * arrives, and the Screen every Display shows, changed by commands against where each game on the slate can be
 * streamed now.
 */
export class Director extends Context.Service<
  Director,
  {
    readonly slate: Effect.Effect<Slate>
    /** The latest slate first, then each change. */
    readonly slateChanges: Stream.Stream<Slate>
    readonly screen: Effect.Effect<Screen>
    /** The latest Screen first, then each change. */
    readonly screenChanges: Stream.Stream<Screen>
    dispatch(command: ScreenCommand): Effect.Effect<Screen, ScreenRejection>
  }
>()("sportal/hub/Director") {
  /**
   * Takes what the provider decodes, from an empty slate, gauging each game a take changed by its progress, and
   * logging each play it adds, as the take says. A take that raises a defect is logged, and the slate keeps what it had; if the
   * provider's frames ever end other than by the Hub stopping, that is logged. Applies each command to the Screen
   * one at a time, and refreshes the Screen whenever the source's answers change.
   */
  static readonly layer: Layer.Layer<Director, never, Provider | Source> = Layer.effect(
    Director,
    Effect.gen(function* () {
      const provider = yield* Provider
      const source = yield* Source
      const slate = yield* SubscriptionRef.make(Slate.empty)
      const screen = yield* SubscriptionRef.make(Screen.initial)

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

      // Where each game on the current slate can be streamed; a game no longer on the slate has none.
      const availabilityOnSlate = Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(slate)
        const availabilityOf = yield* source.availability
        return (id: GameId): Option.Option<ReadonlyArray<ChannelAvailability>> =>
          Option.map(current.game(id), ({ snapshot }) => availabilityOf(snapshot))
      })

      const dispatch = Effect.fn("Director.dispatch")(function* (command: ScreenCommand) {
        // One atomic step: concurrent dispatches queue up, and a rejection leaves the Screen as it was.
        // Availability is read inside it, so a refresh that lands first is never overwritten with a stale read.
        return yield* SubscriptionRef.modifyEffect(screen, (current) =>
          Effect.gen(function* () {
            const availabilityOf = yield* availabilityOnSlate
            const result = current.apply(command, (id) => Option.getOrElse(availabilityOf(id), () => []))
            const next = yield* Effect.fromResult(result)
            return [next, next] as const
          })
        )
      })

      // When what the source answers changes, every tile it affects changes on every Display; nothing is published
      // when no tile changed.
      const refresh = SubscriptionRef.updateSomeEffect(screen, (current) =>
        availabilityOnSlate.pipe(
          Effect.map((availabilityOf) => {
            const next = current.refresh(availabilityOf)
            return next === current ? Option.none() : Option.some(next)
          })
        )
      )
      yield* Effect.forkScoped(source.changes.pipe(Stream.runForEach(() => refresh)), {
        startImmediately: true
      })

      return Director.of({
        slate: SubscriptionRef.get(slate),
        slateChanges: SubscriptionRef.changes(slate),
        screen: SubscriptionRef.get(screen),
        screenChanges: SubscriptionRef.changes(screen),
        dispatch
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

// Each progress's value on `sportal_game_state`. Written as a record so that a new progress fails to compile here.
const progressValues = { upcoming: 1, live: 2, over: 3 } satisfies Record<
  ReturnType<GameSnapshot["progress"]>,
  number
>

const gameState = Metric.gauge("sportal_game_state", {
  description: "A game's progress, by game: 1 upcoming, 2 live, 3 over, 0 once no listing names it"
})
