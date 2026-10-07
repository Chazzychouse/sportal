import type { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import type { RecentPlays } from "@sportal/domain/RecentPlays"
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"
import { LiveGames } from "./LiveGames.ts"

/**
 * The current slate: each listed game, leagues in order, as the fold has it (a game the fold does not hold, one not
 * yet current or over, as listed), published on every burst of changes to the fold. A burst settles after 250 ms with
 * no further change, on the layer's clock; changes arriving more often than that, without a pause, publish nothing
 * until they pause. Each game's last ten plays are published beside it, from the same fold.
 */
export class Slate extends Context.Service<
  Slate,
  {
    readonly latest: Effect.Effect<{
      readonly games: ReadonlyArray<GameSnapshot>
      readonly recentPlays: RecentPlays
    }>
    /** The latest first, then each new one. */
    readonly changes: Stream.Stream<{
      readonly games: ReadonlyArray<GameSnapshot>
      readonly recentPlays: RecentPlays
    }>
  }
>()("sportal/hub/Slate") {
  static readonly layer: Layer.Layer<Slate, never, LiveGames> = Layer.effect(
    Slate,
    Effect.gen(function* () {
      const liveGames = yield* LiveGames
      const state = yield* SubscriptionRef.make<{
        readonly games: ReadonlyArray<GameSnapshot>
        readonly recentPlays: RecentPlays
      }>({ games: [], recentPlays: {} })
      yield* Effect.forkScoped(
        liveGames.changes.pipe(
          Stream.debounce("250 millis"),
          Stream.runForEach((folded) =>
            SubscriptionRef.set(state, {
              games: folded.slate(LeagueId.literals),
              recentPlays: folded.recentPlays(LeagueId.literals)
            })
          )
        ),
        { startImmediately: true }
      )
      return Slate.of({ latest: SubscriptionRef.get(state), changes: SubscriptionRef.changes(state) })
    })
  )
}
