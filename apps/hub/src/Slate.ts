import type { GameSnapshot } from "@sportal/domain/Game"
import { LiveGame } from "@sportal/domain/LiveGame"
import { Watchability } from "@sportal/domain/Watchability"
import { Context, DateTime, Effect, Layer, Metric, Stream, SubscriptionRef } from "effect"
import { GameActors } from "./GameActors.ts"
import { Ingest } from "./ingest/Ingest.ts"

/**
 * The current slate and every game's watchability: each listed game as its actor has it, published on every listing
 * and every burst of actor changes. A burst settles after 250 ms with no new listing or actor change, on the layer's
 * clock; changes arriving more often than that, without a pause, publish nothing until they pause.
 */
export class Slate extends Context.Service<
  Slate,
  {
    readonly latest: Effect.Effect<{
      readonly slate: ReadonlyArray<GameSnapshot>
      readonly watchability: ReadonlyArray<Watchability>
    }>
    /** The latest first, then each new one. */
    readonly changes: Stream.Stream<{
      readonly slate: ReadonlyArray<GameSnapshot>
      readonly watchability: ReadonlyArray<Watchability>
    }>
  }
>()("sportal/hub/Slate") {
  static readonly layer = Layer.effect(
    Slate,
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const gameActors = yield* GameActors
      const state = yield* SubscriptionRef.make<{
        readonly slate: ReadonlyArray<GameSnapshot>
        readonly watchability: ReadonlyArray<Watchability>
      }>({ slate: [], watchability: [] })
      yield* Effect.forkScoped(
        Stream.zipLatestWith(ingest.listed, gameActors.changes, LiveGame.asActorsHaveThem).pipe(
          Stream.debounce("250 millis"),
          Stream.runForEach((slate) =>
            DateTime.now.pipe(
              Effect.flatMap((now) =>
                SubscriptionRef.updateEffect(state, (current) => {
                  const watchability = Watchability.fold(current, slate, now)
                  return report(current.watchability, slate, watchability).pipe(
                    Effect.as({ slate, watchability })
                  )
                })
              )
            )
          )
        ),
        { startImmediately: true }
      )
      return Slate.of({ latest: SubscriptionRef.get(state), changes: SubscriptionRef.changes(state) })
    })
  )
}

/** Gauges each game's watchability and lull, and logs a lull beginning or ending at Info, with its reasons. */
function report(
  previous: ReadonlyArray<Watchability>,
  slate: ReadonlyArray<GameSnapshot>,
  watchability: ReadonlyArray<Watchability>
): Effect.Effect<void> {
  return Effect.forEach(
    watchability,
    (judged, index) => {
      const game = slate[index]
      if (game === undefined) return Effect.void
      const attributes = GameActors.annotationsOf(game.id, game)
      const before = previous.find((candidate) => candidate.game === judged.game)
      const changed = before !== undefined && before.lull !== judged.lull
      return Effect.all([
        Metric.update(Metric.withAttributes(watchabilityScore, attributes), judged.score),
        Metric.update(Metric.withAttributes(lulls, attributes), judged.lull ? 1 : 0),
        changed
          ? Effect.logInfo(
              `Slate: ${game.matchup()}: a lull ${judged.lull ? "began" : "ended"}, watchability ${judged.score}${
                judged.reasons.length === 0 ? "" : ` (${judged.reasons.join(", ")})`
              }`
            ).pipe(Effect.annotateLogs(attributes))
          : Effect.void
      ])
    },
    { discard: true }
  )
}

const watchabilityScore = Metric.gauge("sportal_watchability", {
  description: "How worth watching a game is, 0–100, by game"
})

const lulls = Metric.gauge("sportal_lull", {
  description: "Whether a game is in a lull (1) or not (0), by game"
})
