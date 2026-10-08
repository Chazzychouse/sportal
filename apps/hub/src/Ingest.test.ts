import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { liveSnapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Duration, Effect, Exit, Layer, Schedule, Scope, Stream, type Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import type { Frame } from "./Frame.ts"
import { FeedLog } from "./feed-log/FeedLog.ts"
import * as Ingest from "./Ingest.ts"
import { Board } from "./slate/Board.ts"
import { BoardTelemetry } from "./slate/BoardTelemetry.ts"
import { Delivery } from "./slate/Delivery.ts"
import { takingAfter } from "./TestBoard.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"
import { pushed } from "./TestSnapshotFeed.ts"
import { counted, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

describe("Ingest", () => {
  it.effect("should append every frame the provider delivers to the feed log", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("100 millis")

      const logged = yield* logOf(3)

      assert.deepStrictEqual(
        logged.map(({ seq, source, channel }) => [seq, source, channel]),
        [
          [1, "poll", "nfl"],
          [2, "poll", "fbs"],
          [3, "push", "fbs"]
        ]
      )
    }).pipe(Effect.provide(ingesting(listedThenPushed)))
  )

  it.effect("should bring every frame it appends to the slate", () =>
    Effect.gen(function* () {
      const current = yield* takingAfter(3, TestClock.adjust(0))

      assert.deepStrictEqual(
        [...current.listed].map(([league, games]) => [league, games.map((listed) => listed.id)]),
        [
          ["nfl", ["1"]],
          ["fbs", ["1"]]
        ]
      )
      assert.strictEqual(current.listedGames(["fbs"])[0]?.home.score, 7)
    }).pipe(Effect.provide(ingesting(listedThenPushed)))
  )

  it.effect.each([
    ["complete", Stream.empty, "the provider's frames ended"],
    ["die, with their defect", Stream.die("socket handler threw"), "socket handler threw"]
  ] as const)("should log when the provider's frames stop: they %s", ([_name, frames, why]) => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* TestClock.adjust(0).pipe(Effect.provide(ingesting(frames)))

      const stopped = framesStopped(logs)
      assert.strictEqual(stopped.length, 1)
      assert.include(`${stopped[0]?.message} ${stopped[0]?.cause}`, why)
    }).pipe(Effect.provide(layer))
  })

  it.effect("should log no Error stopping", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("10 seconds")
      }).pipe(Effect.provide(ingesting(listedThenPushed)))

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
        const services = yield* Layer.buildWithScope(over(Stream.never), scope)
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
        listedNow("fbs", [liveSnapshot({ id: GameId.make("1"), period: 2 })]),
        listedNow("fbs", [liveSnapshot({ id: GameId.make("1"), period: 3 })])
      ])

      const replayed = yield* Board.use((board) => board.latest).pipe(
        Effect.provide(over(Stream.never, { ended }).pipe(Layer.provideMerge(logged)))
      )

      const snapshots = yield* counted("sportal_snapshots")
      const replay = ended.find((span) => span.name === "LiveSlate.replay")
      assert.strictEqual(replayed.games.get(GameId.make("1"))?.period, 3)
      assert.isUndefined(snapshots)
      assert.isFalse(logs.some((log) => log.message.includes("started")))
      assert.strictEqual(replay?.attributes.get("sportal.frames"), 2)
      assert.strictEqual(replay?.attributes.get("sportal.deliveries"), 2)
    }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer]), withMetrics)
  })

  it.effect("should append its first frame after the frames the slate replayed", () => {
    const { layer: logged } = recordingLogs()
    return Effect.gen(function* () {
      yield* loggedBefore([
        listedNow("fbs", [liveSnapshot({ id: GameId.make("1"), period: 2 })]),
        listedNow("fbs", [liveSnapshot({ id: GameId.make("1"), period: 3 })])
      ])
      const next = framesOf([listedNow("fbs", [liveSnapshot({ id: GameId.make("1"), period: 4 })])])

      const polledSlate = yield* takingAfter(1, TestClock.adjust(0)).pipe(
        Effect.provide(over(next).pipe(Layer.provideMerge(logged)))
      )

      const seqs = yield* FeedLog.use((log) =>
        log.replay(DateTime.makeUnsafe(0)).pipe(
          Stream.map(({ seq }) => seq),
          Stream.runCollect
        )
      ).pipe(Effect.provide(FeedLog.layer))
      assert.strictEqual(polledSlate.games.get(GameId.make("1"))?.period, 4)
      assert.deepStrictEqual(seqs, [1, 2, 3])
    }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer]), withMetrics)
  })
})

/** `over`, on a fresh in-memory database. */
function ingesting(frames: Stream.Stream<Frame>) {
  return over(frames).pipe(Layer.provide([Database.layerMemory, NodeCrypto.layer]))
}

/**
 * Ingest over the snapshot feed delivering `frames`, with the board and the feed log they share also provided to
 * the test, and each span that ends recorded in `ended`.
 */
function over(frames: Stream.Stream<Frame>, options: { readonly ended?: Array<Tracer.Span> } = {}) {
  return Ingest.layer.pipe(
    Layer.provideMerge(Board.layer),
    Layer.provideMerge(FeedLog.layer),
    Layer.provide(BoardTelemetry.layer),
    Layer.provide([TestSnapshotFeed.layerFrom(frames), DateTime.layerCurrentZoneLocal]),
    Layer.provideMerge(recordingSpans(options.ended ?? []))
  )
}

/** The frames `made` makes, in order, then none more: a provider that runs on. */
function framesOf(made: ReadonlyArray<Effect.Effect<Frame>>): Stream.Stream<Frame> {
  return Stream.fromIterable(made).pipe(
    Stream.mapEffect((frame) => frame),
    Stream.concat(Stream.never)
  )
}

/** Game 1 listed by the NFL and by FBS at 0 points, then pushed at 7 on fbs. */
const listedThenPushed = framesOf([
  listedNow("nfl", [liveSnapshot({ id: GameId.make("1") })]),
  listedNow("fbs", [scoring(0)]),
  pushed(Delivery.cases.Snapshot.make({ snapshot: scoring(7), from: "push" }), "fbs")
])

/** The Error logs saying the provider's frames stopped. */
function framesStopped(logs: ReturnType<typeof recordingLogs>["logs"]) {
  return logs.filter((log) => log.level === "Error" && log.message.includes("the provider's frames stopped"))
}

/** A snapshot feed poll of `league` listing `games`, received now. */
function listedNow(league: LeagueId, games: ReadonlyArray<GameSnapshot>) {
  return Effect.map(DateTime.now, (at) =>
    TestSnapshotFeed.framed(Delivery.cases.Listing.make({ league, games }), at)
  )
}

/** Game 1, live, its home team at `n` points. */
function scoring(n: number) {
  return liveSnapshot({ home: { team: team("HOME"), score: n } })
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
