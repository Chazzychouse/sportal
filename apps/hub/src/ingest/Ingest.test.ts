import { assert, describe, it } from "@effect/vitest"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { LiveGameState } from "@sportal/domain/LiveGame"
import { snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Metric, Option, Queue, Ref, Schema, Stream, type Tracer } from "effect"
import { TestClock } from "effect/testing"
import { GameActors } from "../GameActors.ts"
import { LiveFeed, LiveFeedError } from "../provider/LiveFeed.ts"
import { Provider } from "../provider/Provider.ts"
import * as TestCluster from "../TestCluster.ts"
import { game, scripted } from "../TestProvider.ts"
import { counted, recordingLogs, recordingSpans, withMetrics } from "../TestTelemetry.ts"
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
  return Ingest.layer(["fbs"]).pipe(
    Layer.provideMerge(TestCluster.gameActors),
    Layer.provide([provider, LiveFeed.none])
  )
}

describe("Ingest", () => {
  it.effect("lists the provider's games in poll order, as the provider sent them", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const actors = yield* GameActors
      yield* TestClock.adjust(0)
      yield* actors.receive(game("1", 2), "poll")
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
          yield* actors.receive(game("1"), "poll")
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
          Layer.provide(Layer.succeed(GameActors, actors)),
          Layer.provide(LiveFeed.none)
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

  it.effect(
    "a pushed game reaches its actor between polls, named as the poll names it, at the push's clock",
    () =>
      Effect.gen(function* () {
        const feed = yield* Queue.unbounded<Delivery>()
        const subscriptions = yield* Ref.make(0)
        yield* Effect.provide(
          Effect.gen(function* () {
            const actors = yield* GameActors
            yield* TestClock.adjust(0)
            yield* Queue.offer(feed, [pushed("4:12", 7)])
            yield* TestClock.adjust("1 second")
            const live = (yield* actors.liveGames).get(GameId.make("1"))
            assert.strictEqual(live?.snapshot.clock, "4:12")
            assert.strictEqual(live?.snapshot.home.score, 7)
            assert.strictEqual(live?.snapshot.home.team.shortName, "MSST")
            assert.strictEqual(live?.snapshot.away.team.shortName, "ALA")
          }),
          feeding(scripted([[liveGame(0)]]), feed, subscriptions, [])
        )
      })
  )

  it.effect("a pushed game no listing has is not sent, and is counted", () =>
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<Delivery>()
      const subscriptions = yield* Ref.make(0)
      yield* Effect.provide(
        Effect.gen(function* () {
          const actors = yield* GameActors
          yield* TestClock.adjust(0)
          yield* Queue.offer(feed, [snapshot({ ...pushed("4:12", 7), id: GameId.make("9") })])
          yield* TestClock.adjust("1 second")
          assert.isFalse((yield* actors.liveGames).has(GameId.make("9")))
          assert.strictEqual(yield* counted("sportal_live_feed_unlisted", { league: "fbs" }), 1)
        }),
        feeding(scripted([[liveGame(0)]]), feed, subscriptions, [])
      )
    }).pipe(withMetrics)
  )

  it.effect(
    "a closed feed is subscribed again after about 1 s, then about 2 s, while the poll carries on",
    () =>
      Effect.gen(function* () {
        const feed = yield* Queue.unbounded<Delivery>()
        const subscriptions = yield* Ref.make(0)
        const polls = yield* Ref.make(0)
        const provider = Layer.succeed(
          Provider,
          Provider.of({ slate: () => Ref.update(polls, (n) => n + 1).pipe(Effect.as([liveGame(0)])) })
        )
        const closed = new LiveFeedError({ reason: "Closed", cause: "socket closed" })
        yield* Effect.provide(
          Effect.gen(function* () {
            yield* TestClock.adjust(0)
            assert.strictEqual(yield* Ref.get(subscriptions), 1)
            // Jitter scales each delay by 0.8 to 1.2: the first is within 0.8 s to 1.2 s, the second 1.6 s to 2.4 s.
            yield* Queue.offer(feed, closed)
            yield* TestClock.adjust("700 millis")
            assert.strictEqual(yield* Ref.get(subscriptions), 1)
            yield* TestClock.adjust("600 millis")
            assert.strictEqual(yield* Ref.get(subscriptions), 2)
            yield* Queue.offer(feed, closed)
            yield* TestClock.adjust("1500 millis")
            assert.strictEqual(yield* Ref.get(subscriptions), 2)
            yield* TestClock.adjust("1 second")
            assert.strictEqual(yield* Ref.get(subscriptions), 3)
            yield* TestClock.adjust("20 seconds")
            assert.isAtLeast(yield* Ref.get(polls), 3)
            assert.strictEqual(yield* counted("sportal_live_feed_errors", { reason: "Closed" }), 2)
          }),
          feeding(provider, feed, subscriptions, [])
        )
      }).pipe(withMetrics)
  )

  it.effect("a live feed that completes is logged at Error, and the poll carries on", () =>
    stopsAndPollsOn(Stream.empty, "the feed's stream ended")
  )

  it.effect("a live feed that dies is logged at Error with its defect, and the poll carries on", () =>
    stopsAndPollsOn(Stream.die("socket handler threw"), "socket handler threw")
  )

  it.effect("a push is one span, the parent of the receives it causes", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      const feed = yield* Queue.unbounded<Delivery>()
      const subscriptions = yield* Ref.make(0)
      yield* Effect.provide(
        Effect.gen(function* () {
          yield* TestClock.adjust(0)
          yield* Queue.offer(feed, [
            pushed("4:12", 7),
            snapshot({ ...pushed("4:12", 7), id: GameId.make("9") })
          ])
          yield* TestClock.adjust("1 second")
        }),
        feeding(scripted([[liveGame(0)]]), feed, subscriptions, ended)
      )
      const pushes = ended.filter((span) => span.name === "Ingest.push")
      assert.strictEqual(pushes.length, 1)
      const push = pushes[0]
      const receives = ended.filter(
        (span) =>
          span.name === "GameActors.receive" &&
          Option.exists(span.parent, (parent) => parent.spanId === push?.spanId)
      )
      assert.strictEqual(receives.length, 1)
      assert.deepStrictEqual(push?.attributes.get("sportal.leagues"), ["fbs"])
      assert.strictEqual(push?.attributes.get("sportal.games"), 2)
      assert.strictEqual(push?.attributes.get("sportal.unlisted"), 1)
    })
  })
})

/**
 * Runs Ingest over a live feed of `games`, which stops without failing, and checks the stop is logged once at Error
 * with `why`, and that polls go on.
 */
function stopsAndPollsOn(games: Stream.Stream<ReadonlyArray<GameSnapshot>>, why: string) {
  const { logs, layer } = recordingLogs()
  return Effect.gen(function* () {
    const polls = yield* Ref.make(0)
    const provider = Layer.succeed(
      Provider,
      Provider.of({ slate: () => Ref.update(polls, (n) => n + 1).pipe(Effect.as([liveGame(0)])) })
    )
    yield* Effect.provide(
      Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("20 seconds")
      }),
      Ingest.layer(["fbs"]).pipe(
        Layer.provide([
          provider,
          TestCluster.gameActors,
          Layer.succeed(LiveFeed, LiveFeed.of({ games: () => games }))
        ])
      )
    )
    const stopped = logs.filter(
      (log) => log.level === "Error" && log.message.includes("the live feed stopped")
    )
    assert.strictEqual(stopped.length, 1)
    assert.include(`${stopped[0]?.message} ${stopped[0]?.cause}`, why)
    assert.isAtLeast(yield* Ref.get(polls), 3)
  }).pipe(Effect.provide(layer))
}

/** Ingest of the fbs league over `provider`, with each span that ends recorded in `ended`. */
function polling(provider: Layer.Layer<Provider>, ended: Array<Tracer.Span>) {
  return Ingest.layer(["fbs"]).pipe(
    Layer.provide([provider, TestCluster.gameActors, LiveFeed.none]),
    Layer.provideMerge(recordingSpans(ended))
  )
}

/** What a test offers its live feed: a pushed batch, or the error that ends the feed's stream. */
type Delivery = ReadonlyArray<GameSnapshot> | LiveFeedError

/**
 * Ingest of the fbs league over `provider` and a live feed reading `feed`, counting each subscription to it in
 * `subscriptions`, with the game actors also provided to the test and each span that ends recorded in `ended`.
 */
function feeding(
  provider: Layer.Layer<Provider>,
  feed: Queue.Queue<Delivery>,
  subscriptions: Ref.Ref<number>,
  ended: Array<Tracer.Span>
) {
  const liveFeed = LiveFeed.of({
    games: () =>
      Stream.unwrap(
        Ref.update(subscriptions, (n) => n + 1).pipe(
          Effect.as(
            Stream.fromQueue(feed).pipe(
              Stream.mapEffect((delivery) =>
                Schema.is(LiveFeedError)(delivery) ? Effect.fail(delivery) : Effect.succeed(delivery)
              )
            )
          )
        )
      )
  })
  return Ingest.layer(["fbs"]).pipe(
    Layer.provideMerge(TestCluster.gameActors),
    Layer.provide([provider, Layer.succeed(LiveFeed, liveFeed)]),
    Layer.provideMerge(recordingSpans(ended))
  )
}

/** A push of game "1", as FastCast names it, at `clock` with the home side on `homeScore`. */
function pushed(clock: string, homeScore: number) {
  return snapshot({
    status: "live",
    period: 1,
    clock,
    home: { team: team("MSST", "fbs", { shortName: "Pushed name" }), score: homeScore },
    away: { team: team("ALA", "fbs", { shortName: "Pushed name" }), score: 0 }
  })
}

/** The listing Ingest has published most recently. */
function listing(ingest: Ingest["Service"]) {
  return Stream.runHead(ingest.listed).pipe(
    Effect.map(Option.getOrElse((): ReadonlyArray<GameSnapshot> => []))
  )
}
