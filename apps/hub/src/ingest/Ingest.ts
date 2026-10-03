import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Context, DateTime, Effect, Layer, type Stream, SubscriptionRef } from "effect"
import { Provider } from "../provider/Provider.ts"
import * as Cadence from "./Cadence.ts"

export class Ingest extends Context.Service<
  Ingest,
  {
    readonly slate: Effect.Effect<ReadonlyArray<GameSnapshot>>
    readonly changes: Stream.Stream<ReadonlyArray<GameSnapshot>>
  }
>()("sportal/hub/Ingest") {
  static readonly layer = (leagues: ReadonlyArray<LeagueId>) =>
    Layer.effect(
      Ingest,
      Effect.gen(function* () {
        const provider = yield* Provider
        const current = yield* SubscriptionRef.make<ReadonlyArray<GameSnapshot>>([])
        // The last good slate per league, so one league failing does not blank the other.
        const byLeague = new Map<LeagueId, ReadonlyArray<GameSnapshot>>()

        const poll = Effect.gen(function* () {
          let anyFailed = false
          for (const league of leagues) {
            yield* provider.slate(league).pipe(
              Effect.map((slate) => byLeague.set(league, slate)),
              Effect.catchTag("ProviderError", (error) => {
                anyFailed = true
                return Effect.logWarning(
                  "Ingest: provider failed; keeping the last good slate for this league, if any",
                  error
                )
              })
            )
          }
          const slate = leagues.flatMap((league) => byLeague.get(league) ?? [])
          yield* SubscriptionRef.set(current, slate)
          yield* Effect.sleep(Cadence.interval(slate, yield* DateTime.now, anyFailed))
        })

        yield* Effect.forkScoped(Effect.forever(poll))

        return Ingest.of({
          slate: SubscriptionRef.get(current),
          changes: SubscriptionRef.changes(current)
        })
      })
    )
}
