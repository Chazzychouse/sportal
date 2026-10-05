import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { LiveGame } from "@sportal/domain/LiveGame"
import { Context, DateTime, Effect, Layer, Metric, Result, type Stream, SubscriptionRef } from "effect"
import { GameActors } from "../GameActors.ts"
import { Provider } from "../provider/Provider.ts"
import * as Cadence from "./Cadence.ts"

/** Polls each league at the Cadence, keeping its last good listing, and sends what it got to the game actors. */
export class Ingest extends Context.Service<
  Ingest,
  {
    /** What the leagues last listed, in poll order, on every poll even when nothing changed. */
    readonly listed: Stream.Stream<ReadonlyArray<GameSnapshot>>
  }
>()("sportal/hub/Ingest") {
  static readonly layer = (leagues: ReadonlyArray<LeagueId>) =>
    Layer.effect(
      Ingest,
      Effect.gen(function* () {
        const provider = yield* Provider
        const gameActors = yield* GameActors
        const listed = yield* SubscriptionRef.make<ReadonlyArray<GameSnapshot>>([])
        // The last good slate per league, so one league failing does not blank the other.
        const byLeague = new Map<LeagueId, ReadonlyArray<GameSnapshot>>()

        const poll = Effect.fn("Ingest.poll")(function* () {
          const results = yield* Effect.forEach(leagues, (league) =>
            provider.slate(league).pipe(
              Effect.tap((slate) => Effect.sync(() => byLeague.set(league, slate))),
              Effect.tapError((error) =>
                Effect.logWarning(
                  "Ingest: provider failed; keeping the last good slate for this league, if any",
                  error
                ).pipe(Effect.andThen(Metric.update(Metric.withAttributes(providerErrors, { league }), 1)))
              ),
              Effect.result
            )
          )
          const failed = results.filter(Result.isFailure).map((result) => result.failure.league)
          const games = leagues.flatMap((league) => byLeague.get(league) ?? [])
          // Only this poll's games: a failed league's kept games are not resent, so their actors go stale.
          yield* Effect.forEach(
            results.filter(Result.isSuccess).flatMap((result) => result.success),
            gameActors.receive,
            { concurrency: "unbounded", discard: true }
          )
          yield* SubscriptionRef.set(listed, games)
          yield* Effect.annotateCurrentSpan({ "sportal.leagues": leagues, "sportal.failed_leagues": failed })
          const live = yield* gameActors.liveGames
          return { slate: LiveGame.asActorsHaveThem(games, live), failed }
        }, Effect.trackDuration(pollDuration))

        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const { slate, failed } = yield* poll()
              yield* Effect.sleep(Cadence.interval(slate, yield* DateTime.now, failed.length > 0))
            })
          )
        )

        return Ingest.of({ listed: SubscriptionRef.changes(listed) })
      })
    )
}

const pollDuration = Metric.timer("sportal_poll_duration", {
  description: "How long one poll of every league takes"
})

const providerErrors = Metric.counter("sportal_provider_errors", {
  description: "Polls in which a league's provider failed",
  incremental: true
})
