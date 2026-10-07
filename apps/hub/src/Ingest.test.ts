import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { LiveGameState } from "@sportal/domain/LiveGame"
import { liveSnapshot, snapshot, team } from "@sportal/domain/TestGame"
import {
  Clock,
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
import * as Database from "./Database.ts"
import { FeedLog } from "./FeedLog.ts"
import type { FeedFrame } from "./Frame.ts"
import { GameHistory } from "./GameHistory.ts"
import * as Ingest from "./Ingest.ts"
import { type LiveFeed, LiveFeedDemand, type Polling, Provider, ProviderError } from "./provider/Provider.ts"
import { Slate } from "./Slate.ts"
import { polled, pushed } from "./TestFeed.ts"
import { withEnv } from "./TestHubConfig.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"
import { counted, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

describe("Ingest", () => {
  it.effect("each poll appends one frame per league, then its listing reaches the slate", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      const current = yield* (yield* Slate).latest
      yield* TestClock.adjust("100 millis")
      const logged = yield* logOf(2)

      assert.deepStrictEqual(
        logged.map(({ seq, feed, channel }) => [seq, feed, channel]),
        [
          [1, "snapshot", "nfl"],
          [2, "snapshot", "fbs"]
        ]
      )
      assert.deepStrictEqual(current.seq, Option.some(2))
      assert.deepStrictEqual(
        [...current.listed].map(([league, games]) => [league, games.map((listed) => listed.id)]),
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
            polled(
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
    "the Schedule's input is the slate's games after the poll's listing was taken, and the failed leagues",
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

  it.effect("polls again after the live cadence, and the new listing reaches the slate", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      assert.strictEqual((yield* slateOf())[0]?.home.score, 0)

      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* slateOf())[0]?.home.score, 7)
    }).pipe(Effect.provide(ingesting(scripted([[scoring(0)], [scoring(7)]]))))
  )

  it.effect("a poll that does not decode does not hold up the next one", () =>
    Effect.gen(function* () {
      const polls = yield* Ref.make(0)
      const provider = Layer.succeed(
        Provider,
        Provider.of({
          push: () => Stream.never,
          polling: Schedule.spaced("1 second"),
          reconnect: Schedule.spaced("1 second"),
          poll: () =>
            Ref.getAndUpdate(polls, (n) => n + 1).pipe(
              Effect.flatMap((call) =>
                call === 1
                  ? Effect.map(pollOf([]), (frame) => ({ ...frame, body: "not json" }))
                  : pollOf([scoring(call)])
              )
            )
        })
      )
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("1 second")
        assert.strictEqual(yield* Ref.get(polls), 2)

        yield* TestClock.adjust("1 second")
        assert.strictEqual(yield* Ref.get(polls), 3)
      }).pipe(Effect.provide(ingesting(provider)))
    })
  )

  it.effect("a failed league appends nothing and keeps its last listing in the slate", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")
      yield* TestClock.adjust("100 millis")

      assert.strictEqual((yield* slateOf())[0]?.home.score, 7)
      assert.lengthOf(yield* logOf(1), 1)
    }).pipe(Effect.provide(ingesting(scripted([[scoring(7)], "fail"]))))
  )

  it.effect("a failed league's game goes stale in the slate, its listing kept", () =>
    Effect.gen(function* () {
      const slate = yield* Slate
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("90 seconds")
      const current = yield* slate.latest

      assert.isTrue(
        Option.exists(Option.fromNullishOr(current.live.get(GameId.make("1"))), (liveGame) =>
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
        yield* Queue.offer(
          feed,
          yield* pushed(Delivery.cases.Snapshot.make({ snapshot: scoring(7), from: "push" }), "fbs")
        )
        yield* TestClock.adjust("100 millis")

        assert.strictEqual((yield* slateOf())[0]?.home.score, 7)
        assert.deepStrictEqual(
          (yield* logOf(2)).map(({ seq, feed }) => [seq, feed]),
          [
            [1, "snapshot"],
            [2, "snapshot"]
          ]
        )
      }).pipe(
        Effect.provide(ingesting(scripted([[scoring(0)]], { push: () => feeding(feed, subscriptions) })))
      )
    })
  )

  it.effect("a channel the decoder resyncs reaches the live feed", () =>
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<Offered>()
      const resynced = yield* Ref.make<ReadonlyArray<string>>([])
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* Queue.offer(feed, yield* pushed({ _tag: "Resync" }, "gp-football-college-football-1"))
        yield* TestClock.adjust(0)

        assert.deepStrictEqual(yield* Ref.get(resynced), ["gp-football-college-football-1"])
      }).pipe(
        Effect.provide(
          ingesting(
            scripted([[scoring(0)]], {
              push: (demand) =>
                Stream.fromQueue(feed).pipe(
                  Stream.filterMap((offered) =>
                    Schema.is(ProviderError)(offered) ? Result.failVoid : Result.succeed(offered)
                  ),
                  Stream.merge(
                    demand.pipe(
                      Stream.filter(LiveFeedDemand.$is("Resync")),
                      Stream.mapEffect(({ channel }) => Ref.update(resynced, (all) => [...all, channel])),
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
      // Two minutes before it is current, no further: each minute of test clock is six polls and 600 feed log wakes.
      const scheduled = snapshot({
        id: GameId.make("1"),
        status: "scheduled",
        kickoff: DateTime.add(now, { minutes: 32 })
      })
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Ref.get(wanted), [[]])

        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Ref.get(wanted), [[], ["1"]])
      }).pipe(
        Effect.provide(
          ingesting(
            scripted([[scheduled]], {
              push: (demand) =>
                demand.pipe(
                  Stream.filter(LiveFeedDemand.$is("Games")),
                  Stream.mapEffect(({ games }) =>
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
    "a failing push is subscribed again on the provider's reconnect, and once that is done the feed ends logged",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const feed = yield* Queue.unbounded<Offered>()
        const subscriptions = yield* Ref.make(0)
        const polls = yield* Ref.make(0)
        const provider = polled(() => Ref.update(polls, (n) => n + 1).pipe(Effect.as([scoring(0)])), {
          push: feeding(feed, subscriptions),
          reconnect: Schedule.recurs(1)
        })
        const closed = new ProviderError({ reason: "Closed", cause: "socket closed" })
        const stopped = () =>
          logs.filter((log) => log.level === "Error" && log.message.includes("the live feed stopped"))
        yield* Effect.gen(function* () {
          yield* TestClock.adjust(0)
          assert.strictEqual(yield* Ref.get(subscriptions), 1)
          yield* Queue.offer(feed, closed)
          // `Schedule.recurs(1)` retries with no delay, so the clock need not move.
          yield* TestClock.adjust(0)
          assert.strictEqual(yield* Ref.get(subscriptions), 2)
          assert.lengthOf(stopped(), 0)

          yield* Queue.offer(feed, closed)
          yield* TestClock.adjust("20 seconds")
          assert.strictEqual(yield* Ref.get(subscriptions), 2)
          assert.lengthOf(stopped(), 1)
          assert.include(String(stopped()[0]?.cause), "socket closed")
          assert.strictEqual(yield* counted("sportal_live_feed_errors", { reason: "Closed" }), 2)
          assert.isAtLeast(yield* Ref.get(polls), 3)
        }).pipe(Effect.provide(ingesting(provider)))
      }).pipe(Effect.provide(layer), withMetrics)
    }
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
      }).pipe(
        Effect.provide(ingesting(scripted([[scoring(0)]], { push: () => feeding(feed, subscriptions) })))
      )
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
          (index) =>
            Effect.flatMap(
              pushed(Delivery.cases.Snapshot.make({ snapshot: scoring(index), from: "push" }), "fbs"),
              log.append
            ),
          { discard: true }
        )

        const [took] = yield* Effect.timed(Scope.close(scope, Exit.void))

        assert.isBelow(Duration.toMillis(took), Duration.toMillis(Duration.seconds(1)))
        const [row] = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM feed_frame WHERE feed = 'snapshot' AND kind = 'message'
        `
        assert.strictEqual(row?.count, 200)
      }).pipe(Effect.provide([Database.at(":memory:"), NodeCrypto.layer])),
    10_000
  )

  it.effect(
    "its first poll is appended after the frames the slate replayed, quietly, before Ingest started",
    () => {
      const ended: Array<Tracer.Span> = []
      const { logs, layer: logged } = recordingLogs()
      return Effect.gen(function* () {
        yield* loggedBefore([
          pollOf([liveSnapshot({ id: GameId.make("1"), period: 2 })]),
          pollOf([liveSnapshot({ id: GameId.make("1"), period: 3 })])
        ])

        yield* Effect.gen(function* () {
          const replayed = yield* (yield* Slate).latest
          assert.deepStrictEqual(replayed.seq, Option.some(2))
          assert.strictEqual(replayed.live.get(GameId.make("1"))?.snapshot.period, 3)
          assert.isUndefined(yield* counted("sportal_snapshots"))
          assert.isFalse(logs.some((log) => log.message.includes("started")))
          const replay = ended.find((span) => span.name === "Slate.replay")
          assert.strictEqual(replay?.attributes.get("sportal.frames"), 2)
          assert.strictEqual(replay?.attributes.get("sportal.deliveries"), 2)

          yield* TestClock.adjust(0)
          const polled = yield* (yield* Slate).latest
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
})

/** `over`, on a fresh in-memory database. */
function ingesting(provider: Layer.Layer<Provider>, options: Parameters<typeof over>[1] = {}) {
  return over(provider, options).pipe(Layer.provide([Database.at(":memory:"), NodeCrypto.layer]))
}

/**
 * Ingest over `provider`, its frames read by the snapshot feed's decode, of `leagues` (fbs, unless given), with the live
 * games and the feed log they share also provided to the test, and each span that ends recorded in `ended`.
 */
function over(
  provider: Layer.Layer<Provider>,
  options: { readonly leagues?: ReadonlyArray<LeagueId>; readonly ended?: Array<Tracer.Span> } = {}
) {
  return Ingest.layer.pipe(
    Layer.provideMerge(Slate.layer),
    Layer.provideMerge(FeedLog.layer),
    Layer.provide([
      provider,
      TestSnapshotFeed.decoder,
      withEnv({ SPORTAL_LEAGUES: (options.leagues ?? ["fbs"]).join(",") }).pipe(Layer.orDie),
      DateTime.layerCurrentZoneLocal
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
    const provider = polled(() => Ref.update(polls, (n) => n + 1).pipe(Effect.as([scoring(0)])), {
      push: frames
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

/**
 * The snapshot feed answering each poll with the next scripted response, and the last one after that, inside a
 * `provider.poll` span. A `"fail"` response fails the poll, and an empty script fails every poll. Its push is `push`,
 * which, unlike the snapshot feed's, reads the slate's demand; it never pushes unless given one. It is polled
 * every 10 seconds unless `polling` says otherwise.
 */
function scripted(
  responses: ReadonlyArray<ReadonlyArray<GameSnapshot> | "fail">,
  options: { readonly polling?: Polling; readonly push?: LiveFeed } = {}
): Layer.Layer<Provider> {
  const { push } = options
  const snapshotFeed = Layer.unwrap(
    Effect.map(Ref.make(0), (calls) =>
      TestSnapshotFeed.provider({
        games: (league) =>
          Ref.getAndUpdate(calls, (call) => call + 1).pipe(
            Effect.flatMap((call) => {
              const response = responses[Math.min(call, responses.length - 1)]
              return response === "fail" || response === undefined
                ? Effect.fail(new ProviderError({ reason: "Unreachable", league, cause: "down" }))
                : Effect.succeed(response)
            }),
            Effect.withSpan("provider.poll")
          ),
        polling: options.polling ?? Schedule.spaced("10 seconds")
      })
    )
  )
  return push === undefined
    ? snapshotFeed
    : Layer.effect(
        Provider,
        Effect.map(Provider, (provider) => Provider.of({ ...provider, push }))
      ).pipe(Layer.provide(snapshotFeed))
}

/** What a test offers its push: a frame, or the error that ends the push's stream. */
type Offered = FeedFrame | ProviderError

/** A push reading `feed`, counting each subscription to it in `subscriptions`. */
function feeding(feed: Queue.Queue<Offered>, subscriptions: Ref.Ref<number>) {
  return Stream.unwrap(
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

/** An fbs poll of `games`, as the scripted provider frames it, received now. */
function scoring(n: number) {
  return liveSnapshot({ home: { team: team("HOME"), score: n } })
}

function pollOf(games: ReadonlyArray<GameSnapshot>) {
  return Provider.use((provider) => provider.poll("fbs")).pipe(
    Effect.provide(polled(() => Effect.succeed(games))),
    Effect.orDie
  )
}

/** The fbs listing as the slate has it. */
function slateOf() {
  return Effect.gen(function* () {
    return (yield* (yield* Slate).latest).games(["fbs"])
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

/** Frames logged now, before Ingest starts, in a scope of their own. */
function loggedBefore(frames: ReadonlyArray<Effect.Effect<FeedFrame>>) {
  return Effect.gen(function* () {
    const log = yield* FeedLog
    yield* Effect.forEach(frames, (frame) => Effect.flatMap(frame, log.append), { discard: true })
  }).pipe(Effect.provide(FeedLog.layer), Effect.scoped)
}
