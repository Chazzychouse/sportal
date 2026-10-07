import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { Slate } from "@sportal/domain/Slate"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import {
  Context,
  DateTime,
  Effect,
  Equal,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream
} from "effect"
import { FeedLog } from "../FeedLog.ts"
import { FeedFrame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"
import { Decoder } from "../provider/Decoder.ts"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import { recordedNeAtBuf, recordedPlays } from "../provider/espn/TestEspn.ts"
import { inArchive, site, stepped } from "../provider/espn/TestEspnArchive.ts"
import { logged } from "../TestFeedLog.ts"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import { framed } from "../TestSnapshotFeed.ts"
import * as CorpusBuild from "./CorpusBuild.ts"
import { CorpusDay, CorpusDays } from "./CorpusDay.ts"
import { CorpusLine } from "./CorpusInput.ts"
import { built, golden, inCorpus, local } from "./TestCorpus.ts"

describe.each([
  { name: "from 04:00 local", from: () => local("2026-10-04T04:00:00"), zone: () => undefined },
  // The recording's topic checkpoint is at 16:44:55Z and its first play patch at 17:02:42Z; 04:00 in a zone
  // 12:56:40 behind UTC falls between them, at 16:56:40Z.
  {
    name: "starting mid-patch, keeping the checkpoint from before the day's start",
    from: () => DateTime.makeUnsafe("2026-10-04T16:56:40Z"),
    zone: () => DateTime.zoneMakeOffset(-((12 * 60 + 56) * 60 + 40) * 1000)
  }
])("CorpusBuild.captured, the recorded NE at BUF day $name", ({ from, zone }) => {
  // The recorded day is logged, built, read back and replayed once for these tests: seconds alone, more under a full
  // suite's load.
  it.layer(recordedDayBuilt(from(), zone()), { timeout: "60 seconds" })("built", (it) => {
    it.effect("should build a captured NFL day", () =>
      Effect.gen(function* () {
        const { day } = yield* RecordedDayBuilt

        assert.deepStrictEqual(
          [day.date, day.kind, day.format, day.leagues],
          ["2026-10-04", "captured", CorpusLine.format, ["nfl"]]
        )
      })
    )

    it.effect("should write every play to its push file", () =>
      Effect.gen(function* () {
        const { playIds } = yield* RecordedDayBuilt

        assert.strictEqual(playIds.size, recordedPlays)
      })
    )

    it.effect("should read back to the slate the decode's replay from the day's start takes", () =>
      Effect.gen(function* () {
        const { fromCorpus, fromDecode } = yield* RecordedDayBuilt

        assert.isTrue(Equal.equals(fromCorpus.everyGame(), fromDecode.everyGame()), "the same games")
        assert.isTrue(
          Equal.equals(
            fromCorpus.recentPlays(fromCorpus.everyGame()),
            fromDecode.recentPlays(fromDecode.everyGame())
          ),
          "and the same recent plays"
        )
      })
    )
  })
})

describe("CorpusBuild.captured", () => {
  it.effect("should keep a frame before the next day's 04:00 local and leave out one at 05:00", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        yield* logged([
          framed(listing([snapshot()]), local("2026-10-04T10:00:00")),
          framed(pushedSnapshot, local("2026-10-05T03:00:00")),
          framed(pushedSnapshot, local("2026-10-05T05:00:00"))
        ])

        yield* built("2026-10-04")

        const frames = yield* readBack("2026-10-04")
        assert.deepStrictEqual(
          frames.map(({ seq }) => seq),
          [1, 2]
        )
      })
    )
  )

  it.effect(
    "should thread the day by arrival, then seq, so an unchanged listing reads back as the one before it in arrival",
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

          const frames = yield* readBack("2026-10-04")
          assert.deepStrictEqual(
            frames.map(({ seq }) => seq),
            [2, 1, 3]
          )
          assert.isTrue(Equal.equals(frames[2]?.deliveries, [b]), "seq 3 reads back as the listing it was")
        })
      )
  )

  it.effect("should fail Undecodable at a frame that does not decode, writing no day", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
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

        const dates = yield* days.dates
        assert.deepStrictEqual(
          [error._tag, error.date, error.reason],
          ["CorpusBuildFailed", "2026-10-04", "Undecodable"]
        )
        assert.deepStrictEqual(dates, [])
      })
    )
  )

  it.effect("should fail NoFrames for a day the feed log has only a checkpoint from before it of", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        const checkpoint = framed(pushedSnapshot, local("2026-10-04T03:00:00"))
        yield* logged([
          new FeedFrame({ ...checkpoint, kind: "checkpoint" }),
          framed(pushedSnapshot, local("2026-10-05T05:00:00"))
        ])

        const error = yield* built("2026-10-04").pipe(Effect.flip)

        const dates = yield* days.dates
        assert.deepStrictEqual([error.date, error.reason], ["2026-10-04", "NoFrames"])
        assert.deepStrictEqual(dates, [])
      })
    )
  )

  it.effect("should fail NoFrames for a day the feed log has nothing of", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays

        const error = yield* built("2026-10-04").pipe(Effect.flip)

        const dates = yield* days.dates
        assert.deepStrictEqual([error.date, error.reason], ["2026-10-04", "NoFrames"])
        assert.deepStrictEqual(dates, [])
      })
    )
  )
})

describe("CorpusBuild.backfilled", () => {
  it.effect("should fetch NE–BUF's day into the archive and build it as the backfilled golden", () =>
    inArchive({}, ({ dir }) =>
      Effect.gen(function* () {
        const days = yield* CorpusDays

        const day = yield* stepped(CorpusBuild.backfilled("2026-10-04", ["nfl"], "fetch"))

        const files = yield* dayFiles(dir, "2026-10-04")
        const written = yield* days.day("2026-10-04")
        assert.deepStrictEqual(
          [day.date, day.kind, day.format, day.leagues, day.games],
          ["2026-10-04", "backfilled", CorpusLine.format, ["nfl"], 1]
        )
        assert.deepStrictEqual(files, {
          poll: golden("poll"),
          push: golden("push")
        })
        assert.deepStrictEqual(
          Option.map(written, ({ kind }) => kind),
          Option.some("backfilled")
        )
      })
    )
  )

  it.effect("should build the same day again from the archive alone, requesting nothing", () =>
    inArchive({}, ({ dir, requests }) =>
      Effect.gen(function* () {
        const fetched = yield* stepped(CorpusBuild.backfilled("2026-10-04", ["nfl"], "fetch"))
        const before = yield* requests

        const rebuilt = yield* CorpusBuild.backfilled("2026-10-04", ["nfl"], "archived")

        const after = yield* requests
        const files = yield* dayFiles(dir, "2026-10-04")
        assert.deepStrictEqual(after, before)
        assert.deepStrictEqual(
          [rebuilt.kind, rebuilt.leagues, rebuilt.games],
          [fetched.kind, fetched.leagues, fetched.games]
        )
        assert.deepStrictEqual(files, {
          poll: golden("poll"),
          push: golden("push")
        })
      })
    )
  )

  it.effect("should never overwrite a captured day, keeping it and fetching nothing", () =>
    inArchive({}, ({ requests }) =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        const captured = new CorpusDay({
          date: "2026-10-04",
          kind: "captured",
          format: CorpusLine.format,
          leagues: ["nfl"],
          games: 14,
          built: local("2026-10-05T09:00:00")
        })
        yield* days.write(captured, { poll: Stream.empty, push: Stream.empty })

        const kept = yield* stepped(CorpusBuild.backfilled("2026-10-04", ["nfl"], "fetch"))

        const written = yield* days.day("2026-10-04")
        const fetched = yield* requests
        assert.deepStrictEqual(kept, captured)
        assert.deepStrictEqual(written, Option.some(captured))
        assert.deepStrictEqual(fetched, [])
      })
    )
  )

  it.effect(
    "should stop at a day.json that cannot be read, fetching nothing and building nothing over it",
    () =>
      inArchive({}, ({ dir, requests }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { join } = yield* Path.Path
          const file = join(dir, "days", "2026-10-04", "day.json")
          yield* fs.makeDirectory(file, { recursive: true })

          const exit = yield* stepped(CorpusBuild.backfilled("2026-10-04", ["nfl"], "fetch")).pipe(
            Effect.exit
          )

          const fetched = yield* requests
          const there = yield* fs.stat(file)
          assert.isTrue(Exit.hasDies(exit))
          assert.deepStrictEqual(fetched, [])
          assert.isTrue(there.type === "Directory")
        })
      )
  )

  it.effect("should fail NoGames for a date whose scoreboard has no final game, writing no day", () =>
    inArchive(
      {
        answer: (url) =>
          url === `${site}/scoreboard?dates=20261006` ? new Response(`{"events":[]}`) : undefined
      },
      () =>
        Effect.gen(function* () {
          const days = yield* CorpusDays

          const error = yield* stepped(CorpusBuild.backfilled("2026-10-06", ["nfl"], "fetch")).pipe(
            Effect.flip
          )

          const dates = yield* days.dates
          assert.deepStrictEqual(
            [error._tag, error.date, error._tag === "CorpusBuildFailed" ? error.reason : undefined],
            ["CorpusBuildFailed", "2026-10-06", "NoGames"]
          )
          assert.deepStrictEqual(dates, [])
        })
    )
  )

  it.effect("should backfill a league onto a backfilled day of the other, rebuilding the day for both", () =>
    inArchive(
      {
        answer: (url) =>
          url.includes("/college-football/scoreboard?") ? new Response(`{"events":[]}`) : undefined
      },
      ({ dir }) =>
        Effect.gen(function* () {
          yield* stepped(CorpusBuild.backfilled("2026-10-04", ["nfl"], "fetch"))

          const day = yield* stepped(CorpusBuild.backfilled("2026-10-04", ["fbs"], "fetch"))

          const files = yield* dayFiles(dir, "2026-10-04")
          assert.deepStrictEqual([day.kind, day.leagues, day.games], ["backfilled", ["fbs", "nfl"], 1])
          assert.deepStrictEqual(files, {
            poll: golden("poll"),
            push: golden("push")
          })
        })
    )
  )

  it.effect(
    "should leave out, from the archive alone, a league whose scoreboard of the date is not archived",
    () =>
      inArchive({}, () =>
        Effect.gen(function* () {
          yield* stepped(CorpusBuild.backfilled("2026-10-04", ["nfl"], "fetch"))

          const day = yield* CorpusBuild.backfilled("2026-10-04", ["fbs", "nfl"], "archived")

          assert.deepStrictEqual([day.leagues, day.games], [["nfl"], 1])
        })
      )
  )

  it.effect("should fail NotArchived, from the archive alone, for a date it has no scoreboard of", () =>
    inArchive({}, () =>
      Effect.gen(function* () {
        const error = yield* CorpusBuild.backfilled("2026-10-04", ["fbs", "nfl"], "archived").pipe(
          Effect.flip
        )

        assert.deepStrictEqual(
          [error._tag, error.reason, error.date],
          ["ArchiveFetchFailed", "NotArchived", "2026-10-04"]
        )
      })
    )
  )
})

// The lines of day `date`'s two files, as written.
function dayFiles(dir: string, date: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { join } = yield* Path.Path
    const lines = (file: "poll" | "push") =>
      fs.readFile(join(dir, "days", date, `${file}.ndjson.gz`)).pipe(
        Effect.flatMap((bytes) => Gzip.decompress(bytes, "gzip")),
        Effect.map((text) => text.split("\n").filter((line) => line.length > 0))
      )
    const poll = yield* lines("poll")
    const push = yield* lines("push")

    return { poll, push }
  })
}

const pushedSnapshot = Delivery.cases.Snapshot.make({ snapshot: liveSnapshot(), from: "push" })

function listing(games: ReadonlyArray<GameSnapshot>) {
  return Delivery.cases.Listing.make({ league: "fbs", games })
}

/**
 * The recorded NE at BUF day built: the day, every play id in its push file, and the slate it reads back to beside the
 * slate the decode's replay from the day's start takes.
 */
class RecordedDayBuilt extends Context.Service<
  RecordedDayBuilt,
  {
    readonly day: CorpusDay
    readonly playIds: ReadonlySet<string>
    readonly fromCorpus: Slate
    readonly fromDecode: Slate
  }
>()("test/RecordedDayBuilt") {}

/** Logs the recorded NE at BUF frames, builds 2026-10-04, which starts at `from` in `zone`, and reads it back. */
function recordedDayBuilt(from: DateTime.Utc, zone: DateTime.TimeZone | undefined) {
  return Layer.effect(
    RecordedDayBuilt,
    inCorpus(
      EspnDecode.layer,
      (dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { join } = yield* Path.Path
          const frames = yield* recordedNeAtBuf
          yield* logged(frames)

          const day = yield* built("2026-10-04")

          const bytes = yield* fs.readFile(join(dir, "days", day.date, "push.ndjson.gz"))
          const push = yield* Gzip.decompress(bytes, "gzip")
          const playIds = new Set(
            push
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => decodeLine(line))
              .flatMap(({ input }) =>
                input._tag === "PlaysChanged" ? input.upserts.map(({ id }) => id) : []
              )
          )
          const corpusFrames = yield* readBack(day.date)
          const fromCorpus = yield* takenAll(corpusFrames)
          const decoded = yield* replayedFrom(from)
          const fromDecode = yield* takenAll(decoded)

          return { day, playIds, fromCorpus, fromDecode }
        }),
      zone
    )
  )
}

/** What the provided decoder says of the feed log's frames from `from`, the log opened for the replay alone. */
function replayedFrom(from: DateTime.Utc) {
  return Effect.gen(function* () {
    const log = yield* FeedLog
    const decoder = yield* Decoder

    return yield* Stream.runCollect(decoder.decode(log.replay(from)))
  }).pipe(Effect.provide(FeedLog.layer), Effect.scoped)
}

/** Day `date`'s frames, as read back from the corpus. */
function readBack(date: string) {
  return Effect.gen(function* () {
    const days = yield* CorpusDays
    const read = yield* days.read(date)

    return yield* Stream.runCollect(read.frames)
  })
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
