import { assert, describe, it } from "@effect/vitest"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { LiveGameState } from "@sportal/domain/LiveGame"
import { snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Metric, Option, Ref, Stream, type Tracer } from "effect"
import { TestClock } from "effect/testing"
import { GameActors } from "../GameActors.ts"
import { Provider } from "../provider/Provider.ts"
import * as TestCluster from "../TestCluster.ts"
import { game, scripted } from "../TestProvider.ts"
import { recordingSpans, withMetrics } from "../TestTelemetry.ts"
import { Ingest } from "./Ingest.ts"

function liveGame(homeScore: number) {
  return snapshot({
    status: "live",
    period: 1,
    clock: "10:00",
    home: { team: team("MSST"), score: homeScore },
    away: { team: team("ALA"), score: 0 }
  })
}

/** Ingest of the fbs league over `provider`, with the game actors it sends to also provided to the test. */
function withActors(provider: Layer.Layer<Provider>) {
  return Ingest.layer(["fbs"]).pipe(Layer.provideMerge(TestCluster.gameActors), Layer.provide(provider))
}

describe("Ingest", () => {
  it.effect("lists the provider's games in poll order, as the provider sent them", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const actors = yield* GameActors
      yield* TestClock.adjust(0)
      yield* actors.receive(game("1", 2))
      assert.deepStrictEqual(
        (yield* listing(ingest)).map((listed) => [listed.id, listed.period]),
        [
          ["3", 1],
          ["1", 1],
          ["2", 1]
        ]
      )
    }).pipe(Effect.provide(withActors(scripted([[game("3"), game("1"), game("2")]]))))
  )

  it.effect("lists on every poll, even one that changes nothing", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const seen = yield* Ref.make<ReadonlyArray<number>>([])
      yield* ingest.listed.pipe(
        Stream.runForEach((games) => Ref.update(seen, (all) => [...all, games.length])),
        Effect.forkScoped
      )
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")
      yield* TestClock.adjust("10 seconds")
      assert.deepStrictEqual(yield* Ref.get(seen), [1, 1, 1])
    }).pipe(Effect.provide(withActors(scripted([[game("1")], [game("1")]]))))
  )

  it.effect("polls at the live cadence once an actor holds the game live", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const actors = yield* GameActors
      const now = yield* DateTime.now
      const scheduled = snapshot({
        id: GameId.make("1"),
        status: "scheduled",
        kickoff: DateTime.add(now, { hours: 2 })
      })
      yield* Effect.provide(
        Effect.gen(function* () {
          yield* Ingest
          yield* TestClock.adjust(0)
          yield* actors.receive(game("1"))
          // The scheduled cadence the listing alone would give.
          yield* TestClock.adjust("15 minutes")
          assert.strictEqual(yield* Ref.get(calls), 2)
          yield* TestClock.adjust("10 seconds")
          assert.strictEqual(yield* Ref.get(calls), 3)
        }),
        Ingest.layer(["fbs"]).pipe(
          Layer.provide(
            Layer.succeed(
              Provider,
              Provider.of({ slate: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as([scheduled])) })
            )
          ),
          Layer.provide(Layer.succeed(GameActors, actors))
        )
      )
    }).pipe(Effect.provide(TestCluster.gameActors))
  )

  it.effect("polls again after the live cadence and lists the new games", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      yield* TestClock.adjust(0)
      assert.strictEqual((yield* listing(ingest))[0]?.home.score, 0)

      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* listing(ingest))[0]?.home.score, 7)
    }).pipe(Effect.provide(withActors(scripted([[liveGame(0)], [liveGame(7)]]))))
  )

  it.effect("keeps the last listing when the provider fails", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* listing(ingest))[0]?.home.score, 7)
    }).pipe(Effect.provide(withActors(scripted([[liveGame(7)], "fail"]))))
  )

  it.effect("retries after 30 seconds when the first poll fails", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      yield* TestClock.adjust(0)
      assert.strictEqual((yield* listing(ingest)).length, 0)

      yield* TestClock.adjust("30 seconds")
      assert.strictEqual((yield* listing(ingest))[0]?.home.score, 3)
    }).pipe(Effect.provide(withActors(scripted(["fail", [liveGame(3)]]))))
  )

  it.effect("a poll's snapshots reach the actors", () =>
    Effect.gen(function* () {
      const actors = yield* GameActors
      yield* TestClock.adjust(0)
      assert.deepStrictEqual([...(yield* actors.liveGames).keys()].sort(), ["1", "2", "3"])
    }).pipe(Effect.provide(withActors(scripted([[game("3"), game("1"), game("2")]]))))
  )

  it.effect("a failed league's games are not resent", () =>
    Effect.gen(function* () {
      const actors = yield* GameActors
      const ingest = yield* Ingest
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("90 seconds")
      assert.isTrue(
        Option.exists(Option.fromNullishOr((yield* actors.liveGames).get(GameId.make("1"))), (liveGame) =>
          LiveGameState.$is("Stale")(liveGame.state)
        )
      )
      assert.strictEqual((yield* listing(ingest))[0]?.period, 2)
    }).pipe(Effect.provide(withActors(scripted([[game("1", 2)], "fail"]))))
  )

  it.effect("a poll is one span, ended before the poll sleeps, with the provider's span inside it", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* Ingest
      yield* TestClock.adjust(0)
      const polls = ended.filter((span) => span.name === "Ingest.poll")
      assert.strictEqual(polls.length, 1)
      const poll = polls[0]
      const slate = ended.find((span) => span.name === "provider.slate")
      assert.strictEqual(
        slate?.parent.pipe(
          Option.map((parent) => parent.spanId),
          Option.getOrUndefined
        ),
        poll?.spanId
      )
      assert.deepStrictEqual(poll?.attributes.get("sportal.leagues"), ["fbs"])
      assert.deepStrictEqual(poll?.attributes.get("sportal.failed_leagues"), [])
    }).pipe(Effect.provide(polling(scripted([[liveGame(0)]]), ended)))
  })

  it.effect("a failed league is on the span and counted", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* Ingest
      yield* TestClock.adjust(0)
      const poll = ended.find((span) => span.name === "Ingest.poll")
      assert.deepStrictEqual(poll?.attributes.get("sportal.failed_leagues"), ["fbs"])
      const errors = (yield* Metric.snapshot).find(
        (metric) => metric.id === "sportal_provider_errors" && metric.attributes?.league === "fbs"
      )
      assert.deepStrictEqual(errors?.type === "Counter" ? errors.state.count : undefined, 1)
    }).pipe(Effect.provide(polling(scripted(["fail"]), ended)), withMetrics)
  })

  it.effect("each poll records its duration", () =>
    Effect.gen(function* () {
      yield* Ingest
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")
      const duration = (yield* Metric.snapshot).find((metric) => metric.id === "sportal_poll_duration")
      assert.strictEqual(duration?.type === "Histogram" ? duration.state.count : undefined, 2)
    }).pipe(Effect.provide(polling(scripted([[liveGame(0)], [liveGame(7)]]), [])), withMetrics)
  )
})

/** Ingest of the fbs league over `provider`, with each span that ends recorded in `ended`. */
function polling(provider: Layer.Layer<Provider>, ended: Array<Tracer.Span>) {
  return Ingest.layer(["fbs"]).pipe(
    Layer.provide([provider, TestCluster.gameActors]),
    Layer.provideMerge(recordingSpans(ended))
  )
}

/** The listing Ingest has published most recently. */
function listing(ingest: Ingest["Service"]) {
  return Stream.runHead(ingest.listed).pipe(
    Effect.map(Option.getOrElse((): ReadonlyArray<GameSnapshot> => []))
  )
}
