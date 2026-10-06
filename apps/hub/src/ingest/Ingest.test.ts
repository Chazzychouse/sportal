import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { LiveGameState } from "@sportal/domain/LiveGame"
import { liveSnapshot, snapshot, team } from "@sportal/domain/TestGame"
import {
  Clock,
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
import { FeedLog } from "../FeedLog.ts"
import type { FeedFrame } from "../Frame.ts"
import { GameHistory } from "../GameHistory.ts"
import { LiveGames } from "../LiveGames.ts"
import { Decoder } from "../provider/Decoder.ts"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import { recordedCheckpoint } from "../provider/espn/TestEspn.ts"
import { Decoded, type Polling, Provider, ProviderError } from "../provider/Provider.ts"
import { polling, pushed, scripted } from "../provider/TestProvider.ts"
import { withEnv } from "../TestHubConfig.ts"
import { counted, recordingLogs, recordingSpans, withMetrics } from "../TestTelemetry.ts"
import * as Ingest from "./Ingest.ts"

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
    }).pipe(
      Effect.provide(
        ingesting(scripted([[liveSnapshot({ id: GameId.make("1") })]]), { leagues: ["nfl", "fbs"] })
      )
    )
  )

  it.effect("polls again when the provider's Schedule says, whatever the slate", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<number>>([])
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("14 seconds")
        assert.deepStrictEqual(yield* Ref.get(calls), [0, 7000, 14000])
      }).pipe(
        Effect.provide(
          ingesting(
            polling(
              () =>
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) => Ref.update(calls, (all) => [...all, now])),
                  Effect.as([liveSnapshot({ id: GameId.make("1") })])
                ),
              { polling: Schedule.spaced("7 seconds") }
            )
          )
        )
      )
    })
  )

  it.effect(
    "the Schedule's input is the fold's slate after the poll's listing was taken, and the failed leagues",
    () =>
      Effect.gen(function* () {
        const inputs = yield* Ref.make<
          ReadonlyArray<readonly [ReadonlyArray<number>, ReadonlyArray<string>]>
        >([])
        const recording = Schedule.spaced("10 seconds").pipe(
          Schedule.setInputType<Schedule.Input<Polling>>(),
          Schedule.tap(({ input }) =>
            Ref.update(inputs, (all) => [
              ...all,
              [input.slate.map((game) => game.home.score), input.failed] as const
            ])
          )
        )
        yield* Effect.gen(function* () {
          yield* TestClock.adjust(0)
          yield* TestClock.adjust("10 seconds")
          assert.deepStrictEqual(yield* Ref.get(inputs), [
            [[], ["fbs"]],
            [[3], []]
          ])
        }).pipe(Effect.provide(ingesting(scripted(["fail", [scoring(3)]], { polling: recording }))))
      })
  )

  it.effect("polls again after the live cadence, and the new listing reaches the fold", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      assert.strictEqual((yield* slateOf())[0]?.home.score, 0)

      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* slateOf())[0]?.home.score, 7)
    }).pipe(Effect.provide(ingesting(scripted([[scoring(0)], [scoring(7)]]))))
  )

  it.effect("a failed league appends nothing and keeps its last listing in the fold", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")
      yield* TestClock.adjust("100 millis")

      assert.strictEqual((yield* slateOf())[0]?.home.score, 7)
      assert.lengthOf(yield* logOf(1), 1)
    }).pipe(Effect.provide(ingesting(scripted([[scoring(7)], "fail"]))))
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
    }).pipe(
      Effect.provide(ingesting(scripted([[liveSnapshot({ id: GameId.make("1"), period: 2 })], "fail"])))
    )
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
    }).pipe(Effect.provide(ingesting(scripted([[scoring(0)]]), { ended })))
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
    }).pipe(Effect.provide(ingesting(scripted([[scoring(0)], [scoring(7)]]))), withMetrics)
  )

  it.effect("a frame the live feed gives is appended and its delivery taken", () =>
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<Offered>()
      const subscriptions = yield* Ref.make(0)
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* Queue.offer(feed, yield* pushed([scoring(7)]))
        yield* TestClock.adjust("100 millis")

        assert.strictEqual((yield* slateOf())[0]?.home.score, 7)
        assert.deepStrictEqual(
          (yield* logOf(2)).map(({ seq, feed }) => [seq, feed]),
          [
            [1, "poll"],
            [2, "fastcast"]
          ]
        )
      }).pipe(Effect.provide(ingesting(scripted([[scoring(0)]], { push: feeding(feed, subscriptions) }))))
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
          ingesting(
            scripted([[scoring(0)]], {
              push: (_leagues, _wanted, resync) =>
                Stream.fromQueue(feed).pipe(
                  Stream.filterMap((offered) =>
                    Schema.is(ProviderError)(offered) ? Result.failVoid : Result.succeed(offered)
                  ),
                  Stream.merge(
                    resync.pipe(
                      Stream.mapEffect((channel) => Ref.update(resynced, (all) => [...all, channel])),
                      Stream.drain
                    )
                  )
                )
            })
          )
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
          ingesting(
            scripted([[scheduled]], {
              push: (_leagues, current) =>
                current.pipe(
                  Stream.mapEffect((games) =>
                    Ref.update(wanted, (all) => [...all, games.map((wantedGame) => wantedGame.id)])
                  ),
                  Stream.drain,
                  Stream.concat(Stream.never)
                )
            })
          )
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
        const provider = polling(() => Ref.update(polls, (n) => n + 1).pipe(Effect.as([scoring(0)])), {
          push: feeding(feed, subscriptions)
        })
        const closed = new ProviderError({ reason: "Closed", cause: "socket closed" })
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
        }).pipe(Effect.provide(ingesting(provider)))
      }).pipe(withMetrics)
  )

  it.effect("a push that fails with Silent is counted by reason and subscribed again", () =>
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<Offered>()
      const subscriptions = yield* Ref.make(0)
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* Queue.offer(feed, new ProviderError({ reason: "Silent", cause: "no message for 45 s" }))
        yield* TestClock.adjust("2 seconds")
        assert.strictEqual(yield* Ref.get(subscriptions), 2)
        assert.strictEqual(yield* counted("sportal_live_feed_errors", { reason: "Silent" }), 1)
      }).pipe(Effect.provide(ingesting(scripted([[scoring(0)]], { push: feeding(feed, subscriptions) }))))
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
      }).pipe(Effect.provide(ingesting(scripted([[scoring(0)]]))))

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
            Layer.provideMerge(over(scripted([[scoring(0)]])))
          ),
          scope
        )
        const log = yield* FeedLog.pipe(Effect.provideContext(services))
        // Far more than the 100 ms the writer could be behind by when the Hub stops.
        yield* Effect.forEach(
          Array.from({ length: 200 }, (_, index) => index),
          (index) => Effect.flatMap(pushed([scoring(index)]), log.append),
          { discard: true }
        )

        const [took] = yield* Effect.timed(Scope.close(scope, Exit.void))

        assert.isBelow(Duration.toMillis(took), Duration.toMillis(Duration.seconds(1)))
        const [row] = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM feed_frame WHERE feed = 'fastcast'
        `
        assert.strictEqual(row?.count, 200)
      }).pipe(Effect.provide([Database.at(":memory:"), NodeCrypto.layer])),
    10_000
  )

  it.effect(
    "replays the day's logged frames into the fold before it is built, quietly, then appends after them",
    () => {
      const ended: Array<Tracer.Span> = []
      const { logs, layer: logged } = recordingLogs()
      return Effect.gen(function* () {
        yield* loggedBefore([
          pollOf([liveSnapshot({ id: GameId.make("1"), period: 2 })]),
          pollOf([liveSnapshot({ id: GameId.make("1"), period: 3 })])
        ])

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
        }).pipe(
          Effect.provide(
            over(scripted([[liveSnapshot({ id: GameId.make("1"), period: 4 })]]), { ended }).pipe(
              Layer.provideMerge(logged)
            )
          )
        )
      }).pipe(Effect.provide([Database.at(":memory:"), NodeCrypto.layer]), withMetrics)
    }
  )

  it.effect("replayed deliveries are counted once, on the Ingest.replay span", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* loggedBefore([
        pollOf([liveSnapshot({ id: GameId.make("1") }), liveSnapshot({ id: GameId.make("2") })]),
        pollOf([liveSnapshot({ id: GameId.make("1"), period: 2 })]),
        pollOf([liveSnapshot({ id: GameId.make("1"), period: 3 })])
      ])

      yield* Effect.void.pipe(Effect.provide(over(scripted([]), { ended })))

      const replay = ended.find((span) => span.name === "Ingest.replay")
      assert.strictEqual(replay?.attributes.get("sportal.frames"), 3)
      assert.strictEqual(replay?.attributes.get("sportal.deliveries"), 3)
      const folded = ended.find((span) => span.name === "LiveGames.replay")
      assert.isDefined(folded)
      assert.isFalse(folded?.attributes.has("sportal.deliveries"))
    }).pipe(Effect.provide([Database.at(":memory:"), NodeCrypto.layer]))
  })

  it.effect("a restart replays frames that raised notices without counting or logging them", () => {
    const { logs, layer: logged } = recordingLogs()
    return Effect.gen(function* () {
      yield* loggedBefore(noticeable)

      yield* Effect.gen(function* () {
        yield* (yield* LiveGames).latest
        for (const counter of decodeCounters) assert.isUndefined(yield* counted(counter), counter)
        assert.deepStrictEqual(
          logs.filter(({ message }) => message.includes("Decode:")),
          []
        )
      }).pipe(Effect.provide(over(espnDecoding).pipe(Layer.provideMerge(logged))))
    }).pipe(Effect.provide([Database.at(":memory:"), NodeCrypto.layer]), withMetrics)
  })

  it.effect("the same notices on frames after the replay are counted and logged", () => {
    const { logs, layer: logged } = recordingLogs()
    return Effect.gen(function* () {
      const log = yield* FeedLog
      yield* Effect.forEach(noticeable, (frame) => Effect.flatMap(frame, log.append), { discard: true })
      yield* counted("sportal_live_feed_document_resets").pipe(
        Effect.repeat({ until: (count) => count !== undefined, schedule: Schedule.spaced("5 millis") }),
        Effect.timeout("1 second"),
        TestClock.withLive
      )

      assert.strictEqual(yield* counted("sportal_frames_undecoded", { feed: "poll" }), 1)
      assert.strictEqual(yield* counted("sportal_live_feed_games", { league: "nfl" }), 16)
      assert.strictEqual(yield* counted("sportal_live_feed_unlisted", { league: "nfl" }), 16)
      assert.strictEqual(yield* counted("sportal_live_feed_messages", { league: "nfl", op: "P" }), 1)
      assert.strictEqual(
        yield* counted("sportal_live_feed_document_resets", { league: "nfl", reason: "Gap" }),
        1
      )
      assert.strictEqual(
        logs.filter(
          ({ level, message }) => level === "Warn" && message.includes("waits for its next checkpoint")
        ).length,
        1
      )
      assert.isTrue(logs.some(({ level, message }) => level === "Error" && message.includes("Decode:")))
    }).pipe(Effect.provide(ingesting(espnDecoding).pipe(Layer.provideMerge(logged))), withMetrics)
  })

  it.effect("a frame appended the moment the replay ends, before anything else runs, reaches the fold", () =>
    Effect.gen(function* () {
      yield* loggedBefore([pollOf([liveSnapshot({ id: GameId.make("1"), period: 2 })])])
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
                    Stream.fromEffect(
                      Effect.flatMap(pushed([liveSnapshot({ id: GameId.make("1"), period: 3 })]), log.append)
                    ).pipe(Stream.drain)
                  )
                )
          })
        )
      ).pipe(Layer.provide(FeedLog.layer))

      yield* Effect.gen(function* () {
        const folded = yield* foldedThrough(2)
        assert.strictEqual(folded.live.get(GameId.make("1"))?.snapshot.period, 3)
      }).pipe(Effect.provide(over(scripted([]), { feedLog: appendingAtEnd })))
    }).pipe(Effect.provide([Database.at(":memory:"), NodeCrypto.layer]))
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
      }).pipe(Effect.provide(over(counting)))
    }).pipe(Effect.provide([Database.at(":memory:"), NodeCrypto.layer]))
  )

  describe("the game day", () => {
    // The log holds a frame at each of these instants; the replay, from the game day's start, reads those from it on.
    const framesAt = ["2026-10-03T08:59:00Z", "2026-10-03T09:00:00Z", "2026-10-04T09:00:00Z"]

    const replayedAt = (chicago: string) =>
      Effect.gen(function* () {
        const ended: Array<Tracer.Span> = []
        yield* loggedBefore(
          framesAt.map((at) =>
            Effect.map(pollOf([liveSnapshot({ id: GameId.make("1"), period: 2 })]), (frame) => ({
              ...frame,
              receivedAt: DateTime.makeUnsafe(at)
            }))
          )
        )
        yield* TestClock.setTime(
          DateTime.toEpochMillis(
            Option.getOrThrow(
              DateTime.makeZoned(chicago, { timeZone: "America/Chicago", adjustForTimeZone: true })
            )
          )
        )
        return yield* Effect.gen(function* () {
          return ended.find((span) => span.name === "Ingest.replay")?.attributes.get("sportal.frames")
        }).pipe(Effect.provide(over(scripted([]), { ended, zone: "America/Chicago" })))
      }).pipe(Effect.provide([Database.at(":memory:"), NodeCrypto.layer]))

    it.effect("starts at yesterday's 04:00 before 04:00", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* replayedAt("2026-10-04T03:59:00"), 2)
      })
    )

    it.effect("starts at today's 04:00 from 04:00", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* replayedAt("2026-10-04T04:00:00"), 1)
        assert.strictEqual(yield* replayedAt("2026-10-04T23:59:00"), 1)
      })
    )
  })
})

/** `over`, on a fresh in-memory database. */
function ingesting(provider: Layer.Layer<Provider | Decoder>, options: Parameters<typeof over>[1] = {}) {
  return over(provider, options).pipe(Layer.provide([Database.at(":memory:"), NodeCrypto.layer]))
}

/**
 * Ingest over `provider`, of `leagues` (fbs, unless given), with the fold and the feed log (`FeedLog.layer`, unless
 * given) also provided to the test, each span that ends recorded in `ended`, and the game day read in `zone` (the local
 * one, unless given).
 */
function over(
  provider: Layer.Layer<Provider | Decoder>,
  options: {
    readonly leagues?: ReadonlyArray<LeagueId>
    readonly ended?: Array<Tracer.Span>
    readonly feedLog?: Layer.Layer<FeedLog, never, SqlClient.SqlClient | Crypto.Crypto>
    readonly zone?: string
  } = {}
) {
  return Ingest.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(LiveGames.layer, options.feedLog ?? FeedLog.layer)),
    Layer.provide([
      provider,
      withEnv({ SPORTAL_LEAGUES: (options.leagues ?? ["fbs"]).join(",") }).pipe(Layer.orDie),
      options.zone === undefined
        ? DateTime.layerCurrentZoneLocal
        : DateTime.layerCurrentZoneNamed(options.zone).pipe(Layer.orDie)
    ]),
    Layer.provideMerge(recordingSpans(options.ended ?? []))
  )
}

/**
 * Runs Ingest over a live feed of `frames`, which stops without failing, and checks the stop is logged once at Error
 * with `why`, and that polls go on.
 */
function stopsAndPollsOn(frames: Stream.Stream<FeedFrame>, why: string) {
  const { logs, layer } = recordingLogs()
  return Effect.gen(function* () {
    const polls = yield* Ref.make(0)
    const provider = polling(() => Ref.update(polls, (n) => n + 1).pipe(Effect.as([scoring(0)])), {
      push: () => frames
    })
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("20 seconds")
    }).pipe(Effect.provide(ingesting(provider)))
    const stopped = logs.filter(
      (log) => log.level === "Error" && log.message.includes("the live feed stopped")
    )
    assert.strictEqual(stopped.length, 1)
    assert.include(`${stopped[0]?.message} ${stopped[0]?.cause}`, why)
    assert.isAtLeast(yield* Ref.get(polls), 3)
  }).pipe(Effect.provide(layer))
}

/** What a test offers its push: a frame, or the error that ends the push's stream. */
type Offered = FeedFrame | ProviderError

/** A push reading `feed`, counting each subscription to it in `subscriptions`. */
function feeding(feed: Queue.Queue<Offered>, subscriptions: Ref.Ref<number>) {
  return () =>
    Stream.unwrap(
      Ref.update(subscriptions, (n) => n + 1).pipe(
        Effect.as(
          Stream.fromQueue(feed).pipe(
            Stream.mapEffect((offered) =>
              Schema.is(ProviderError)(offered) ? Effect.fail(offered) : Effect.succeed(offered)
            )
          )
        )
      )
    )
}

/**
 * A provider that never polls, whose decode keeps a count of the frames it has read and reads each as a pushed live
 * game with that count for the home score.
 */
const counting = Layer.mergeAll(
  Layer.succeed(
    Provider,
    Provider.of({
      push: () => Stream.never,
      polling: Schedule.spaced("10 seconds"),
      poll: (league) => Effect.fail(new ProviderError({ reason: "Unreachable", league, cause: "down" }))
    })
  ),
  Layer.succeed(
    Decoder,
    Decoder.of({
      decode: (frames) =>
        frames.pipe(
          Stream.mapAccum(
            () => 0,
            (count, frame) =>
              [
                count + 1,
                [
                  Decoded.Delivered({
                    delivery: Delivery.Snapshot({
                      snapshot: scoring(count + 1),
                      from: "push"
                    }),
                    at: frame.receivedAt,
                    seq: frame.seq
                  })
                ]
              ] as const
          )
        )
    })
  )
)

/** A provider whose polls fail and whose decode is ESPN's, for frames that raise its notices. */
const espnDecoding = Layer.mergeAll(
  Layer.succeed(
    Provider,
    Provider.of({
      poll: (league) => Effect.fail(new ProviderError({ reason: "Unreachable", league, cause: "down" })),
      push: () => Stream.never,
      polling: Schedule.spaced("10 seconds")
    })
  ),
  EspnDecode.layer
)

/**
 * Frames, received now, that ESPN's decode notices: a poll that does not decode, the recorded NFL scoreboard
 * checkpoint before any listing (sixteen games pushed and unlisted), and a game topic's checkpoint and then a message
 * after a gap.
 */
const noticeable: ReadonlyArray<Effect.Effect<FeedFrame>> = (
  [
    { feed: "poll", channel: "nfl", kind: "response", body: "not json" },
    {
      feed: "fastcast",
      channel: "event-football-nfl",
      kind: "checkpoint",
      sourceId: 4286637,
      body: recordedCheckpoint()
    },
    {
      feed: "fastcast",
      channel: "gp-football-nfl-1",
      kind: "checkpoint",
      sourceId: 99,
      body: JSON.stringify({ entities: {} })
    },
    {
      feed: "fastcast",
      channel: "gp-football-nfl-1",
      kind: "message",
      sourceId: 101,
      body: JSON.stringify({
        op: "P",
        tc: "gp-football-nfl-1",
        mid: 101,
        pl: JSON.stringify({ ts: 1, pl: [] })
      })
    }
  ] satisfies ReadonlyArray<Omit<FeedFrame, "receivedAt">>
).map((frame) => Effect.map(DateTime.now, (receivedAt): FeedFrame => ({ ...frame, receivedAt })))

const decodeCounters = [
  "sportal_live_feed_messages",
  "sportal_live_feed_games",
  "sportal_events_undecoded",
  "sportal_live_feed_unlisted",
  "sportal_live_feed_document_resets",
  "sportal_frames_undecoded"
]

/** An fbs poll of `games`, as the scripted provider frames it, received now. */
function scoring(n: number) {
  return liveSnapshot({ home: { team: team("HOME"), score: n } })
}

function pollOf(games: ReadonlyArray<GameSnapshot>) {
  return Provider.use((provider) => provider.poll("fbs")).pipe(
    Effect.provide(polling(() => Effect.succeed(games))),
    Effect.orDie
  )
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
function loggedBefore(frames: ReadonlyArray<Effect.Effect<FeedFrame>>) {
  return Effect.gen(function* () {
    const log = yield* FeedLog
    yield* Effect.forEach(frames, (frame) => Effect.flatMap(frame, log.append), { discard: true })
  }).pipe(Effect.provide(FeedLog.layer), Effect.scoped)
}
