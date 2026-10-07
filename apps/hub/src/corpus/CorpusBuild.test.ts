import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { Slate } from "@sportal/domain/Slate"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { type Crypto, DateTime, Effect, Equal, FileSystem, Layer, Path, Schema, Stream } from "effect"
import type { SqlClient } from "effect/sql"
import * as Database from "../Database.ts"
import { FeedLog } from "../FeedLog.ts"
import { FeedFrame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"
import { Decoder } from "../provider/Decoder.ts"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import { fixtures, neAtBufFrames } from "../provider/espn/TestEspn.ts"
import { Scenarios } from "../scenario/Scenarios.ts"
import { framed } from "../TestFeed.ts"
import { withEnv } from "../TestHubConfig.ts"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import * as CorpusBuild from "./CorpusBuild.ts"
import { CorpusDays } from "./CorpusDay.ts"
import { CorpusLine } from "./CorpusInput.ts"

// As Slate.replay.test.ts measured it: every play id the recording's patches add.
const recordedPlays = 182

const zone = "America/New_York"

describe("CorpusBuild.captured", () => {
  it.effect(
    "builds the recorded NE at BUF day: every play in its push file, and read back it takes to the slate the decode does",
    () => inCorpus(EspnDecode.layer, (dir) => recordedDayChecked(dir, local("2026-10-04T04:00:00"))),
    { timeout: 60_000 }
  )

  it.effect(
    "keeps the checkpoint from before the day's start, so a day that starts mid-patch still reads back whole",
    () => {
      // The recording's topic checkpoint is at 16:44:55Z and its first play patch at 17:02:42Z; 04:00 in a zone
      // 12:56:40 behind UTC falls between them, at 16:56:40Z.
      const behind = DateTime.zoneMakeOffset(-((12 * 60 + 56) * 60 + 40) * 1000)
      return inCorpus(
        EspnDecode.layer,
        (dir) => recordedDayChecked(dir, DateTime.makeUnsafe("2026-10-04T16:56:40Z")),
        behind
      )
    },
    { timeout: 60_000 }
  )

  it.effect("keeps a frame before the next day's 04:00 local and leaves out one at 05:00", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        yield* logged([
          framed(listing([snapshot()]), local("2026-10-04T10:00:00")),
          framed(pushedSnapshot, local("2026-10-05T03:00:00")),
          framed(pushedSnapshot, local("2026-10-05T05:00:00"))
        ])
        yield* built("2026-10-04")
        const frames = yield* Stream.runCollect((yield* (yield* CorpusDays).read("2026-10-04")).frames)
        assert.deepStrictEqual(
          frames.map(({ seq }) => seq),
          [1, 2]
        )
      })
    )
  )

  it.effect(
    "threads the day by arrival, then seq, so an unchanged listing reads back as the one before it in arrival",
    () =>
      inCorpus(TestSnapshotFeed.decoder, () =>
        Effect.gen(function* () {
          const a = listing([snapshot()])
          const b = listing([snapshot({ id: GameId.make("2") })])
          // Logged in seq order 1, 2, 3, but received 2, 1, 3: seq 3 repeats seq 2's listing, not seq 1's.
          yield* logged([
            framed(a, local("2026-10-04T10:00:02")),
            framed(b, local("2026-10-04T10:00:01")),
            framed(b, local("2026-10-04T10:00:03"))
          ])
          yield* built("2026-10-04")
          const frames = yield* Stream.runCollect((yield* (yield* CorpusDays).read("2026-10-04")).frames)
          assert.deepStrictEqual(
            frames.map(({ seq }) => seq),
            [2, 1, 3]
          )
          assert.isTrue(Equal.equals(frames[2]?.deliveries, [b]), "seq 3 reads back as the listing it was")
        })
      )
  )

  it.effect("fails Undecodable at a frame that does not decode, and writes no day", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        yield* logged([
          framed(listing([snapshot()]), local("2026-10-04T10:00:00")),
          new FeedFrame({
            receivedAt: local("2026-10-04T10:00:10"),
            feed: "snapshot",
            channel: "snapshot",
            kind: "message",
            body: "nonsense"
          })
        ])
        const error = yield* built("2026-10-04").pipe(Effect.flip)
        assert.deepStrictEqual(
          [error._tag, error.date, error.reason],
          ["CorpusBuildFailed", "2026-10-04", "Undecodable"]
        )
        assert.deepStrictEqual(yield* (yield* CorpusDays).dates, [])
      })
    )
  )

  it.effect("fails NoFrames for a day the feed log has only a checkpoint from before it of", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const checkpoint = framed(pushedSnapshot, local("2026-10-04T03:00:00"))
        yield* logged([
          new FeedFrame({ ...checkpoint, kind: "checkpoint" }),
          framed(pushedSnapshot, local("2026-10-05T05:00:00"))
        ])
        const error = yield* built("2026-10-04").pipe(Effect.flip)
        assert.deepStrictEqual([error.date, error.reason], ["2026-10-04", "NoFrames"])
        assert.deepStrictEqual(yield* (yield* CorpusDays).dates, [])
      })
    )
  )

  it.effect("fails NoFrames for a day the feed log has nothing of", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const error = yield* built("2026-10-04").pipe(Effect.flip)
        assert.deepStrictEqual([error.date, error.reason], ["2026-10-04", "NoFrames"])
        assert.deepStrictEqual(yield* (yield* CorpusDays).dates, [])
      })
    )
  )
})

const pushedSnapshot = Delivery.cases.Snapshot.make({ snapshot: liveSnapshot(), from: "push" })

function listing(games: ReadonlyArray<GameSnapshot>) {
  return Delivery.cases.Listing.make({ league: "fbs", games })
}

/** A wall-clock instant in the test's zone. */
function local(wallClock: string): DateTime.Utc {
  return DateTime.toUtc(DateTime.makeZonedUnsafe(wallClock, { timeZone: zone, adjustForTimeZone: true }))
}

/**
 * `test` over an in-memory feed log, `decoder`, and corpus days in a temporary directory it is given, in `timeZone`,
 * the test's `zone` unless given.
 */
function inCorpus<A, E>(
  decoder: Layer.Layer<Decoder>,
  test: (
    dir: string
  ) => Effect.Effect<
    A,
    E,
    | CorpusDays
    | Decoder
    | DateTime.CurrentTimeZone
    | FileSystem.FileSystem
    | Path.Path
    | SqlClient.SqlClient
    | Crypto.Crypto
  >,
  timeZone: DateTime.TimeZone = DateTime.zoneMakeNamedUnsafe(zone)
) {
  return Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    return yield* test(dir).pipe(
      Effect.provide(
        Layer.mergeAll(
          CorpusDays.layer.pipe(Layer.provide(withEnv({ SPORTAL_CORPUS_DIR: dir }))),
          decoder,
          DateTime.layerCurrentZone(timeZone),
          Database.at(":memory:"),
          NodeCrypto.layer
        )
      )
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
}

/**
 * Logs the recorded NE at BUF frames, builds 2026-10-04, which starts at `from`, and checks it: a captured NFL day
 * whose push file has every play, read back to the same slate as the replay from `from` decoded.
 */
function recordedDayChecked(dir: string, from: DateTime.Utc) {
  return Effect.gen(function* () {
    yield* logged(yield* recorded)
    const day = yield* built("2026-10-04")
    assert.deepStrictEqual(
      [day.date, day.kind, day.format, day.leagues],
      ["2026-10-04", "captured", CorpusLine.format, ["nfl"]]
    )

    const { join } = yield* Path.Path
    const push = yield* (yield* FileSystem.FileSystem)
      .readFile(join(dir, "days", day.date, "push.ndjson.gz"))
      .pipe(Effect.flatMap((bytes) => Gzip.decompress(bytes, "gzip")))
    const playIds = new Set(
      push
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => decodeLine(line))
        .flatMap(({ input }) => (input._tag === "PlaysChanged" ? input.upserts.map(({ id }) => id) : []))
    )
    assert.strictEqual(playIds.size, recordedPlays)

    const read = yield* (yield* CorpusDays).read(day.date)
    const fromCorpus = yield* takenAll(yield* Stream.runCollect(read.frames))
    const decoded = yield* Effect.gen(function* () {
      const log = yield* FeedLog
      const decoder = yield* Decoder
      return yield* Stream.runCollect(decoder.decode(log.replay(from)))
    }).pipe(Effect.provide(FeedLog.layer), Effect.scoped)
    const fromDecode = yield* takenAll(decoded)
    assert.isTrue(Equal.equals(fromCorpus.everyGame(), fromDecode.everyGame()), "the same games")
    assert.isTrue(
      Equal.equals(
        fromCorpus.recentPlays(fromCorpus.everyGame()),
        fromDecode.recentPlays(fromDecode.everyGame())
      ),
      "and the same recent plays"
    )
  })
}

/** Day `date` built from the feed log, opened for the build alone. */
function built(date: string) {
  return CorpusBuild.captured(date).pipe(Effect.provide(FeedLog.layer), Effect.scoped)
}

/** `frames` appended through a feed log of their own, closed before the test goes on, so every one is written. */
function logged(frames: ReadonlyArray<FeedFrame>) {
  return FeedLog.use((log) => Effect.forEach(frames, log.append, { discard: true })).pipe(
    Effect.provide(FeedLog.layer),
    Effect.scoped
  )
}

/** The domain slate once it has taken every one of `frames`, in order. */
function takenAll(frames: ReadonlyArray<Parameters<Slate["take"]>[0]>) {
  return Effect.reduce(
    frames,
    () => Slate.empty,
    (slate, frame) => Effect.map(slate.take(frame), ({ next }) => next)
  )
}

const decodeLine = Schema.decodeSync(Schema.fromJsonString(CorpusLine))

/** The recorded NE at BUF day's frames. */
const recorded = Scenarios.use((scenarios) => scenarios.load(neAtBufFrames)).pipe(
  Effect.map(({ frames }) => frames),
  Effect.provide(Scenarios.in(fixtures, []).pipe(Layer.provideMerge(NodeServices.layer)))
)
