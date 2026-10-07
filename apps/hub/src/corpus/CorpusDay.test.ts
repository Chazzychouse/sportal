import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId } from "@sportal/domain/Game"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Equal, FileSystem, Layer, Option, Path, Stream } from "effect"
import * as Gzip from "../Gzip.ts"
import { withEnv } from "../TestHubConfig.ts"
import { CorpusDay, CorpusDays } from "./CorpusDay.ts"
import { CorpusInput, CorpusLine } from "./CorpusInput.ts"

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

describe("CorpusDays", () => {
  it.effect("reads a written day back: its day and its frames merged by arrival, then seq", () =>
    inCorpus(() =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        yield* days.write(day, { poll: Stream.fromIterable(poll), push: Stream.fromIterable(push) })
        const read = yield* days.read(day.date)
        const frames = yield* Stream.runCollect(read.frames)

        assert.deepStrictEqual(read.day, day)
        assert.deepStrictEqual(yield* days.dates, [day.date])
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

  it.effect("a day written again replaces the one there", () =>
    inCorpus(() =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        yield* days.write(day, { poll: Stream.fromIterable(poll), push: Stream.fromIterable(push) })
        yield* days.write(day, { poll: Stream.fromIterable(poll.slice(0, 1)), push: Stream.empty })
        const frames = yield* Stream.runCollect((yield* days.read(day.date)).frames)
        assert.deepStrictEqual(
          frames.map(({ seq }) => seq),
          [1]
        )
      })
    )
  )

  it.effect("a day built to another format is CorpusDayUnreadable Format", () =>
    inCorpus(() =>
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

  it.effect("a day without its day.json is CorpusDayUnreadable Missing", () =>
    inCorpus(() =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        const error = yield* days.read(day.date).pipe(Effect.flip)
        assert.deepStrictEqual([error.date, error.reason], [day.date, "Missing"])
        assert.deepStrictEqual(yield* days.dates, [])
      })
    )
  )

  it.effect("day: the day.json as built, whatever its format; none for a day not built", () =>
    inCorpus(() =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        assert.deepStrictEqual(yield* days.day(day.date), Option.none())
        const stale = new CorpusDay({ ...day, format: 0 })
        yield* days.write(stale, { poll: Stream.empty, push: Stream.empty })
        assert.deepStrictEqual(yield* days.day(day.date), Option.some(stale))
      })
    )
  )

  it.effect("day: none for a day.json that does not decode, so a build replaces it", () =>
    inCorpus((dir) =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        yield* days.write(day, { poll: Stream.empty, push: Stream.empty })
        const { join } = yield* Path.Path
        yield* (yield* FileSystem.FileSystem).writeFileString(join(dir, "days", day.date, "day.json"), "{")
        assert.deepStrictEqual(yield* days.day(day.date), Option.none())
      })
    )
  )

  it.effect("day: a day.json that cannot be read fails, rather than reading as none", () =>
    inCorpus((dir) =>
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

  it.effect("a line that does not decode fails the frames as CorpusDayUnreadable Invalid", () =>
    inCorpus((dir) =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        yield* days.write(day, { poll: Stream.fromIterable(poll), push: Stream.empty })
        const fs = yield* FileSystem.FileSystem
        const { join } = yield* Path.Path
        yield* fs.writeFile(
          join(dir, "days", day.date, "push.ndjson.gz"),
          yield* Gzip.compress('{"seq":2,"at":1,"input":{"_tag":"Nonsense"}}\n')
        )
        const read = yield* days.read(day.date)
        const error = yield* Stream.runCollect(read.frames).pipe(Effect.flip)
        assert.deepStrictEqual([error.date, error.reason], [day.date, "Invalid"])
      })
    )
  )
})

describe("CorpusDay.dates", () => {
  it("lists every day from one to another, both included, across a month's end", () => {
    assert.deepStrictEqual(CorpusDay.dates("2026-09-29", "2026-10-02"), [
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02"
    ])
  })

  it("is the one day when both are the same, and none when the last is before the first", () => {
    assert.deepStrictEqual(CorpusDay.dates("2026-10-04", "2026-10-04"), ["2026-10-04"])
    assert.deepStrictEqual(CorpusDay.dates("2026-10-04", "2026-10-03"), [])
  })
})

/** `test` with corpus days in a temporary corpus directory, which it is given. */
function inCorpus<A, E>(
  test: (dir: string) => Effect.Effect<A, E, CorpusDays | FileSystem.FileSystem | Path.Path>
) {
  return Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    return yield* test(dir).pipe(
      Effect.provide(CorpusDays.layer.pipe(Layer.provide(withEnv({ SPORTAL_CORPUS_DIR: dir }))))
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
}

function line(seq: number, seconds: number, input: CorpusInput): CorpusLine {
  return new CorpusLine({ seq, at: instant(seconds), input })
}

function instant(seconds: number): DateTime.Utc {
  return DateTime.makeUnsafe(Date.UTC(2026, 9, 3, 16, 0, seconds))
}
