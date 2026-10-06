import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, FileSystem, Layer, Path, Ref, Stream, type Tracer } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { TestClock } from "effect/testing"
import { FeedLog } from "./FeedLog.ts"
import * as TestDatabase from "./TestDatabase.ts"
import { withEnv } from "./TestHubConfig.ts"
import { counted, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

describe("FeedLog", () => {
  it.effect(
    "numbers appended frames consecutively, and a subscription emits them in that order, from when it subscribed",
    () =>
      Effect.gen(function* () {
        const log = yield* FeedLog
        const frames = yield* log.subscribe

        const appended = yield* Effect.forEach(
          [poll("nfl", "{}", 0), message("event-football-nfl", "[]", 1, 7), poll("fbs", "{}", 2)],
          log.append,
          { concurrency: "unbounded" }
        )

        assert.deepStrictEqual(
          appended.map((frame) => frame.seq),
          [1, 2, 3]
        )
        assert.deepStrictEqual(yield* frames.pipe(Stream.take(3), Stream.runCollect), appended)
      }).pipe(Effect.scoped, Effect.provide(feedLog))
  )

  it.effect("writes appended frames within 100 ms, and replays them as they were appended", () =>
    Effect.gen(function* () {
      const log = yield* FeedLog
      const appended = yield* Effect.forEach(
        [
          poll("nfl", '{"events":[]}', 0),
          message("event-football-nfl", '{"op":"P"}', 5, 41),
          checkpoint("gp-football-nfl-401872971", '{"entities":{}}', 9, 42)
        ],
        log.append
      )
      yield* TestClock.withLive(Effect.sleep("20 millis"))
      assert.strictEqual(yield* rowCount, 0)

      yield* TestClock.adjust("100 millis")
      yield* written(3)

      assert.deepStrictEqual(yield* Stream.runCollect(log.replay(at(0))), appended)
    }).pipe(Effect.provide(feedLog))
  )

  it.effect("appending frames opens no span; storing them does", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      const log = yield* FeedLog
      yield* Effect.forEach([poll("nfl", "{}", 0), poll("fbs", "{}", 1)], log.append)
      yield* TestClock.adjust("100 millis")
      yield* written(2)

      assert.isFalse(ended.some((span) => span.name === "FeedLog.append"))
      assert.isTrue(ended.some((span) => span.name === "FeedLog.store"))
    }).pipe(Effect.provide(feedLog), Effect.provide(recordingSpans(ended)))
  })

  it.effect("stores an unchanged poll response once per channel, and replays every one with its body", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const log = yield* FeedLog
      const appended = yield* Effect.forEach(
        [poll("nfl", "same", 0), poll("nfl", "same", 10), poll("nfl", "same", 20), poll("fbs", "same", 30)],
        log.append
      )
      yield* TestClock.adjust("100 millis")
      yield* written(4)

      const rows = yield* sql<{ channel: string; kind: string; stored: number }>`
        SELECT channel, kind, body IS NOT NULL AS stored FROM feed_frame ORDER BY seq
      `
      assert.deepStrictEqual(rows, [
        { channel: "nfl", kind: "response", stored: 1 },
        { channel: "nfl", kind: "unchanged", stored: 0 },
        { channel: "nfl", kind: "unchanged", stored: 0 },
        { channel: "fbs", kind: "response", stored: 1 }
      ])
      assert.deepStrictEqual(yield* Stream.runCollect(log.replay(at(0))), appended)
    }).pipe(Effect.provide(feedLog))
  )

  it.effect("replays from the first frame received at or after the given instant", () =>
    Effect.gen(function* () {
      const log = yield* FeedLog
      const appended = yield* Effect.forEach(
        [poll("nfl", "slate", 0), message("socket", "B", 500, 1), poll("nfl", "slate", 1_000)],
        log.append
      )
      yield* TestClock.adjust("100 millis")
      yield* written(3)

      assert.deepStrictEqual(yield* Stream.runCollect(log.replay(at(500))), appended.slice(1))
      // An unchanged poll after the start still carries the body stored before it.
      assert.deepStrictEqual(yield* Stream.runCollect(log.replay(at(501))), appended.slice(2))
    }).pipe(Effect.provide(feedLog))
  )

  it.effect(
    "starts each topic from its latest checkpoint before the given instant, with the topic's frames after it",
    () =>
      Effect.gen(function* () {
        const log = yield* FeedLog
        const appended = yield* Effect.forEach(
          [
            checkpoint("gp-football-nfl-1", "first", 0, 1),
            poll("nfl", "slate", 10),
            checkpoint("gp-football-nfl-1", "latest", 20, 2),
            message("gp-football-nfl-1", "patch", 30, 3),
            checkpoint("gp-football-nfl-2", "only", 40, 1),
            message("event-football-nfl", "no checkpoint", 50, 9),
            message("gp-football-nfl-1", "after", 500, 4),
            poll("nfl", "slate", 600)
          ],
          log.append
        )
        yield* TestClock.adjust("100 millis")
        yield* written(8)

        assert.deepStrictEqual(yield* Stream.runCollect(log.replay(at(500))), [
          appended[2],
          appended[3],
          appended[4],
          appended[6],
          appended[7]
        ])
      }).pipe(Effect.provide(feedLog))
  )

  it.effect(
    "keeps appending through a failed write, and logs the lost frames as a gap before the next",
    () => {
      const { logs, layer: logged } = recordingLogs()
      return Effect.gen(function* () {
        const failures = yield* Ref.make(0)
        yield* Effect.gen(function* () {
          const log = yield* FeedLog
          yield* Ref.set(failures, 1)
          yield* log.append(message("socket", "lost", 0, 1))
          yield* log.append(message("socket", "lost too", 10, 2))
          yield* TestClock.adjust("100 millis")
          yield* settled(counted("sportal_feed_write_failures"), (failed) => failed === 1)

          const kept = yield* log.append(message("socket", "kept", 200, 3))
          assert.strictEqual(kept.seq, 3)
          yield* TestClock.adjust("100 millis")
          yield* written(2)

          assert.strictEqual(yield* counted("sportal_feed_frames_lost"), 2)
          assert.deepStrictEqual(yield* Stream.runCollect(log.replay(at(0))), [kept])
          const warnings = logs.filter((entry) => entry.level === "Warn")
          assert.strictEqual(warnings.length, 1)
          assert.deepInclude(warnings[0]?.annotations, { from: 1, to: 2, count: 2 })
        }).pipe(Effect.provide(FeedLog.layer.pipe(Layer.provide(failingTransactions(failures)))))
      }).pipe(Effect.provide([TestDatabase.layer(":memory:"), NodeCrypto.layer, logged]), withMetrics)
    }
  )

  it.effect("records a gap left at close, which a replay then warns of, and numbers on past it", () => {
    const { logs, layer: logged } = recordingLogs()
    return Effect.gen(function* () {
      const failures = yield* Ref.make(0)
      yield* Effect.gen(function* () {
        const log = yield* FeedLog
        yield* Ref.set(failures, 1)
        yield* log.append(message("socket", "lost", 0, 1))
        yield* log.append(message("socket", "lost too", 10, 2))
        yield* TestClock.adjust("100 millis")
        yield* settled(counted("sportal_feed_write_failures"), (failed) => failed === 1)
      }).pipe(Effect.provide(FeedLog.layer.pipe(Layer.provide(failingTransactions(failures)))))

      assert.strictEqual(yield* rowCount, 1)
      yield* Effect.gen(function* () {
        const log = yield* FeedLog
        assert.deepStrictEqual(yield* Stream.runCollect(log.replay(at(0))), [])
        // The gap row holds the last lost seq, so reopening numbers on past every lost frame.
        assert.strictEqual((yield* log.append(message("socket", "kept", 200, 3))).seq, 3)
      }).pipe(Effect.provide(FeedLog.layer))
      const warnings = logs.filter((entry) => entry.level === "Warn")
      assert.strictEqual(warnings.length, 1)
      assert.deepInclude(warnings[0]?.annotations, { from: 1, to: 2, count: 2 })
    }).pipe(Effect.provide([TestDatabase.layer(":memory:"), NodeCrypto.layer, logged]), withMetrics)
  })

  it.effect("keeps seqs contiguous when appends are interrupted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const log = yield* FeedLog
      const emitted = yield* Ref.make<ReadonlyArray<number>>([])
      const listening = yield* (yield* log.subscribe).pipe(
        Stream.runForEach((frame) => Ref.update(emitted, (seqs) => [...seqs, frame.seq])),
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestClock.withLive(Effect.sleep("5 millis"))

      const fibers = yield* Effect.forEach(
        Array.from({ length: 2_000 }, (_, index) => index),
        (index) => Effect.forkDetach(log.append(message("socket", `body ${index}`, index, index)))
      )
      // Interrupted while the other appends are running, so some land between an append's steps.
      yield* Effect.forEach(
        fibers.filter((_, index) => index % 2 === 1),
        (fiber) => Fiber.interrupt(fiber),
        { concurrency: "unbounded", discard: true }
      )
      yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { discard: true })
      yield* TestClock.withLive(Effect.sleep("5 millis"))
      const published = yield* Ref.get(emitted)
      yield* Fiber.interrupt(listening)
      yield* settled(
        Effect.andThen(TestClock.adjust("100 millis"), rowCount),
        (rows) => rows >= published.length
      )
      const stored = (yield* sql<{ seq: number }>`SELECT seq FROM feed_frame ORDER BY seq`).map(
        (row) => row.seq
      )

      const contiguous = published.map((_, index) => index + 1)
      assert.isAbove(published.length, 0)
      assert.deepStrictEqual(published, contiguous)
      assert.deepStrictEqual(stored, contiguous)
    }).pipe(Effect.scoped, Effect.provide(feedLog))
  )

  it.effect("writes the frames still waiting when it closes", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const log = yield* FeedLog
        yield* log.append(poll("nfl", "{}", 0))
        yield* log.append(message("socket", "B", 50, 1))
      }).pipe(Effect.provide(FeedLog.layer))

      assert.strictEqual(yield* rowCount, 2)
    }).pipe(Effect.provide([TestDatabase.layer(":memory:"), NodeCrypto.layer]))
  )

  it.effect("continues from the last logged frame when opened again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Effect.gen(function* () {
        const log = yield* FeedLog
        yield* log.append(poll("nfl", "slate", 0))
        yield* log.append(message("socket", "B", 50, 1))
      }).pipe(Effect.provide(FeedLog.layer))

      const reopened = yield* Effect.gen(function* () {
        const log = yield* FeedLog
        return yield* log.append(poll("nfl", "slate", 100))
      }).pipe(Effect.provide(FeedLog.layer))

      assert.strictEqual(reopened.seq, 3)
      const kinds = yield* sql<{ kind: string }>`SELECT kind FROM feed_frame ORDER BY seq`
      assert.deepStrictEqual(
        kinds.map((row) => row.kind),
        ["response", "message", "unchanged"]
      )
    }).pipe(Effect.provide([TestDatabase.layer(":memory:"), NodeCrypto.layer]))
  )

  it.effect("forScenario keeps frames in memory by default, writing no file in the data directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* fs.makeTempDirectoryScoped()
      yield* Effect.gen(function* () {
        const log = yield* FeedLog
        yield* log.append(poll("nfl", "{}", 0))
        yield* TestClock.adjust("100 millis")
        yield* settled(Stream.runCollect(log.replay(at(0))), (frames) => frames.length === 1)
      }).pipe(
        Effect.provide(
          FeedLog.forScenario.pipe(
            Layer.provide([withEnv({ SPORTAL_DATA_DIR: dataDir }), NodeServices.layer, NodeCrypto.layer])
          )
        ),
        Effect.scoped
      )
      assert.deepStrictEqual(yield* fs.readDirectory(dataDir), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps its own feed.sqlite in the Hub's data directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDir = path.join(yield* fs.makeTempDirectoryScoped(), "sportal")
      const config = withEnv({ SPORTAL_DATA_DIR: dataDir })

      yield* Effect.gen(function* () {
        const log = yield* FeedLog
        yield* log.append(poll("nfl", "{}", 0))
      }).pipe(Effect.provide(FeedLog.inDataDir.pipe(Layer.provide(config))))

      assert.deepStrictEqual(yield* fs.readDirectory(dataDir), ["feed.sqlite"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

const feedLog = FeedLog.layer.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(TestDatabase.layer(":memory:"))
)

function at(millis: number) {
  return DateTime.makeUnsafe(millis)
}

function poll(league: string, body: string, receivedAt: number) {
  return { receivedAt: at(receivedAt), feed: "poll", channel: league, kind: "response", body } as const
}

function message(channel: string, body: string, receivedAt: number, mid: number) {
  return {
    receivedAt: at(receivedAt),
    sentAt: at(receivedAt - 1),
    sourceId: mid,
    feed: "fastcast",
    channel,
    kind: "message",
    body
  } as const
}

function checkpoint(topic: string, body: string, receivedAt: number, mid: number) {
  return { ...message(topic, body, receivedAt, mid), kind: "checkpoint" } as const
}

const rowCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM feed_frame`
  return row?.count ?? 0
})

/** Waits, in real time, for the writer to have written `count` rows: it compresses on the event loop. */
function written(count: number) {
  return settled(rowCount, (rows) => rows >= count)
}

function settled<A, E, R>(effect: Effect.Effect<A, E, R>, until: (value: A) => boolean) {
  return effect.pipe(
    Effect.tap(() => TestClock.withLive(Effect.sleep("5 millis"))),
    Effect.repeat({ until })
  )
}

/** The database's client, but its next `failures` transactions fail without running. */
function failingTransactions(failures: Ref.Ref<number>) {
  return Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const withTransaction: SqlClient.SqlClient["withTransaction"] = (self) =>
        Ref.modify(failures, (left) => [left, Math.max(0, left - 1)]).pipe(
          Effect.flatMap((left) =>
            left > 0
              ? Effect.fail(
                  new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause: "disk full" }) })
                )
              : sql.withTransaction(self)
          )
        )
      return new Proxy(sql, {
        get: (target, key, receiver) =>
          key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver)
      })
    })
  )
}
