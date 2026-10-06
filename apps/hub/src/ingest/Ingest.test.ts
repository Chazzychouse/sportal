import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { LiveGameState } from "@sportal/domain/LiveGame"
import { snapshot, team } from "@sportal/domain/TestGame"
import {
  Context,
  type Crypto,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  Queue,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Stream,
  type Tracer
} from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import * as Database from "../Database.ts"
import { FeedLog } from "../feed-log/FeedLog.ts"
import type { Frame } from "../feed-log/Frame.ts"
import { GameHistory } from "../GameHistory.ts"
import { LiveGames } from "../LiveGames.ts"
import { LiveFeed, LiveFeedError } from "../provider/LiveFeed.ts"
import { Decoded, Provider, ProviderError } from "../provider/Provider.ts"
import { game, neverPushing, polling, pushed, scripted } from "../provider/TestProvider.ts"
import { counted, recordingLogs, recordingSpans, withMetrics } from "../TestTelemetry.ts"
import { dayStart, Ingest } from "./Ingest.ts"

describe("Ingest", () => {
  it.effect("each poll appends one frame per league, then its listing reaches the fold", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      const folded = yield* (yield* LiveGames).latest
      yield* TestClock.adjust("100 millis")
      const logged = yield* logOf(2)

      assert.deepStrictEqual(
        logged.map(({ seq, feed, channel }) => [seq, feed, channel]),
        [
          [1, "poll", "nfl"],
          [2, "poll", "fbs"]
        ]
      )
      assert.deepStrictEqual(folded.seq, Option.some(2))
      assert.deepStrictEqual(
        [...folded.listed].map(([league, games]) => [league, games.map((listed) => listed.id)]),
        [
          ["nfl", ["1"]],
          ["fbs", ["1"]]
        ]
      )
    }).pipe(Effect.provide(ingesting(scripted([[game("1")]]), { leagues: ["nfl", "fbs"] })))
  )

  it.effect("polls at the live cadence once the fold holds the game live", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const now = yield* DateTime.now
      const scheduled = snapshot({
        id: GameId.make("1"),
        status: "scheduled",
        kickoff: DateTime.add(now, { hours: 2 })
      })
      yield* Effect.gen(function* () {
        const liveGames = yield* LiveGames
        yield* TestClock.adjust(0)
        yield* liveGames.take(
          Delivery.Snapshot({ snapshot: game("1"), from: "push" }),
          yield* DateTime.now,
          Option.none()
        )
        // The scheduled cadence the listing alone would give.
        yield* TestClock.adjust("15 minutes")
        assert.strictEqual(yield* Ref.get(calls), 2)
        yield* TestClock.adjust("10 seconds")
        assert.strictEqual(yield* Ref.get(calls), 3)
      }).pipe(
        Effect.provide(
          ingesting(
            Layer.succeed(
              Provider,
              polling(() => Ref.update(calls, (n) => n + 1).pipe(Effect.as([scheduled])))
            )
          )
        )
      )
    })
  )

  it.effect("polls again after the live cadence, and the new listing reaches the fold", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      assert.strictEqual((yield* slateOf())[0]?.home.score, 0)

      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* slateOf())[0]?.home.score, 7)
    }).pipe(Effect.provide(ingesting(scripted([[liveGame(0)], [liveGame(7)]]))))
  )

  it.effect("a failed league appends nothing and keeps its last listing in the fold", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")
      yield* TestClock.adjust("100 millis")

      assert.strictEqual((yield* slateOf())[0]?.home.score, 7)
      assert.lengthOf(yield* logOf(1), 1)
    }).pipe(Effect.provide(ingesting(scripted([[liveGame(7)], "fail"]))))
  )

  it.effect("a failed league's game goes stale in the fold, its listing kept", () =>
    Effect.gen(function* () {
      const liveGames = yield* LiveGames
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("90 seconds")
      const folded = yield* liveGames.latest

      assert.isTrue(
        Option.exists(Option.fromNullishOr(folded.live.get(GameId.make("1"))), (liveGame) =>
          LiveGameState.$is("Stale")(liveGame.state)
        )
      )
      assert.strictEqual((yield* slateOf())[0]?.period, 2)
    }).pipe(Effect.provide(ingesting(scripted([[game("1", 2)], "fail"]))))
  )

  it.effect("retries after 30 seconds when the first poll fails", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      assert.lengthOf(yield* slateOf(), 0)

      yield* TestClock.adjust("30 seconds")
      assert.strictEqual((yield* slateOf())[0]?.home.score, 3)
    }).pipe(Effect.provide(ingesting(scripted(["fail", [liveGame(3)]]))))
  )

  it.effect("a poll is one span, ended before the poll sleeps, with the provider's span inside it", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* TestClock.adjust(0)
      const polls = ended.filter((span) => span.name === "Ingest.poll")
      assert.strictEqual(polls.length, 1)
      const poll = polls[0]
      const provider = ended.find((span) => span.name === "provider.poll")
      assert.strictEqual(
        provider?.parent.pipe(
          Option.map((parent) => parent.spanId),
          Option.getOrUndefined
        ),
        poll?.spanId
      )
      assert.deepStrictEqual(poll?.attributes.get("sportal.leagues"), ["fbs"])
      assert.deepStrictEqual(poll?.attributes.get("sportal.failed_leagues"), [])
    }).pipe(Effect.provide(ingesting(scripted([[liveGame(0)]]), { ended })))
  })

  it.effect("a failed league is on the span and counted", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* TestClock.adjust(0)
      const poll = ended.find((span) => span.name === "Ingest.poll")
      assert.deepStrictEqual(poll?.attributes.get("sportal.failed_leagues"), ["fbs"])
      assert.strictEqual(yield* counted("sportal_provider_errors", { league: "fbs" }), 1)
    }).pipe(Effect.provide(ingesting(scripted(["fail"]), { ended })), withMetrics)
  })

  it.effect("each poll records its duration", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")
      const duration = (yield* Metric.snapshot).find((metric) => metric.id === "sportal_poll_duration")
      assert.strictEqual(duration?.type === "Histogram" ? duration.state.count : undefined, 2)
    }).pipe(Effect.provide(ingesting(scripted([[liveGame(0)], [liveGame(7)]]))), withMetrics)
  )

  it.effect("a frame the live feed gives is appended and its delivery taken", () =>
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<Offered>()
      const subscriptions = yield* Ref.make(0)
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* Queue.offer(feed, yield* pushed([liveGame(7)]))
        yield* TestClock.adjust("100 millis")

        assert.strictEqual((yield* slateOf())[0]?.home.score, 7)
        assert.deepStrictEqual(
          (yield* logOf(2)).map(({ seq, feed }) => [seq, feed]),
          [
            [1, "poll"],
            [2, "fastcast"]
          ]
        )
      }).pipe(
        Effect.provide(ingesting(scripted([[liveGame(0)]]), { liveFeed: feeding(feed, subscriptions) }))
      )
    })
  )

  it.effect("a channel the decoder resyncs reaches the live feed", () =>
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<Offered>()
      const resynced = yield* Ref.make<ReadonlyArray<string>>([])
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* Queue.offer(feed, yield* pushed([], "gp-football-college-football-1"))
        yield* TestClock.adjust(0)

        assert.deepStrictEqual(yield* Ref.get(resynced), ["gp-football-college-football-1"])
      }).pipe(
        Effect.provide(
          ingesting(scripted([[liveGame(0)]]), {
            liveFeed: LiveFeed.of({
              frames: (_leagues, _wanted, resync) =>
                Stream.fromQueue(feed).pipe(
                  Stream.filterMap((offered) =>
                    Schema.is(LiveFeedError)(offered) ? Result.failVoid : Result.succeed(offered)
                  ),
                  Stream.merge(
                    resync.pipe(
                      Stream.mapEffect((channel) => Ref.update(resynced, (all) => [...all, channel])),
                      Stream.drain
                    )
                  )
                )
            })
          })
        )
      )
    })
  )

  it.effect("wants a game once it is current, and not before", () =>
    Effect.gen(function* () {
      const wanted = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
      const now = yield* DateTime.now
      const scheduled = snapshot({
        id: GameId.make("1"),
        status: "scheduled",
        kickoff: DateTime.add(now, { hours: 2 })
      })
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("89 minutes")
        assert.deepStrictEqual(yield* Ref.get(wanted), [[]])

        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Ref.get(wanted), [[], ["1"]])
      }).pipe(
        Effect.provide(
          ingesting(scripted([[scheduled]]), {
            liveFeed: LiveFeed.of({
              frames: (_leagues, current) =>
                current.pipe(
                  Stream.mapEffect((games) =>
                    Ref.update(wanted, (all) => [...all, games.map((wantedGame) => wantedGame.id)])
                  ),
                  Stream.drain,
                  Stream.concat(Stream.never)
                )
            })
          })
        )
      )
    })
  )

  it.effect(
    "a closed feed is subscribed again after about 1 s, then about 2 s, while the poll carries on",
    () =>
      Effect.gen(function* () {
        const feed = yield* Queue.unbounded<Offered>()
        const subscriptions = yield* Ref.make(0)
        const polls = yield* Ref.make(0)
        const provider = Layer.succeed(
          Provider,
          polling(() => Ref.update(polls, (n) => n + 1).pipe(Effect.as([liveGame(0)])))
        )
        const closed = new LiveFeedError({ reason: "Closed", cause: "socket closed" })
        yield* Effect.gen(function* () {
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
        }).pipe(Effect.provide(ingesting(provider, { liveFeed: feeding(feed, subscriptions) })))
      }).pipe(withMetrics)
  )

  it.effect("a live feed that completes is logged at Error, and the poll carries on", () =>
    stopsAndPollsOn(Stream.empty, "the feed's stream ended")
  )

  it.effect("a live feed that dies is logged at Error with its defect, and the poll carries on", () =>
    stopsAndPollsOn(Stream.die("socket handler threw"), "socket handler threw")
  )

  it.effect("stopping logs no Error", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("10 seconds")
      }).pipe(Effect.provide(ingesting(scripted([[liveGame(0)]]))))

      assert.deepStrictEqual(
        logs.filter((log) => log.level === "Error").map((log) => log.message),
        []
      )
    }).pipe(Effect.provide(layer))
  })

  it.live(
    "closes within the feed log's shutdown bound, with every frame appended just before it written",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        // The live day's layers, as HubMode builds them, over a provider with one live game and no live feed.
        const scope = yield* Scope.make()
        const services = yield* Layer.buildWithScope(
          Layer.effectDiscard(Layer.build(GameHistory.layer)).pipe(
            Layer.provideMerge(over(scripted([[liveGame(0)]])))
          ),
          scope
        )
        const log = Context.get(services, FeedLog)
        // Far more than the 100 ms the writer could be behind by when the Hub stops.
        yield* Effect.forEach(
          Array.from({ length: 200 }, (_, index) => index),
          (index) => Effect.flatMap(pushed([liveGame(index)]), log.append),
          { discard: true }
        )

        const [took] = yield* Effect.timed(Scope.close(scope, Exit.void))

        assert.isBelow(Duration.toMillis(took), Duration.toMillis(Duration.seconds(1)))
        const [row] = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM feed_frame WHERE feed = 'fastcast'
        `
        assert.strictEqual(row?.count, 200)
      }).pipe(Effect.provide([Database.layer(":memory:"), NodeCrypto.layer])),
    10_000
  )

  it.effect(
    "replays the day's logged frames into the fold before it is built, quietly, then appends after them",
    () => {
      const ended: Array<Tracer.Span> = []
      const { logs, layer: logged } = recordingLogs()
      return Effect.gen(function* () {
        yield* loggedBefore([pollOf([game("1", 2)]), pollOf([game("1", 3)])])

        yield* Effect.gen(function* () {
          const replayed = yield* (yield* LiveGames).latest
          assert.deepStrictEqual(replayed.seq, Option.some(2))
          assert.strictEqual(replayed.live.get(GameId.make("1"))?.snapshot.period, 3)
          assert.isUndefined(yield* counted("sportal_snapshots"))
          assert.isFalse(logs.some((log) => log.message.includes("started")))
          const replay = ended.find((span) => span.name === "Ingest.replay")
          assert.strictEqual(replay?.attributes.get("sportal.frames"), 2)
          assert.strictEqual(replay?.attributes.get("sportal.deliveries"), 2)

          yield* TestClock.adjust(0)
          const polled = yield* (yield* LiveGames).latest
          assert.deepStrictEqual(polled.seq, Option.some(3))
          assert.strictEqual(polled.live.get(GameId.make("1"))?.snapshot.period, 4)
        }).pipe(Effect.provide(over(scripted([[game("1", 4)]]), { ended })), Effect.provide(logged))
      }).pipe(Effect.provide([Database.layer(":memory:"), NodeCrypto.layer]), withMetrics)
    }
  )

  it.effect("a frame appended the moment the replay ends, before anything else runs, reaches the fold", () =>
    Effect.gen(function* () {
      yield* loggedBefore([pollOf([game("1", 2)])])
      // The log's replay appends a frame as it ends, so it is in the log before decoding reaches the end of the replay.
      const appendingAtEnd = Layer.effect(
        FeedLog,
        Effect.map(FeedLog, (log) =>
          FeedLog.of({
            ...log,
            replay: (from) =>
              log
                .replay(from)
                .pipe(
                  Stream.concat(
                    Stream.fromEffect(Effect.flatMap(pushed([game("1", 3)]), log.append)).pipe(Stream.drain)
                  )
                )
          })
        )
      ).pipe(Layer.provide(FeedLog.layer))

      yield* Effect.gen(function* () {
        const folded = yield* foldedThrough(2)
        assert.strictEqual(folded.live.get(GameId.make("1"))?.snapshot.period, 3)
      }).pipe(Effect.provide(over(scripted([]), { feedLog: appendingAtEnd })))
    }).pipe(Effect.provide([Database.layer(":memory:"), NodeCrypto.layer]))
  )

  it.effect("the decoder's state from the replayed frames is in effect for the first live frame", () =>
    Effect.gen(function* () {
      yield* loggedBefore([pollOf([]), pollOf([])])

      yield* Effect.gen(function* () {
        const frame = yield* (yield* FeedLog).append(yield* pushed([]))
        const folded = yield* foldedThrough(frame.seq)
        assert.deepStrictEqual(
          [...folded.live.values()].map((held) => held.snapshot.home.score),
          [3]
        )
      }).pipe(Effect.provide(over(Layer.succeed(Provider, counting))))
    }).pipe(Effect.provide([Database.layer(":memory:"), NodeCrypto.layer]))
  )

  describe("dayStart", () => {
    const chicago = (local: string) =>
      Option.getOrThrow(DateTime.makeZoned(local, { timeZone: "America/Chicago", adjustForTimeZone: true }))

    it("is yesterday's 04:00 before 04:00", () => {
      assert.deepStrictEqual(
        dayStart(chicago("2026-10-04T03:59:00")),
        DateTime.makeUnsafe("2026-10-03T09:00:00Z")
      )
    })

    it("is today's 04:00 from 04:00", () => {
      assert.deepStrictEqual(
        dayStart(chicago("2026-10-04T04:00:00")),
        DateTime.makeUnsafe("2026-10-04T09:00:00Z")
      )
      assert.deepStrictEqual(
        dayStart(chicago("2026-10-04T23:59:00")),
        DateTime.makeUnsafe("2026-10-04T09:00:00Z")
      )
    })
  })
})

/** `over`, on a fresh in-memory database. */
function ingesting(provider: Layer.Layer<Provider>, options: Parameters<typeof over>[1] = {}) {
  return over(provider, options).pipe(Layer.provide([Database.layer(":memory:"), NodeCrypto.layer]))
}

/**
 * Ingest over `provider` and `liveFeed` (one that never pushes, unless given), of `leagues` (fbs, unless given), with
 * the fold and the feed log (`FeedLog.layer`, unless given) also provided to the test, and each span that ends recorded
 * in `ended`.
 */
function over(
  provider: Layer.Layer<Provider>,
  options: {
    readonly leagues?: ReadonlyArray<"nfl" | "fbs">
    readonly liveFeed?: LiveFeed["Service"]
    readonly ended?: Array<Tracer.Span>
    readonly feedLog?: Layer.Layer<FeedLog, never, SqlClient.SqlClient | Crypto.Crypto>
  } = {}
) {
  return Ingest.layer(options.leagues ?? ["fbs"]).pipe(
    Layer.provideMerge(Layer.mergeAll(LiveGames.layer, options.feedLog ?? FeedLog.layer)),
    Layer.provide([
      provider,
      options.liveFeed === undefined ? neverPushing : Layer.succeed(LiveFeed, options.liveFeed)
    ]),
    Layer.provideMerge(recordingSpans(options.ended ?? []))
  )
}

/**
 * Runs Ingest over a live feed of `frames`, which stops without failing, and checks the stop is logged once at Error
 * with `why`, and that polls go on.
 */
function stopsAndPollsOn(frames: Stream.Stream<Omit<Frame, "seq">>, why: string) {
  const { logs, layer } = recordingLogs()
  return Effect.gen(function* () {
    const polls = yield* Ref.make(0)
    const provider = Layer.succeed(
      Provider,
      polling(() => Ref.update(polls, (n) => n + 1).pipe(Effect.as([liveGame(0)])))
    )
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("20 seconds")
    }).pipe(Effect.provide(ingesting(provider, { liveFeed: LiveFeed.of({ frames: () => frames }) })))
    const stopped = logs.filter(
      (log) => log.level === "Error" && log.message.includes("the live feed stopped")
    )
    assert.strictEqual(stopped.length, 1)
    assert.include(`${stopped[0]?.message} ${stopped[0]?.cause}`, why)
    assert.isAtLeast(yield* Ref.get(polls), 3)
  }).pipe(Effect.provide(layer))
}

/** What a test offers its live feed: a frame, or the error that ends the feed's stream. */
type Offered = Omit<Frame, "seq"> | LiveFeedError

/** A live feed reading `feed`, counting each subscription to it in `subscriptions`. */
function feeding(feed: Queue.Queue<Offered>, subscriptions: Ref.Ref<number>): LiveFeed["Service"] {
  return LiveFeed.of({
    frames: () =>
      Stream.unwrap(
        Ref.update(subscriptions, (n) => n + 1).pipe(
          Effect.as(
            Stream.fromQueue(feed).pipe(
              Stream.mapEffect((offered) =>
                Schema.is(LiveFeedError)(offered) ? Effect.fail(offered) : Effect.succeed(offered)
              )
            )
          )
        )
      )
  })
}

function liveGame(homeScore: number) {
  return snapshot({
    status: "live",
    period: 1,
    clock: "10:00",
    home: { team: team("MSST"), score: homeScore },
    away: { team: team("ALA"), score: 0 }
  })
}

/**
 * A provider that never polls, whose decode keeps a count of the frames it has read and reads each as a pushed live
 * game with that count for the home score.
 */
const counting = Provider.of({
  poll: (league) => Effect.fail(new ProviderError({ league, cause: "down" })),
  decode: (frames) =>
    frames.pipe(
      Stream.mapAccum(
        () => 0,
        (count, frame) =>
          [
            count + 1,
            [
              Decoded.Delivered({
                delivery: Delivery.Snapshot({ snapshot: liveGame(count + 1), from: "push" }),
                at: frame.receivedAt,
                seq: frame.seq
              })
            ]
          ] as const
      )
    )
})

/** An fbs poll of `games`, as the scripted provider frames it, received now. */
function pollOf(games: ReadonlyArray<GameSnapshot>) {
  return polling(() => Effect.succeed(games))
    .poll("fbs")
    .pipe(Effect.orDie)
}

/** The fbs listing as the fold has it. */
function slateOf() {
  return Effect.gen(function* () {
    return (yield* (yield* LiveGames).latest).slate(["fbs"])
  })
}

/** Every frame the log has written, once it has written at least `count`. */
function logOf(count: number) {
  return Effect.gen(function* () {
    const log = yield* FeedLog
    return yield* log
      .replay(DateTime.makeUnsafe(0))
      .pipe(
        Stream.runCollect,
        Effect.repeat({ until: (written) => written.length >= count, schedule: Schedule.spaced("5 millis") }),
        TestClock.withLive
      )
  })
}

/** The fold once it has taken frame `seq`, waiting up to a real second. */
function foldedThrough(seq: number) {
  return Effect.gen(function* () {
    const liveGames = yield* LiveGames
    yield* liveGames.changes.pipe(
      Stream.filter((folded) => Option.exists(folded.seq, (at) => at >= seq)),
      Stream.take(1),
      Stream.runDrain,
      Effect.timeout("1 second"),
      TestClock.withLive
    )
    return yield* liveGames.latest
  })
}

/** Frames logged now, before Ingest starts, in a scope of their own. */
function loggedBefore(frames: ReadonlyArray<Effect.Effect<Omit<Frame, "seq">>>) {
  return Effect.gen(function* () {
    const log = yield* FeedLog
    yield* Effect.forEach(frames, (frame) => Effect.flatMap(frame, log.append), { discard: true })
  }).pipe(Effect.provide(FeedLog.layer), Effect.scoped)
}
