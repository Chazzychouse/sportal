import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { Slate } from "@sportal/domain/Slate"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Equal, Exit, FileSystem, Option, Path, Schema, Stream } from "effect"
import { FeedLog } from "../FeedLog.ts"
import { FeedFrame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"
import { Decoder } from "../provider/Decoder.ts"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import { framed } from "../TestFeed.ts"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import * as CorpusBuild from "./CorpusBuild.ts"
import { CorpusDay, CorpusDays } from "./CorpusDay.ts"
import { CorpusLine } from "./CorpusInput.ts"
import { built, inArchive, inCorpus, local, logged, recorded, site, stepped } from "./TestCorpus.ts"

// As Slate.replay.test.ts measured it: every play id the recording's patches add.
const recordedPlays = 182

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

describe("CorpusBuild.backfilled", () => {
  it.effect("fetches NE–BUF's day into the archive and builds it as the backfilled golden", () =>
    inArchive({}, ({ dir }) =>
      Effect.gen(function* () {
        const day = yield* stepped(CorpusBuild.backfilled("2026-10-04", ["nfl"], "fetch"))

        assert.deepStrictEqual(
          [day.date, day.kind, day.format, day.leagues, day.games],
          ["2026-10-04", "backfilled", CorpusLine.format, ["nfl"], 1]
        )
        assert.deepStrictEqual(yield* dayFiles(dir, "2026-10-04"), {
          poll: golden("poll"),
          push: golden("push")
        })
        assert.deepStrictEqual(
          Option.map(yield* (yield* CorpusDays).day("2026-10-04"), ({ kind }) => kind),
          Option.some("backfilled")
        )
      })
    )
  )

  it.effect("builds the same day again from the archive alone, requesting nothing", () =>
    inArchive({}, ({ dir, requests }) =>
      Effect.gen(function* () {
        const fetched = yield* stepped(CorpusBuild.backfilled("2026-10-04", ["nfl"], "fetch"))
        const before = yield* requests

        const rebuilt = yield* CorpusBuild.backfilled("2026-10-04", ["nfl"], "archived")

        assert.deepStrictEqual(yield* requests, before)
        assert.deepStrictEqual(
          [rebuilt.kind, rebuilt.leagues, rebuilt.games],
          [fetched.kind, fetched.leagues, fetched.games]
        )
        assert.deepStrictEqual(yield* dayFiles(dir, "2026-10-04"), {
          poll: golden("poll"),
          push: golden("push")
        })
      })
    )
  )

  it.effect("never overwrites a captured day: it is kept, and nothing is fetched", () =>
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

        assert.deepStrictEqual(kept, captured)
        assert.deepStrictEqual(yield* days.day("2026-10-04"), Option.some(captured))
        assert.deepStrictEqual(yield* requests, [])
      })
    )
  )

  it.effect("stops at a day.json that cannot be read, fetching nothing and building nothing over it", () =>
    inArchive({}, ({ dir, requests }) =>
      Effect.gen(function* () {
        const { join } = yield* Path.Path
        const file = join(dir, "days", "2026-10-04", "day.json")
        yield* (yield* FileSystem.FileSystem).makeDirectory(file, { recursive: true })

        const exit = yield* stepped(CorpusBuild.backfilled("2026-10-04", ["nfl"], "fetch")).pipe(Effect.exit)

        assert.isTrue(Exit.hasDies(exit))
        assert.deepStrictEqual(yield* requests, [])
        assert.isTrue((yield* (yield* FileSystem.FileSystem).stat(file)).type === "Directory")
      })
    )
  )

  it.effect("fails NoGames for a date whose scoreboard has no final game, and writes no day", () =>
    inArchive(
      {
        answer: (url) =>
          url === `${site}/scoreboard?dates=20261006` ? new Response(`{"events":[]}`) : undefined
      },
      () =>
        Effect.gen(function* () {
          const error = yield* stepped(CorpusBuild.backfilled("2026-10-06", ["nfl"], "fetch")).pipe(
            Effect.flip
          )

          assert.deepStrictEqual(
            [error._tag, error.date, error._tag === "CorpusBuildFailed" ? error.reason : undefined],
            ["CorpusBuildFailed", "2026-10-06", "NoGames"]
          )
          assert.deepStrictEqual(yield* (yield* CorpusDays).dates, [])
        })
    )
  )

  it.effect("backfills a league onto a backfilled day of the other: the day is rebuilt for both", () =>
    inArchive(
      {
        answer: (url) =>
          url.includes("/college-football/scoreboard?") ? new Response(`{"events":[]}`) : undefined
      },
      ({ dir }) =>
        Effect.gen(function* () {
          yield* stepped(CorpusBuild.backfilled("2026-10-04", ["nfl"], "fetch"))

          const day = yield* stepped(CorpusBuild.backfilled("2026-10-04", ["fbs"], "fetch"))

          assert.deepStrictEqual([day.kind, day.leagues, day.games], ["backfilled", ["fbs", "nfl"], 1])
          assert.deepStrictEqual(yield* dayFiles(dir, "2026-10-04"), {
            poll: golden("poll"),
            push: golden("push")
          })
        })
    )
  )

  it.effect("from the archive alone, leaves out a league whose scoreboard of the date is not archived", () =>
    inArchive({}, () =>
      Effect.gen(function* () {
        yield* stepped(CorpusBuild.backfilled("2026-10-04", ["nfl"], "fetch"))

        const day = yield* CorpusBuild.backfilled("2026-10-04", ["fbs", "nfl"], "archived")

        assert.deepStrictEqual([day.leagues, day.games], [["nfl"], 1])
      })
    )
  )

  it.effect("from the archive alone, fails NotArchived for a date it has no scoreboard of", () =>
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

// NE–BUF's backfilled day, as Synthesis.test.ts commits it.
function golden(file: "poll" | "push") {
  return readFileSync(new URL(`./fixtures/2026-10-04-ne-buf.${file}.ndjson`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
}

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
    return { poll: yield* lines("poll"), push: yield* lines("push") }
  })
}

const pushedSnapshot = Delivery.cases.Snapshot.make({ snapshot: liveSnapshot(), from: "push" })

function listing(games: ReadonlyArray<GameSnapshot>) {
  return Delivery.cases.Listing.make({ league: "fbs", games })
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

/** The domain slate once it has taken every one of `frames`, in order. */
function takenAll(frames: ReadonlyArray<Parameters<Slate["take"]>[0]>) {
  return Effect.reduce(
    frames,
    () => Slate.empty,
    (slate, frame) => Effect.map(slate.take(frame), ({ next }) => next)
  )
}

const decodeLine = Schema.decodeSync(Schema.fromJsonString(CorpusLine))
