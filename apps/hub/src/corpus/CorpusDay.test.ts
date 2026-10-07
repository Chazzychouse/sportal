import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId } from "@sportal/domain/Game"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Equal, FileSystem, Option, Path, Stream } from "effect"
import * as Gzip from "../Gzip.ts"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import { CorpusDay, CorpusDays } from "./CorpusDay.ts"
import { CorpusInput, CorpusLine } from "./CorpusInput.ts"
import { inCorpus } from "./TestCorpus.ts"

describe("CorpusDays", () => {
  it.effect("should read a written day back: its day and its frames merged by arrival, then seq", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        yield* writtenDay

        const read = yield* days.read(day.date)
        const frames = yield* Stream.runCollect(read.frames)

        assert.deepStrictEqual(read.day, day)
        assert.deepStrictEqual(
          frames.map(({ seq, at }) => [seq, at.epochMilliseconds]),
          [
            [1, instant(0).epochMilliseconds],
            [2, instant(1).epochMilliseconds],
            [3, instant(2).epochMilliseconds],
            [4, instant(2).epochMilliseconds],
            [5, instant(2).epochMilliseconds],
            [6, instant(5).epochMilliseconds]
          ]
        )
        const listing = Delivery.cases.Listing.make({ league: "fbs", games: [snapshot()] })
        assert.isTrue(
          Equal.equals(frames[3]?.deliveries, [listing]),
          "an unchanged listing reads as the last one"
        )
        assert.isTrue(
          Equal.equals(frames[2]?.deliveries, [Delivery.cases.Plays.make({ game, plays: [play()] })]),
          "a plays change reads as the whole list"
        )
      })
    )
  )

  it.effect("should list a written day's date", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        yield* writtenDay

        const dates = yield* days.dates

        assert.deepStrictEqual(dates, [day.date])
      })
    )
  )

  it.effect("should replace the day there with a day written again", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        yield* writtenDay

        yield* days.write(day, { poll: Stream.fromIterable(poll.slice(0, 1)), push: Stream.empty })

        const read = yield* days.read(day.date)
        const frames = yield* Stream.runCollect(read.frames)
        assert.deepStrictEqual(
          frames.map(({ seq }) => seq),
          [1]
        )
      })
    )
  )

  it.effect("should fail reading a day built to another format as CorpusDayUnreadable Format", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        yield* days.write(new CorpusDay({ ...day, format: 0 }), { poll: Stream.empty, push: Stream.empty })

        const error = yield* days.read(day.date).pipe(Effect.flip)

        assert.deepStrictEqual(
          [error._tag, error.date, error.reason],
          ["CorpusDayUnreadable", day.date, "Format"]
        )
      })
    )
  )

  it.effect("should fail reading a day without its day.json as CorpusDayUnreadable Missing", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays

        const error = yield* days.read(day.date).pipe(Effect.flip)

        assert.deepStrictEqual([error.date, error.reason], [day.date, "Missing"])
      })
    )
  )

  it.effect("should list no date for a day without its day.json, once reading it has failed", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        yield* days.read(day.date).pipe(Effect.flip)

        const dates = yield* days.dates

        assert.deepStrictEqual(dates, [])
      })
    )
  )
})

describe("CorpusDays#day", () => {
  it.effect("should give none for a day not built", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays

        const built = yield* days.day(day.date)

        assert.deepStrictEqual(built, Option.none())
      })
    )
  )

  it.effect("should give the day.json as built, whatever its format", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        const stale = new CorpusDay({ ...day, format: 0 })
        yield* days.write(stale, { poll: Stream.empty, push: Stream.empty })

        const built = yield* days.day(day.date)

        assert.deepStrictEqual(built, Option.some(stale))
      })
    )
  )

  it.effect("should give none for a day.json that does not decode, so a build replaces it", () =>
    inCorpus(TestSnapshotFeed.decoder, (dir) =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        const fs = yield* FileSystem.FileSystem
        const { join } = yield* Path.Path
        yield* days.write(day, { poll: Stream.empty, push: Stream.empty })
        yield* fs.writeFileString(join(dir, "days", day.date, "day.json"), "{")

        const built = yield* days.day(day.date)

        assert.deepStrictEqual(built, Option.none())
      })
    )
  )

  it.effect("should fail for a day.json that cannot be read, rather than giving none", () =>
    inCorpus(TestSnapshotFeed.decoder, (dir) =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        const fs = yield* FileSystem.FileSystem
        const { join } = yield* Path.Path
        // A directory where day.json should be: it exists, and reading it fails as the machine's fault.
        yield* fs.makeDirectory(join(dir, "days", day.date, "day.json"), { recursive: true })

        const error = yield* days.day(day.date).pipe(Effect.flip)

        assert.strictEqual(error._tag, "PlatformError")
      })
    )
  )
})

describe("CorpusDays#read", () => {
  it.effect("should fail the frames as CorpusDayUnreadable Invalid at a line that does not decode", () =>
    inCorpus(TestSnapshotFeed.decoder, (dir) =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        const fs = yield* FileSystem.FileSystem
        const { join } = yield* Path.Path
        yield* days.write(day, { poll: Stream.fromIterable(poll), push: Stream.empty })
        const nonsense = yield* Gzip.compress('{"seq":2,"at":1,"input":{"_tag":"Nonsense"}}\n')
        yield* fs.writeFile(join(dir, "days", day.date, "push.ndjson.gz"), nonsense)
        const read = yield* days.read(day.date)

        const error = yield* Stream.runCollect(read.frames).pipe(Effect.flip)

        assert.deepStrictEqual([error.date, error.reason], [day.date, "Invalid"])
      })
    )
  )
})

describe("CorpusDay.dates", () => {
  it("should list every day from one to another, both included, across a month's end", () => {
    const dates = CorpusDay.dates("2026-09-29", "2026-10-02")

    assert.deepStrictEqual(dates, ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"])
  })

  it("should list the one day when both are the same", () => {
    const dates = CorpusDay.dates("2026-10-04", "2026-10-04")

    assert.deepStrictEqual(dates, ["2026-10-04"])
  })

  it("should list none when the last is before the first", () => {
    const dates = CorpusDay.dates("2026-10-04", "2026-10-03")

    assert.deepStrictEqual(dates, [])
  })
})

const game = GameId.make("1")
const day = new CorpusDay({
  date: "2026-10-03",
  kind: "captured",
  format: CorpusLine.format,
  leagues: ["fbs"],
  games: 1,
  built: DateTime.makeUnsafe("2026-10-04T12:00:00Z")
})

const poll = [
  line(1, 0, CorpusInput.cases.ListingChanged.make({ league: "fbs", games: [snapshot()] })),
  line(4, 2, CorpusInput.cases.ListingUnchanged.make({ league: "fbs" })),
  line(6, 5, CorpusInput.cases.ListingUnchanged.make({ league: "fbs" }))
]
const push = [
  line(2, 1, CorpusInput.cases.Snapshot.make({ snapshot: liveSnapshot() })),
  line(3, 2, CorpusInput.cases.PlaysChanged.make({ game, upserts: [play()], removed: [] })),
  line(5, 2, CorpusInput.cases.Snapshot.make({ snapshot: liveSnapshot({ clock: "9:00" }) }))
]

/** `day` written with its poll and push lines. */
const writtenDay = CorpusDays.use((days) =>
  days.write(day, { poll: Stream.fromIterable(poll), push: Stream.fromIterable(push) })
)

function line(seq: number, seconds: number, input: CorpusInput): CorpusLine {
  return new CorpusLine({ seq, at: instant(seconds), input })
}

function instant(seconds: number): DateTime.Utc {
  return DateTime.makeUnsafe(Date.UTC(2026, 9, 3, 16, 0, seconds))
}
