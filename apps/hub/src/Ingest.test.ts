import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { LiveGame, LiveGameState } from "@sportal/domain/LiveGame"
import { liveSnapshot, snapshot, team } from "@sportal/domain/TestGame"
import {
  Clock,
  DateTime,
  Deferred,
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
import type { Frame } from "./Frame.ts"
import { FeedLog } from "./feed-log/FeedLog.ts"
import { HubConfig } from "./HubConfig.ts"
import * as Ingest from "./Ingest.ts"
import { LiveSlate } from "./LiveSlate.ts"
import {
  type LiveFeed,
  LiveFeedDemand,
  type Polling,
  Provider,
  ProviderUnavailable
} from "./provider/Provider.ts"
import { appended, delivered } from "./TestLiveSlate.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"
import { pushed } from "./TestSnapshotFeed.ts"
import { counted, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

describe("Ingest", () => {
  it.effect("should append one frame per league for each poll, its listing reaching the slate", () =>
    Effect.gen(function* () {
      const liveSlate = yield* LiveSlate

      yield* TestClock.adjust(0)
      const current = yield* liveSlate.latest
      yield* TestClock.adjust("100 millis")
      const logged = yield* logOf(2)

      assert.deepStrictEqual(
        logged.map(({ seq, source, channel }) => [seq, source, channel]),
        [
          [1, "poll", "nfl"],
          [2, "poll", "fbs"]
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

  it.effect("should poll again when the provider's Schedule says, whatever the slate", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<number>>([])
      const provider = TestSnapshotFeed.layer({
        games: () => timeRecorded(calls).pipe(Effect.as([liveSnapshot({ id: GameId.make("1") })])),
        polling: Schedule.spaced("7 seconds")
      })

      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("14 seconds")
      }).pipe(Effect.provide(ingesting(provider)))

      const polledAt = yield* Ref.get(calls)
      assert.deepStrictEqual(polledAt, [0, 7000, 14000])
    })
  )

  it.effect(
    "should give the Schedule the slate's games after the poll's listing was taken, and the failed leagues",
    () =>
      Effect.gen(function* () {
        const inputs = yield* Ref.make<
          ReadonlyArray<readonly [ReadonlyArray<number>, ReadonlyArray<string>]>
        >([])
        const provider = scripted(["fail", [scoring(3)]], { polling: inputsRecorded(inputs) })

        yield* Effect.gen(function* () {
          yield* TestClock.adjust(0)
          yield* TestClock.adjust("10 seconds")
        }).pipe(Effect.provide(ingesting(provider)))

        const given = yield* Ref.get(inputs)
        assert.deepStrictEqual(given, [
          [[], ["fbs"]],
          [[3], []]
        ])
      })
  )

  it.effect("should take the first poll's scores into the slate", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)

      const listed = yield* slateOf()
      assert.strictEqual(listed[0]?.home.score, 0)
    }).pipe(Effect.provide(ingesting(scripted([[scoring(0)], [scoring(7)]]))))
  )

  it.effect("should poll again after the live cadence, the new listing reaching the slate", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)

      yield* TestClock.adjust("10 seconds")

      const listed = yield* slateOf()
      assert.strictEqual(listed[0]?.home.score, 7)
    }).pipe(Effect.provide(ingesting(scripted([[scoring(0)], [scoring(7)]]))))
  )

  it.effect("should make the second poll on schedule, though it does not decode", () =>
    Effect.gen(function* () {
      const polls = yield* Ref.make(0)

      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("1 second")
      }).pipe(Effect.provide(ingesting(secondPollUndecodable(polls))))

      const made = yield* Ref.get(polls)
      assert.strictEqual(made, 2)
    })
  )

  it.effect("should not let a poll that does not decode hold up the next one", () =>
    Effect.gen(function* () {
      const polls = yield* Ref.make(0)

      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("1 second")
        yield* TestClock.adjust("1 second")
      }).pipe(Effect.provide(ingesting(secondPollUndecodable(polls))))

      const made = yield* Ref.get(polls)
      assert.strictEqual(made, 3)
    })
  )

  it.effect("should append nothing for a failed league, keeping its last listing in the slate", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)

      yield* TestClock.adjust("10 seconds")
      yield* TestClock.adjust("100 millis")

      const listed = yield* slateOf()
      const logged = yield* logOf(1)
      assert.strictEqual(listed[0]?.home.score, 7)
      assert.lengthOf(logged, 1)
    }).pipe(Effect.provide(ingesting(scripted([[scoring(7)], "fail"]))))
  )

  it.effect("should let a failed league's game go stale in the slate, its listing kept", () =>
    Effect.gen(function* () {
      const liveSlate = yield* LiveSlate
      yield* TestClock.adjust(0)

      yield* TestClock.adjust("90 seconds")

      const current = yield* liveSlate.latest
      const listed = yield* slateOf()
      assert.isTrue(
        Option.exists(Option.fromNullishOr(current.live.get(GameId.make("1"))), (liveGame) =>
          LiveGameState.$is("Stale")(liveGame.state)
        )
      )
      assert.strictEqual(listed[0]?.period, 2)
    }).pipe(
      Effect.provide(ingesting(scripted([[liveSnapshot({ id: GameId.make("1"), period: 2 })], "fail"])))
    )
  )

  it.effect(
    "should make a poll one span, ended before the poll sleeps, with the provider's span inside it",
    () => {
      const ended: Array<Tracer.Span> = []
      return Effect.gen(function* () {
        yield* TestClock.adjust(0)

        const polls = ended.filter((span) => span.name === "Ingest.poll")
        const poll = polls[0]
        const provider = ended.find((span) => span.name === "provider.poll")
        const providerParent = provider?.parent.pipe(
          Option.map((parent) => parent.spanId),
          Option.getOrUndefined
        )
        assert.strictEqual(polls.length, 1)
        assert.strictEqual(providerParent, poll?.spanId)
        assert.deepStrictEqual(poll?.attributes.get("sportal.leagues"), ["fbs"])
        assert.deepStrictEqual(poll?.attributes.get("sportal.failed_leagues"), [])
      }).pipe(Effect.provide(ingesting(scripted([[scoring(0)]]), { ended })))
    }
  )

  it.effect("should put a failed league on the poll's span, and count it", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* TestClock.adjust(0)

      const poll = ended.find((span) => span.name === "Ingest.poll")
      const errors = yield* counted("sportal_provider_errors", { league: "fbs" })
      assert.deepStrictEqual(poll?.attributes.get("sportal.failed_leagues"), ["fbs"])
      assert.strictEqual(errors, 1)
    }).pipe(Effect.provide(ingesting(scripted(["fail"]), { ended })), withMetrics)
  })

  it.effect("should record each poll's duration", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")

      const metrics = yield* Metric.snapshot
      const duration = metrics.find((metric) => metric.id === "sportal_poll_duration")
      assert.strictEqual(duration?.type === "Histogram" ? duration.state.count : undefined, 2)
    }).pipe(Effect.provide(ingesting(scripted([[scoring(0)], [scoring(7)]]))), withMetrics)
  )

  it.effect("should append a frame the live feed gives, taking its delivery", () =>
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<Offered>()
      const subscriptions = yield* Ref.make(0)
      const frame = yield* pushed(Delivery.cases.Snapshot.make({ snapshot: scoring(7), from: "push" }), "fbs")

      const { listed, logged } = yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* Queue.offer(feed, frame)
        yield* TestClock.adjust("100 millis")

        const listed = yield* slateOf()
        const logged = yield* logOf(2)
        return { listed, logged }
      }).pipe(
        Effect.provide(ingesting(scripted([[scoring(0)]], { push: () => feeding(feed, subscriptions) })))
      )

      assert.strictEqual(listed[0]?.home.score, 7)
      assert.deepStrictEqual(
        logged.map(({ seq, source }) => [seq, source]),
        [
          [1, "poll"],
          [2, "push"]
        ]
      )
    })
  )

  it.effect("should bring a channel the decoder resyncs to the live feed", () =>
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<Offered>()
      const resynced = yield* Ref.make<ReadonlyArray<string>>([])
      const frame = yield* pushed({ _tag: "Resync" }, "gp-football-college-football-1")

      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* Queue.offer(feed, frame)
        yield* TestClock.adjust(0)
      }).pipe(Effect.provide(ingesting(scripted([[scoring(0)]], { push: resyncsRecorded(feed, resynced) }))))

      const channels = yield* Ref.get(resynced)
      assert.deepStrictEqual(channels, ["gp-football-college-football-1"])
    })
  )

  it.effect("should not want a game before it is current", () =>
    Effect.gen(function* () {
      const wanted = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
      const scheduled = yield* scheduledJustBeforeCurrent()

      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("1 minute")
      }).pipe(Effect.provide(ingesting(scripted([[scheduled]], { push: wantedRecorded(wanted) }))))

      const asked = yield* Ref.get(wanted)
      assert.deepStrictEqual(asked, [[]])
    })
  )

  it.effect("should want a game once it is current", () =>
    Effect.gen(function* () {
      const wanted = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
      const scheduled = yield* scheduledJustBeforeCurrent()

      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("2 minutes")
      }).pipe(Effect.provide(ingesting(scripted([[scheduled]], { push: wantedRecorded(wanted) }))))

      const asked = yield* Ref.get(wanted)
      assert.deepStrictEqual(asked, [[], ["1"]])
    })
  )

  it.effect("should subscribe to the live feed once at the start", () =>
    Effect.gen(function* () {
      const { feed, subscriptions, polls } = yield* reconnectingOnceState()

      yield* TestClock.adjust(0).pipe(Effect.provide(ingesting(reconnectingOnce(feed, subscriptions, polls))))

      const subscribed = yield* Ref.get(subscriptions)
      assert.strictEqual(subscribed, 1)
    })
  )

  it.effect("should subscribe again to a failing push on the provider's reconnect, logging no stop", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      const { feed, subscriptions, polls } = yield* reconnectingOnceState()

      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* Queue.offer(feed, closed)
        // `Schedule.recurs(1)` retries with no delay, so the clock need not move.
        yield* TestClock.adjust(0)
      }).pipe(Effect.provide(ingesting(reconnectingOnce(feed, subscriptions, polls))))

      const subscribed = yield* Ref.get(subscriptions)
      assert.strictEqual(subscribed, 2)
      assert.lengthOf(feedStopped(logs), 0)
    }).pipe(Effect.provide(layer), withMetrics)
  })

  it.effect("should end the live feed logged once its reconnect is done, polling on", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      const { feed, subscriptions, polls } = yield* reconnectingOnceState()

      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* Queue.offer(feed, closed)
        yield* TestClock.adjust(0)
        yield* Queue.offer(feed, closed)
        yield* TestClock.adjust("20 seconds")
      }).pipe(Effect.provide(ingesting(reconnectingOnce(feed, subscriptions, polls))))

      const errors = yield* counted("sportal_live_feed_errors", { reason: "Closed" })
      const subscribed = yield* Ref.get(subscriptions)
      const polledTimes = yield* Ref.get(polls)
      const stopped = feedStopped(logs)
      assert.strictEqual(subscribed, 2)
      assert.lengthOf(stopped, 1)
      assert.include(String(stopped[0]?.cause), "socket closed")
      assert.strictEqual(errors, 2)
      assert.isAtLeast(polledTimes, 3)
    }).pipe(Effect.provide(layer), withMetrics)
  })

  it.effect("should count a push that fails with Silent by reason, subscribing again", () =>
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<Offered>()
      const subscriptions = yield* Ref.make(0)
      const silent = new ProviderUnavailable({ reason: "Silent", cause: "no message for 45 s" })

      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* Queue.offer(feed, silent)
        yield* TestClock.adjust("2 seconds")
      }).pipe(
        Effect.provide(ingesting(scripted([[scoring(0)]], { push: () => feeding(feed, subscriptions) })))
      )

      const errors = yield* counted("sportal_live_feed_errors", { reason: "Silent" })
      const subscribed = yield* Ref.get(subscriptions)
      assert.strictEqual(subscribed, 2)
      assert.strictEqual(errors, 1)
    }).pipe(withMetrics)
  )

  it.effect.each([
    ["completes", Stream.empty, "the feed's stream ended"],
    ["dies, with its defect", Stream.die("socket handler threw"), "socket handler threw"]
  ] as const)("should log at Error a live feed that %s, the poll carrying on", ([_name, frames, why]) => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      const polls = yield* polledFor20SecondsOver(frames)

      const stopped = feedStopped(logs)
      assert.strictEqual(stopped.length, 1)
      assert.include(`${stopped[0]?.message} ${stopped[0]?.cause}`, why)
      assert.isAtLeast(polls, 3)
    }).pipe(Effect.provide(layer))
  })

  it.effect("should log no Error stopping", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("10 seconds")
      }).pipe(Effect.provide(ingesting(scripted([[scoring(0)]]))))

      const errors = logs.filter((log) => log.level === "Error").map((log) => log.message)
      assert.deepStrictEqual(errors, [])
    }).pipe(Effect.provide(layer))
  })

  it.live(
    "should close within the feed log's shutdown bound, with every frame appended just before it written",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const scope = yield* Scope.make()
        const services = yield* Layer.buildWithScope(over(scripted([[scoring(0)]])), scope)
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

        const [row] = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM feed_frame WHERE source = 'push' AND kind = 'change'
        `
        assert.isBelow(Duration.toMillis(took), Duration.toMillis(Duration.seconds(1)))
        assert.strictEqual(row?.count, 200)
      }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer])),
    10_000
  )

  it.effect("should replay quietly the frames logged before Ingest started", () => {
    const ended: Array<Tracer.Span> = []
    const { logs, layer: logged } = recordingLogs()
    return Effect.gen(function* () {
      yield* loggedBefore([
        pollOf([liveSnapshot({ id: GameId.make("1"), period: 2 })]),
        pollOf([liveSnapshot({ id: GameId.make("1"), period: 3 })])
      ])

      const replayed = yield* LiveSlate.use((liveSlate) => liveSlate.latest).pipe(
        Effect.provide(nextPollOver(ended, logged))
      )

      const snapshots = yield* counted("sportal_snapshots")
      const replay = ended.find((span) => span.name === "LiveSlate.replay")
      assert.deepStrictEqual(replayed.seq, Option.some(2))
      assert.strictEqual(replayed.live.get(GameId.make("1"))?.snapshot.period, 3)
      assert.isUndefined(snapshots)
      assert.isFalse(logs.some((log) => log.message.includes("started")))
      assert.strictEqual(replay?.attributes.get("sportal.frames"), 2)
      assert.strictEqual(replay?.attributes.get("sportal.deliveries"), 2)
    }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer]), withMetrics)
  })

  it.effect("should append its first poll after the frames the slate replayed", () => {
    const { layer: logged } = recordingLogs()
    return Effect.gen(function* () {
      yield* loggedBefore([
        pollOf([liveSnapshot({ id: GameId.make("1"), period: 2 })]),
        pollOf([liveSnapshot({ id: GameId.make("1"), period: 3 })])
      ])

      const polledSlate = yield* Effect.gen(function* () {
        const liveSlate = yield* LiveSlate

        yield* TestClock.adjust(0)

        return yield* liveSlate.latest
      }).pipe(Effect.provide(nextPollOver([], logged)))

      assert.deepStrictEqual(polledSlate.seq, Option.some(3))
      assert.strictEqual(polledSlate.live.get(GameId.make("1"))?.snapshot.period, 4)
    }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer]), withMetrics)
  })
})

describe("Ingest.layer", () => {
  it.effect("should ask the live feed to follow the current games", () =>
    Effect.gen(function* () {
      const asks = yield* Queue.unbounded<void>()
      const heads = yield* Queue.unbounded<Option.Option<LiveFeedDemand>>()

      const now = yield* DateTime.now
      const live = liveSnapshot({ id: one })
      const soon = snapshot({ id: two, kickoff: DateTime.add(now, { minutes: 20 }) })
      const later = snapshot({ id: three, kickoff: DateTime.add(now, { hours: 3 }) })

      const first = yield* Effect.gen(function* () {
        yield* listing([live, soon, later])
        yield* Queue.offer(asks, undefined)
        return yield* Queue.take(heads)
      }).pipe(Effect.provide(ingesting(scripted([], { push: demandHeads(asks, heads) }))))

      assert.deepStrictEqual(first, Option.some(LiveFeedDemand.Games({ games: [live, soon] })))
    })
  )

  it.effect("should ask again only when the games' ids change", () =>
    Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>()
      const demanded = yield* Queue.unbounded<LiveFeedDemand>()
      const ids = Queue.take(demanded).pipe(
        Effect.map((demand) =>
          LiveFeedDemand.$is("Games")(demand) ? demand.games.map((game) => game.id) : []
        )
      )

      const { first, next } = yield* Effect.gen(function* () {
        yield* takenSnapshot(liveSnapshot({ id: one }))
        yield* Deferred.succeed(subscribed, undefined)
        const first = yield* ids

        yield* takenSnapshot(liveSnapshot({ id: one, clock: "8:00" }))
        yield* takenSnapshot(liveSnapshot({ id: two }))
        const next = yield* ids

        return { first, next }
      }).pipe(Effect.provide(ingesting(scripted([], { push: demandOnceSubscribed(subscribed, demanded) }))))

      assert.deepStrictEqual(first, [one])
      assert.deepStrictEqual(next, [one, two])
    })
  )

  it.effect("should ask the live feed to resync a channel the decoder dropped", () =>
    Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>()
      const demanded = yield* Queue.unbounded<LiveFeedDemand>()
      yield* Deferred.succeed(subscribed, undefined)

      const { current, carried, rest } = yield* Effect.gen(function* () {
        const current = yield* Queue.take(demanded)
        const resync = yield* pushed({ _tag: "Resync" }, "live-topic")

        yield* appended(resync)
        const carried = yield* Queue.take(demanded)
        const rest = yield* Queue.poll(demanded)

        return { current, carried, rest }
      }).pipe(Effect.provide(ingesting(scripted([], { push: demandOnceSubscribed(subscribed, demanded) }))))

      assert.deepStrictEqual(current, LiveFeedDemand.Games({ games: [] }))
      assert.deepStrictEqual(carried, LiveFeedDemand.Resync({ channel: "live-topic" }))
      assert.isTrue(Option.isNone(rest))
    })
  )

  it.effect("should ask a live feed subscribed again for the current games again", () =>
    Effect.gen(function* () {
      const asks = yield* Queue.unbounded<void>()
      const heads = yield* Queue.unbounded<Option.Option<LiveFeedDemand>>()

      const { first, second } = yield* Effect.gen(function* () {
        yield* takenSnapshot(liveSnapshot({ id: one }))
        yield* Queue.offer(asks, undefined)
        const first = yield* Queue.take(heads)
        yield* takenSnapshot(liveSnapshot({ id: two }))

        yield* Queue.offer(asks, undefined)
        const second = yield* Queue.take(heads)

        return { first, second }
      }).pipe(Effect.provide(ingesting(scripted([], { push: demandHeads(asks, heads) }))))

      assert.deepStrictEqual(first, Option.some(LiveFeedDemand.Games({ games: [liveSnapshot({ id: one })] })))
      assert.deepStrictEqual(
        second,
        Option.some(LiveFeedDemand.Games({ games: [liveSnapshot({ id: one }), liveSnapshot({ id: two })] }))
      )
    })
  )
})

const one = GameId.make("1")
const two = GameId.make("2")
const three = GameId.make("3")

/** `over`, on a fresh in-memory database. */
function ingesting(provider: Layer.Layer<Provider>, options: Parameters<typeof over>[1] = {}) {
  return over(provider, options).pipe(Layer.provide([Database.layerMemory, NodeCrypto.layer]))
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
    Layer.provideMerge(LiveSlate.layer),
    Layer.provideMerge(FeedLog.layer),
    Layer.provide([
      provider,
      TestSnapshotFeed.layerDecoder,
      HubConfig.layerTest({ SPORTAL_LEAGUES: (options.leagues ?? ["fbs"]).join(",") }).pipe(Layer.orDie),
      DateTime.layerCurrentZoneLocal
    ]),
    Layer.provideMerge(recordingSpans(options.ended ?? []))
  )
}

/** Ingest over a live feed of `frames` that stops without failing, for 20 seconds: how many times it polled. */
function polledFor20SecondsOver(frames: Stream.Stream<Frame>) {
  return Effect.gen(function* () {
    const polls = yield* Ref.make(0)
    const provider = TestSnapshotFeed.layer({
      games: () => Ref.update(polls, (n) => n + 1).pipe(Effect.as([scoring(0)])),
      push: frames
    })

    yield* Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("20 seconds")
    }).pipe(Effect.provide(ingesting(provider)))

    return yield* Ref.get(polls)
  })
}

/** The Error logs saying the live feed stopped. */
function feedStopped(logs: ReturnType<typeof recordingLogs>["logs"]) {
  return logs.filter((log) => log.level === "Error" && log.message.includes("the live feed stopped"))
}

/** Records the test clock's time in `calls`. */
function timeRecorded(calls: Ref.Ref<ReadonlyArray<number>>) {
  return Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.update(calls, (all) => [...all, now])))
}

/** Polling every 10 seconds that records each input it is given: the slate's home scores, and the failed leagues. */
function inputsRecorded(
  inputs: Ref.Ref<ReadonlyArray<readonly [ReadonlyArray<number>, ReadonlyArray<string>]>>
) {
  return Schedule.spaced("10 seconds").pipe(
    Schedule.setInputType<Schedule.Input<Polling>>(),
    Schedule.tap(({ input }) =>
      Ref.update(inputs, (all) => [
        ...all,
        [input.slate.map((game) => game.home.score), input.failed] as const
      ])
    )
  )
}

/** A provider polled every second, counting its polls in `polls`, whose second poll's body does not decode. */
function secondPollUndecodable(polls: Ref.Ref<number>) {
  return Layer.succeed(
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
}

/** A push of the frames offered to `feed`, recording in `resynced` each channel the slate's demand resyncs. */
function resyncsRecorded(feed: Queue.Queue<Offered>, resynced: Ref.Ref<ReadonlyArray<string>>): LiveFeed {
  return (demand) =>
    Stream.fromQueue(feed).pipe(
      Stream.filterMap((offered) =>
        Schema.is(ProviderUnavailable)(offered) ? Result.failVoid : Result.succeed(offered)
      ),
      Stream.merge(
        demand.pipe(
          Stream.filter(LiveFeedDemand.$is("Resync")),
          Stream.mapEffect(({ channel }) => Ref.update(resynced, (all) => [...all, channel])),
          Stream.drain
        )
      )
    )
}

/**
 * A scheduled game kicking off two minutes past when it would be current, so a test reaches the boundary in two
 * minutes of test clock: each minute it moves wakes the poll and the feed log's writer many times over.
 */
function scheduledJustBeforeCurrent() {
  return Effect.gen(function* () {
    const now = yield* DateTime.now
    const kickoff = DateTime.addDuration(now, Duration.sum(LiveGame.currentBefore, Duration.minutes(2)))

    return snapshot({ id: GameId.make("1"), status: "scheduled", kickoff })
  })
}

/** A push that never pushes, recording in `wanted` the ids of each set of games the slate's demand wants. */
function wantedRecorded(wanted: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>): LiveFeed {
  return (demand) =>
    demand.pipe(
      Stream.filter(LiveFeedDemand.$is("Games")),
      Stream.mapEffect(({ games }) =>
        Ref.update(wanted, (all) => [...all, games.map((wantedGame) => wantedGame.id)])
      ),
      Stream.drain,
      Stream.concat(Stream.never)
    )
}

/** What `reconnectingOnce` is fed and counts: its push's queue, its subscriptions, and its polls. */
function reconnectingOnceState() {
  return Effect.gen(function* () {
    const feed = yield* Queue.unbounded<Offered>()
    const subscriptions = yield* Ref.make(0)
    const polls = yield* Ref.make(0)

    return { feed, subscriptions, polls }
  })
}

/** A provider whose push reads `feed`, subscribed again once when it fails, counting its polls in `polls`. */
function reconnectingOnce(
  feed: Queue.Queue<Offered>,
  subscriptions: Ref.Ref<number>,
  polls: Ref.Ref<number>
) {
  return TestSnapshotFeed.layer({
    games: () => Ref.update(polls, (n) => n + 1).pipe(Effect.as([scoring(0)])),
    push: feeding(feed, subscriptions),
    reconnect: Schedule.recurs(1)
  })
}

/** Ingest whose next poll lists game 1 in period 4, each span that ends recorded in `ended`, logging to `logged`. */
function nextPollOver(ended: Array<Tracer.Span>, logged: Layer.Layer<never>) {
  return over(scripted([[liveSnapshot({ id: GameId.make("1"), period: 4 })]]), { ended }).pipe(
    Layer.provideMerge(logged)
  )
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
  const { polling, push } = options
  const snapshotFeed = Layer.unwrap(
    Effect.map(Ref.make(0), (calls) =>
      TestSnapshotFeed.layer({
        games: (league) =>
          Ref.getAndUpdate(calls, (call) => call + 1).pipe(
            Effect.flatMap((call) => {
              const response = responses[Math.min(call, responses.length - 1)]
              return response === "fail" || response === undefined
                ? Effect.fail(new ProviderUnavailable({ reason: "Unreachable", league, cause: "down" }))
                : Effect.succeed(response)
            }),
            Effect.withSpan("provider.poll")
          ),
        ...(polling === undefined ? {} : { polling })
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

/** A push that never pushes, offering to `heads` the first thing its demand asks each time `asks` is offered to. */
function demandHeads(asks: Queue.Queue<void>, heads: Queue.Queue<Option.Option<LiveFeedDemand>>): LiveFeed {
  return (demand) =>
    Stream.fromQueue(asks).pipe(
      Stream.mapEffect(() => Stream.runHead(demand).pipe(Effect.flatMap((head) => Queue.offer(heads, head)))),
      Stream.drain
    )
}

/** A push that never pushes, offering to `demanded` everything its demand asks once `subscribed` is done. */
function demandOnceSubscribed(
  subscribed: Deferred.Deferred<void>,
  demanded: Queue.Queue<LiveFeedDemand>
): LiveFeed {
  return (demand) =>
    Stream.fromEffect(Deferred.await(subscribed)).pipe(
      Stream.flatMap(() => demand),
      Stream.mapEffect((asked) => Queue.offer(demanded, asked)),
      Stream.drain
    )
}

/** An fbs listing of `games`, received now, once the slate has taken it. */
function listing(games: ReadonlyArray<GameSnapshot>) {
  return delivered(Delivery.cases.Listing.make({ league: "fbs", games }))
}

/** A poll snapshot of `game`, received now, once the slate has taken it. */
function takenSnapshot(game: GameSnapshot) {
  return delivered(Delivery.cases.Snapshot.make({ snapshot: game, from: "poll" }))
}

/** The error that ends a push's stream as the socket closing. */
const closed = new ProviderUnavailable({ reason: "Closed", cause: "socket closed" })

/** What a test offers its push: a frame, or the error that ends the push's stream. */
type Offered = Frame | ProviderUnavailable

/** A push reading `feed`, counting each subscription to it in `subscriptions`. */
function feeding(feed: Queue.Queue<Offered>, subscriptions: Ref.Ref<number>) {
  return Stream.unwrap(
    Ref.update(subscriptions, (n) => n + 1).pipe(
      Effect.as(
        Stream.fromQueue(feed).pipe(
          Stream.mapEffect((offered) =>
            Schema.is(ProviderUnavailable)(offered) ? Effect.fail(offered) : Effect.succeed(offered)
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
    Effect.provide(TestSnapshotFeed.layer({ games: () => Effect.succeed(games) })),
    Effect.orDie
  )
}

/** The fbs listing as the slate has it. */
function slateOf() {
  return Effect.gen(function* () {
    const liveSlate = yield* LiveSlate
    const latest = yield* liveSlate.latest

    return latest.games(["fbs"])
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
function loggedBefore(frames: ReadonlyArray<Effect.Effect<Frame>>) {
  return Effect.gen(function* () {
    const log = yield* FeedLog
    yield* Effect.forEach(frames, (frame) => Effect.flatMap(frame, log.append), { discard: true })
  }).pipe(Effect.provide(FeedLog.layer), Effect.scoped)
}
