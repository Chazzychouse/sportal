import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, FileSystem, Layer, Path, Ref, Stream, type Tracer } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { TestClock } from "effect/testing"
import * as Database from "../Database.ts"
import type { Frame } from "../Frame.ts"
import { HubConfig } from "../HubConfig.ts"
import { counted, recordingLogs, recordingSpans, withMetrics } from "../TestTelemetry.ts"
import { FeedLog } from "./FeedLog.ts"

describe("FeedLog", () => {
  it.effect(
    "should number appended frames consecutively, emitting them in that order to a subscription made before",
    () =>
      Effect.gen(function* () {
        const log = yield* FeedLog
        const frames = yield* log.subscribe

        const appended = yield* Effect.forEach(
          [poll("nfl", "{}", 0), message("event-football-nfl", "[]", 1, 7), poll("fbs", "{}", 2)],
          log.append,
          { concurrency: "unbounded" }
        )

        const emitted = yield* frames.pipe(Stream.take(3), Stream.runCollect)
        assert.deepStrictEqual(
          appended.map((frame) => frame.seq),
          [1, 2, 3]
        )
        assert.deepStrictEqual(emitted, appended)
      }).pipe(Effect.scoped, Effect.provide(feedLog))
  )

  it.effect("should not write appended frames before 100 ms", () =>
    Effect.gen(function* () {
      const log = yield* FeedLog

      yield* Effect.forEach(
        [
          poll("nfl", '{"events":[]}', 0),
          message("event-football-nfl", '{"op":"P"}', 5, 41),
          checkpoint("gp-football-nfl-401872971", '{"entities":{}}', 9, 42)
        ],
        log.append
      )
      yield* TestClock.withLive(Effect.sleep("20 millis"))

      const rows = yield* rowCount()
      assert.strictEqual(rows, 0)
    }).pipe(Effect.provide(feedLog))
  )

  it.effect("should write appended frames within 100 ms, replaying them as they were appended", () =>
    Effect.gen(function* () {
      const log = yield* FeedLog

      const appended = yield* appendedAndWritten([
        poll("nfl", '{"events":[]}', 0),
        message("event-football-nfl", '{"op":"P"}', 5, 41),
        checkpoint("gp-football-nfl-401872971", '{"entities":{}}', 9, 42)
      ])

      const replayed = yield* Stream.runCollect(log.replay(at(0)))
      assert.deepStrictEqual(replayed, appended)
    }).pipe(Effect.provide(feedLog))
  )

  it.effect(
    "should keep every row of a populated version 1 log as it was on upgrading, in the frame's words",
    () =>
      Effect.gen(function* () {
        yield* populatedVersionOneLog()

        const after = yield* FeedLog.use(() => storedRows()).pipe(Effect.provide(feedLogOnDatabase))

        assert.deepStrictEqual(after, [
          {
            seq: 1,
            received_at: 1000,
            sent_at: null,
            number: null,
            source: "poll",
            channel: "nfl",
            kind: "whole",
            stored: "blob",
            bytes: "1F8B0800",
            body_hash: "abc"
          },
          {
            seq: 5,
            received_at: 2000,
            sent_at: null,
            number: null,
            source: null,
            channel: null,
            kind: "gap",
            stored: "blob",
            bytes: "05",
            body_hash: null
          },
          {
            seq: 9,
            received_at: 3000,
            sent_at: 2999,
            number: 41,
            source: "push",
            channel: "event-football-nfl",
            kind: "change",
            stored: "blob",
            bytes: "00FF",
            body_hash: null
          }
        ])
      }).pipe(Effect.provide(Database.layerMemory))
  )

  it.effect("should let a pushed frame into an upgraded version 1 log, numbered after its last row", () =>
    Effect.gen(function* () {
      yield* populatedVersionOneLog()

      const frame = yield* Effect.gen(function* () {
        const log = yield* FeedLog

        const frame = yield* log.append({
          receivedAt: at(4000),
          source: "push",
          channel: "fbs",
          kind: "whole",
          body: "{}"
        })
        yield* TestClock.adjust("100 millis")
        yield* written(4)

        return frame
      }).pipe(Effect.provide(feedLogOnDatabase))

      const after = yield* storedRows()
      assert.strictEqual(frame.seq, 10)
      assert.deepStrictEqual(
        after.map(({ seq, source, stored }) => [seq, source, stored]),
        [
          [1, "poll", "blob"],
          [5, null, "blob"],
          [9, "push", "blob"],
          [10, "push", "blob"]
        ]
      )
    }).pipe(Effect.provide(Database.layerMemory))
  )

  it.effect("should keep a version 1 log's indexes on upgrading", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* populatedVersionOneLog()

      yield* FeedLog.pipe(Effect.provide(feedLogOnDatabase))

      const indexes = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'feed_frame' AND name LIKE 'feed_frame_%'
        ORDER BY name
      `
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        ["feed_frame_channel_seq", "feed_frame_received_at"]
      )
    }).pipe(Effect.provide(Database.layerMemory))
  )

  it.effect("should open no span appending frames, and one storing them", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* appendedAndWritten([poll("nfl", "{}", 0), poll("fbs", "{}", 1)])

      assert.isFalse(ended.some((span) => span.name === "FeedLog.append"))
      assert.isTrue(ended.some((span) => span.name === "FeedLog.store"))
    }).pipe(Effect.provide(feedLog.pipe(Layer.provideMerge(recordingSpans(ended)))))
  })

  it.effect(
    "should store an unchanged poll response once per channel, replaying every one with its body",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const log = yield* FeedLog

        const appended = yield* appendedAndWritten([
          poll("nfl", "same", 0),
          poll("nfl", "same", 10),
          poll("nfl", "same", 20),
          poll("fbs", "same", 30)
        ])

        const rows = yield* sql<{ channel: string; kind: string; stored: number }>`
        SELECT channel, kind, body IS NOT NULL AS stored FROM feed_frame ORDER BY seq
      `
        const replayed = yield* Stream.runCollect(log.replay(at(0)))
        assert.deepStrictEqual(rows, [
          { channel: "nfl", kind: "whole", stored: 1 },
          { channel: "nfl", kind: "unchanged", stored: 0 },
          { channel: "nfl", kind: "unchanged", stored: 0 },
          { channel: "fbs", kind: "whole", stored: 1 }
        ])
        assert.deepStrictEqual(replayed, appended)
      }).pipe(Effect.provide(feedLog))
  )

  it.effect("should replay from the first frame received at the given instant", () =>
    Effect.gen(function* () {
      const log = yield* FeedLog
      const appended = yield* appendedAndWritten(pollMessagePoll)

      const replayed = yield* Stream.runCollect(log.replay(at(500)))

      assert.deepStrictEqual(replayed, appended.slice(1))
    }).pipe(Effect.provide(feedLog))
  )

  it.effect(
    "should replay from the first frame received after the given instant, with the body stored before it",
    () =>
      Effect.gen(function* () {
        const log = yield* FeedLog
        const appended = yield* appendedAndWritten(pollMessagePoll)

        const replayed = yield* Stream.runCollect(log.replay(at(501)))

        // An unchanged poll after the start still carries the body stored before it.
        assert.deepStrictEqual(replayed, appended.slice(2))
      }).pipe(Effect.provide(feedLog))
  )

  it.effect(
    "should start each topic from its latest checkpoint before the given instant, with the topic's frames after it",
    () =>
      Effect.gen(function* () {
        const log = yield* FeedLog
        const appended = yield* appendedAndWritten([
          checkpoint("gp-football-nfl-1", "first", 0, 1),
          poll("nfl", "slate", 10),
          checkpoint("gp-football-nfl-1", "latest", 20, 2),
          message("gp-football-nfl-1", "patch", 30, 3),
          checkpoint("gp-football-nfl-2", "only", 40, 1),
          message("event-football-nfl", "no checkpoint", 50, 9),
          message("gp-football-nfl-1", "after", 500, 4),
          poll("nfl", "slate", 600)
        ])

        const replayed = yield* Stream.runCollect(log.replay(at(500)))

        assert.deepStrictEqual(replayed, [appended[2], appended[3], appended[4], appended[6], appended[7]])
      }).pipe(Effect.provide(feedLog))
  )

  it.effect(
    "should keep appending through a failed write, logging the lost frames as a gap before the next",
    () => {
      const { logs, layer: logged } = recordingLogs()
      return Effect.gen(function* () {
        const failures = yield* Ref.make(0)

        const { kept, lost, replayed } = yield* Effect.gen(function* () {
          const log = yield* FeedLog
          yield* lostToAFailedWrite(failures)

          const kept = yield* log.append(message("socket", "kept", 200, 3))
          yield* TestClock.adjust("100 millis")
          yield* written(2)

          const lost = yield* counted("sportal_feed_frames_lost")
          const replayed = yield* Stream.runCollect(log.replay(at(0)))
          return { kept, lost, replayed }
        }).pipe(Effect.provide(FeedLog.layer.pipe(Layer.provide(failingTransactions(failures)))))

        const warnings = logs.filter((entry) => entry.level === "Warn")
        assert.strictEqual(kept.seq, 3)
        assert.strictEqual(lost, 2)
        assert.deepStrictEqual(replayed, [kept])
        assert.strictEqual(warnings.length, 1)
        assert.deepInclude(warnings[0]?.annotations, { from: 1, to: 2, count: 2 })
      }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer, logged]), withMetrics)
    }
  )

  it.effect("should record a gap left at close", () =>
    Effect.gen(function* () {
      const failures = yield* Ref.make(0)

      yield* lostToAFailedWrite(failures).pipe(
        Effect.provide(FeedLog.layer.pipe(Layer.provide(failingTransactions(failures))))
      )

      const rows = yield* rowCount()
      assert.strictEqual(rows, 1)
    }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer]), withMetrics)
  )

  it.effect("should warn of a gap left at close on replay, replaying none of its frames", () => {
    const { logs, layer: logged } = recordingLogs()
    return Effect.gen(function* () {
      const failures = yield* Ref.make(0)
      yield* lostToAFailedWrite(failures).pipe(
        Effect.provide(FeedLog.layer.pipe(Layer.provide(failingTransactions(failures))))
      )

      const replayed = yield* FeedLog.use((log) => Stream.runCollect(log.replay(at(0)))).pipe(
        Effect.provide(FeedLog.layer)
      )

      const warnings = logs.filter((entry) => entry.level === "Warn")
      assert.deepStrictEqual(replayed, [])
      assert.strictEqual(warnings.length, 1)
      assert.deepInclude(warnings[0]?.annotations, { from: 1, to: 2, count: 2 })
    }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer, logged]), withMetrics)
  })

  it.effect("should number on past a gap left at close when opened again", () =>
    Effect.gen(function* () {
      const failures = yield* Ref.make(0)
      yield* lostToAFailedWrite(failures).pipe(
        Effect.provide(FeedLog.layer.pipe(Layer.provide(failingTransactions(failures))))
      )

      const kept = yield* FeedLog.use((log) => log.append(message("socket", "kept", 200, 3))).pipe(
        Effect.provide(FeedLog.layer)
      )

      // The gap row holds the last lost seq, so reopening numbers on past every lost frame.
      assert.strictEqual(kept.seq, 3)
    }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer]), withMetrics)
  )

  it.effect(
    "should keep seqs contiguous when appends are interrupted",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const log = yield* FeedLog
        const emitted = yield* Ref.make<ReadonlyArray<number>>([])
        const frames = yield* log.subscribe
        const listening = yield* frames.pipe(
          Stream.runForEach((frame) => Ref.update(emitted, (seqs) => [...seqs, frame.seq])),
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.withLive(Effect.sleep("5 millis"))

        // Enough that some run before the interrupts below, once the forking fiber yields; with half as many, none do.
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
          Effect.andThen(TestClock.adjust("100 millis"), rowCount()),
          (rows) => rows >= published.length
        )
        const rows = yield* sql<{ seq: number }>`SELECT seq FROM feed_frame ORDER BY seq`
        const stored = rows.map((row) => row.seq)
        const contiguous = published.map((_, index) => index + 1)
        assert.isAbove(published.length, 0)
        assert.deepStrictEqual(published, contiguous)
        assert.deepStrictEqual(stored, contiguous)
      }).pipe(Effect.scoped, Effect.provide(feedLog)),
    // Some 1,500 frames are gzip'd and hashed on the thread pool in turn: 3.4 s on a loaded full suite, near the 5 s default.
    { timeout: 20_000 }
  )

  it.effect("should write the frames still waiting when it closes", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const log = yield* FeedLog
        yield* log.append(poll("nfl", "{}", 0))
        yield* log.append(message("socket", "B", 50, 1))
      }).pipe(Effect.provide(FeedLog.layer))

      const rows = yield* rowCount()
      assert.strictEqual(rows, 2)
    }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer]))
  )

  it.effect("should continue from the last logged frame when opened again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Effect.gen(function* () {
        const log = yield* FeedLog
        yield* log.append(poll("nfl", "slate", 0))
        yield* log.append(message("socket", "B", 50, 1))
      }).pipe(Effect.provide(FeedLog.layer))

      const reopened = yield* FeedLog.use((log) => log.append(poll("nfl", "slate", 100))).pipe(
        Effect.provide(FeedLog.layer)
      )

      const kinds = yield* sql<{ kind: string }>`SELECT kind FROM feed_frame ORDER BY seq`
      assert.strictEqual(reopened.seq, 3)
      assert.deepStrictEqual(
        kinds.map((row) => row.kind),
        ["whole", "change", "unchanged"]
      )
    }).pipe(Effect.provide([Database.layerMemory, NodeCrypto.layer]))
  )

  it.effect("should give no game days for an empty log", () =>
    Effect.gen(function* () {
      const log = yield* FeedLog

      const days = yield* log.days

      assert.deepStrictEqual(days, [])
    }).pipe(Effect.provide([feedLog, newYork]))
  )

  it.effect("should give the game days its frames were received on, 04:00 to 04:00 in the current zone", () =>
    Effect.gen(function* () {
      const log = yield* FeedLog
      yield* appendedAndWritten([
        poll("nfl", "late", inNewYork("2026-10-04T03:59:00")),
        poll("nfl", "start", inNewYork("2026-10-04T04:00:00")),
        message("socket", "evening", inNewYork("2026-10-04T23:00:00"), 1),
        message("socket", "after midnight", inNewYork("2026-10-05T02:00:00"), 2),
        poll("nfl", "later", inNewYork("2026-10-07T12:00:00"))
      ])

      const days = yield* log.days

      assert.deepStrictEqual(days, ["2026-10-03", "2026-10-04", "2026-10-07"])
    }).pipe(Effect.provide([feedLog, newYork]))
  )

  it.effect("should keep its own feed.sqlite in the Hub's data directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temp = yield* fs.makeTempDirectoryScoped()
      const dataDir = path.join(temp, "sportal")
      const inDataDir = FeedLog.layerInDataDir.pipe(
        Layer.provide(HubConfig.layerTest({ SPORTAL_DATA_DIR: dataDir }))
      )

      yield* FeedLog.use((log) => log.append(poll("nfl", "{}", 0))).pipe(Effect.provide(inDataDir))

      const files = yield* fs.readDirectory(dataDir)
      assert.deepStrictEqual(files, ["feed.sqlite"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

const feedLog = FeedLog.layer.pipe(Layer.provide(NodeCrypto.layer), Layer.provideMerge(Database.layerMemory))

/** The feed log over the database the test provides. */
const feedLogOnDatabase = FeedLog.layer.pipe(Layer.provide(NodeCrypto.layer))

const newYork = DateTime.layerCurrentZone(DateTime.zoneMakeNamedUnsafe("America/New_York"))

/** A poll, a message 500 ms in, and the same poll again, unchanged, at a second. */
const pollMessagePoll = [poll("nfl", "slate", 0), message("socket", "B", 500, 1), poll("nfl", "slate", 1_000)]

function at(millis: number) {
  return DateTime.makeUnsafe(millis)
}

function poll(league: string, body: string, receivedAt: number) {
  return { receivedAt: at(receivedAt), source: "poll", channel: league, kind: "whole", body } as const
}

function message(channel: string, body: string, receivedAt: number, mid: number) {
  return {
    receivedAt: at(receivedAt),
    sentAt: at(receivedAt - 1),
    number: mid,
    source: "push",
    channel,
    kind: "change",
    body
  } as const
}

function checkpoint(topic: string, body: string, receivedAt: number, mid: number) {
  return { ...message(topic, body, receivedAt, mid), kind: "whole" } as const
}

function rowCount() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM feed_frame`
    return row?.count ?? 0
  })
}

/** Waits, in real time, for the writer to have written `count` rows: it compresses on the event loop. */
function written(count: number) {
  return settled(rowCount(), (rows) => rows >= count)
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

/** Appends `frames` in order, then moves the clock past the writer's 100 ms and waits for every one to be written. */
function appendedAndWritten(frames: ReadonlyArray<Frame>) {
  return Effect.gen(function* () {
    const log = yield* FeedLog

    const appended = yield* Effect.forEach(frames, log.append)
    yield* TestClock.adjust("100 millis")
    yield* written(frames.length)

    return appended
  })
}

/** Epoch millis of `wallClock` in New York. */
function inNewYork(wallClock: string) {
  return DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(wallClock, { timeZone: "America/New_York", adjustForTimeZone: true })
  )
}

/**
 * Makes the next write fail, appends two frames, and waits for the write that loses them: frames 1 and 2 are lost,
 * a gap.
 */
function lostToAFailedWrite(failures: Ref.Ref<number>) {
  return Effect.gen(function* () {
    const log = yield* FeedLog

    yield* Ref.set(failures, 1)
    yield* log.append(message("socket", "lost", 0, 1))
    yield* log.append(message("socket", "lost too", 10, 2))
    yield* TestClock.adjust("100 millis")
    yield* settled(counted("sportal_feed_write_failures"), (failed) => failed === 1)
  })
}

/** A feed log at version 1, before snapshot frames: its table and indexes, holding a response, a gap, and a message. */
function populatedVersionOneLog() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* Database.migrate("feed", {
      "1_create_feed_frame": sql`
        CREATE TABLE feed_frame (
          seq INTEGER PRIMARY KEY,
          received_at INTEGER NOT NULL,
          sent_at INTEGER,
          source_id INTEGER,
          feed TEXT CHECK (feed IN ('poll', 'fastcast')),
          channel TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('response', 'message', 'checkpoint', 'unchanged', 'gap')),
          body BLOB,
          body_hash TEXT,
          CHECK ((kind = 'gap') = (feed IS NULL AND channel IS NULL))
        )
      `.pipe(
        Effect.andThen(sql`CREATE INDEX feed_frame_channel_seq ON feed_frame (channel, seq)`),
        Effect.andThen(sql`CREATE INDEX feed_frame_received_at ON feed_frame (received_at)`),
        Effect.asVoid
      )
    })

    yield* sql`
      INSERT INTO feed_frame (seq, received_at, sent_at, source_id, feed, channel, kind, body, body_hash) VALUES
        (1, 1000, NULL, NULL, 'poll', 'nfl', 'response', x'1f8b0800', 'abc'),
        (5, 2000, NULL, NULL, NULL, NULL, 'gap', x'05', NULL),
        (9, 3000, 2999, 41, 'fastcast', 'event-football-nfl', 'message', x'00ff', NULL)
    `
  })
}

/** Every row of the feed log as stored, with how its body is stored and its bytes. */
function storedRows() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<Record<string, unknown>>`
      SELECT seq, received_at, sent_at, number, source, channel, kind, typeof(body) AS stored, hex(body) AS bytes,
        body_hash
      FROM feed_frame ORDER BY seq
    `
  })
}
