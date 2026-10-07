import { LeagueId } from "@sportal/domain/League"
import { Slate } from "@sportal/domain/Slate"
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Schema,
  Stream
} from "effect"
import * as Gzip from "../Gzip.ts"
import { HubConfig } from "../HubConfig.ts"
import type { Decoded } from "../provider/Decoder.ts"
import { CorpusLine, Had } from "./CorpusInput.ts"

/** A day of the corpus: what kind it is and the inputs it holds, by arrival. */
export class CorpusDay extends Schema.Class<CorpusDay>("sportal/hub/CorpusDay")({
  /** The game day, YYYY-MM-DD. */
  date: Schema.String,
  kind: Schema.Literals(["captured", "backfilled"]),
  format: Schema.Int,
  leagues: Schema.Array(LeagueId),
  games: Schema.Int,
  built: Schema.DateTimeUtcFromString
}) {
  /** The game day `date` (YYYY-MM-DD) in the current zone: from 04:00 local on it until 04:00 the next day. */
  static bounds(
    date: string
  ): Effect.Effect<
    { readonly from: DateTime.Utc; readonly until: DateTime.Utc },
    never,
    DateTime.CurrentTimeZone
  > {
    return Effect.gen(function* () {
      const noon = yield* Option.match(
        DateTime.makeZoned(DateTime.makeUnsafe(`${date}T12:00:00Z`), {
          timeZone: yield* DateTime.CurrentTimeZone,
          adjustForTimeZone: true
        }),
        { onSome: Effect.succeed, onNone: () => Effect.die(new Error(`${date} is not a day in this zone`)) }
      )
      return { from: Slate.dayStart(noon), until: Slate.dayStart(DateTime.add(noon, { days: 1 })) }
    })
  }

  /** Every game day (YYYY-MM-DD) from `from` to `to`, both included; none when `to` is before `from`. */
  static dates(from: string, to: string): ReadonlyArray<string> {
    const last = DateTime.makeUnsafe(`${to}T00:00:00Z`)
    return Arr.unfold(DateTime.makeUnsafe(`${from}T00:00:00Z`), (day) =>
      DateTime.isGreaterThan(day, last)
        ? Option.none()
        : Option.some([DateTime.formatIsoDateUtc(day), DateTime.add(day, { days: 1 })] as const)
    )
  }
}

/**
 * The corpus's days, each in `days/<date>/` under `HubConfig.corpusDir`: its `day.json`, and its poll and push lines as
 * gzip'd NDJSON. A day without its `day.json` is missing, so a write that stops part way leaves no day.
 */
export class CorpusDays extends Context.Service<
  CorpusDays,
  {
    /** Writes the day's two files, then `day.json`, replacing a day already there. */
    write(
      day: CorpusDay,
      lines: { readonly poll: Stream.Stream<CorpusLine>; readonly push: Stream.Stream<CorpusLine> }
    ): Effect.Effect<void, PlatformError.PlatformError>
    /** The day's frames' deliveries in arrival order (`at`, then `seq`), one `Decoded`-shaped step per frame. */
    read(date: string): Effect.Effect<
      {
        readonly day: CorpusDay
        readonly frames: Stream.Stream<Pick<Decoded, "seq" | "at" | "deliveries">, CorpusDayUnreadable>
      },
      CorpusDayUnreadable
    >
    /**
     * Day `date`'s `day.json`, whatever format it was built to; none when the day has not been built, or its `day.json`
     * does not decode, so a build replaces it. A file that cannot be read fails, so nothing replaces it unseen.
     */
    day(date: string): Effect.Effect<Option.Option<CorpusDay>, PlatformError.PlatformError>
    /** The dates of the days there are, sorted; none when the corpus has no days yet. */
    readonly dates: Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError>
  }
>()("sportal/hub/CorpusDays") {
  static readonly layer: Layer.Layer<CorpusDays, never, HubConfig | FileSystem.FileSystem | Path.Path> =
    Layer.effect(
      CorpusDays,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { join } = yield* Path.Path
        const days = join((yield* HubConfig).corpusDir, "days")
        const files = (date: string) => ({
          day: join(days, date, "day.json"),
          poll: join(days, date, "poll.ndjson.gz"),
          push: join(days, date, "push.ndjson.gz")
        })
        const writeLines = (file: string, lines: Stream.Stream<CorpusLine>) =>
          lines.pipe(
            Stream.mapEffect((line) => encodeLine(line)),
            Stream.map((line) => `${line}\n`),
            Stream.mkString,
            Effect.flatMap(Gzip.compress),
            // Encoding a line built from its own schema, and compressing text in memory, cannot fail.
            Effect.orDie,
            Effect.flatMap((bytes) => fs.writeFile(file, bytes))
          )
        const readLines = (date: string, file: string) =>
          fs.readFile(file).pipe(
            Effect.flatMap((bytes) => Gzip.decompress(bytes, "gzip")),
            Effect.flatMap((text) =>
              Stream.make(text).pipe(
                Stream.splitLines,
                Stream.filter((line) => line.length > 0),
                Stream.mapEffect((line) => decodeLine(line)),
                Stream.runCollect
              )
            ),
            Effect.mapError(unreadable(date, "Invalid"))
          )
        // The day's `day.json`, or none when it has none; Invalid when it does not decode.
        const dayOf = (date: string) =>
          Effect.gen(function* () {
            const file = files(date).day
            if (!(yield* fs.exists(file))) return Option.none()
            return Option.some(
              yield* decodeDay(yield* fs.readFileString(file)).pipe(
                Effect.mapError(unreadable(date, "Invalid"))
              )
            )
          })
        return CorpusDays.of({
          write: (day, lines) =>
            Effect.gen(function* () {
              const at = files(day.date)
              yield* fs.makeDirectory(join(days, day.date), { recursive: true })
              yield* fs.remove(at.day, { force: true })
              yield* Effect.all([writeLines(at.poll, lines.poll), writeLines(at.push, lines.push)], {
                concurrency: 2
              })
              const written = `${at.day}.tmp`
              yield* fs.writeFileString(written, yield* encodeDay(day).pipe(Effect.orDie))
              yield* fs.rename(written, at.day)
            }),
          read: (date) =>
            Effect.gen(function* () {
              const at = files(date)
              const built = yield* dayOf(date).pipe(
                Effect.catchTag("PlatformError", (cause) => Effect.fail(unreadable(date, "Invalid")(cause)))
              )
              if (Option.isNone(built)) {
                return yield* new CorpusDayUnreadable({ date, reason: "Missing", cause: at.day })
              }
              const day = built.value
              if (day.format !== CorpusLine.format) {
                return yield* new CorpusDayUnreadable({
                  date,
                  reason: "Format",
                  cause: `format ${day.format}; this corpus reads ${CorpusLine.format}`
                })
              }
              const frames = Stream.unwrap(
                Effect.all([readLines(date, at.poll), readLines(date, at.push)], { concurrency: 2 }).pipe(
                  Effect.map(([poll, push]) =>
                    Stream.fromIterable([...poll, ...push].toSorted(CorpusLine.byArrival)).pipe(
                      Stream.groupAdjacentBy((line) => line.seq),
                      Stream.mapAccum(
                        () => Had.empty,
                        (
                          had,
                          [seq, lines]
                        ): readonly [Had, ReadonlyArray<Pick<Decoded, "seq" | "at" | "deliveries">>] => {
                          const read = CorpusLine.deliveries(lines, had)
                          return [
                            read.had,
                            [{ seq, at: Arr.headNonEmpty(lines).at, deliveries: read.deliveries }]
                          ]
                        }
                      )
                    )
                  )
                )
              )
              return { day, frames }
            }),
          day: (date) => dayOf(date).pipe(Effect.catchTag("CorpusDayUnreadable", () => Effect.succeedNone)),
          dates: Effect.gen(function* () {
            if (!(yield* fs.exists(days))) return []
            const dates = yield* Effect.filter(yield* fs.readDirectory(days), (date) =>
              fs.exists(files(date).day)
            )
            return dates.toSorted()
          })
        })
      })
    )
}

/**
 * Corpus day `date` cannot be read: it has no `day.json`, a file of it does not decode, or it was built to another
 * format than this corpus reads, and must be built again.
 */
export class CorpusDayUnreadable extends Schema.TaggedError<CorpusDayUnreadable>()("CorpusDayUnreadable", {
  date: Schema.String,
  reason: Schema.Literals(["Missing", "Invalid", "Format"]),
  cause: Schema.Defect()
}) {
  override get message() {
    return {
      Missing: `Corpus day ${this.date} has not been built`,
      Invalid: `Corpus day ${this.date} does not read; build it again`,
      Format: `Corpus day ${this.date} was built to another format; build it again`
    }[this.reason]
  }
}

/** Of the `days` a corpus command built or ran, `failed` did not succeed; each was logged as it failed. */
export class DaysFailed extends Schema.TaggedError<DaysFailed>()("DaysFailed", {
  failed: Schema.Int,
  days: Schema.Int
}) {
  override get message() {
    return `${this.failed} of ${this.days} days failed`
  }
}

const encodeLine = Schema.encodeEffect(Schema.fromJsonString(CorpusLine))

const decodeLine = Schema.decodeEffect(Schema.fromJsonString(CorpusLine))

const encodeDay = Schema.encodeEffect(Schema.fromJsonString(CorpusDay))

const decodeDay = Schema.decodeEffect(Schema.fromJsonString(CorpusDay))

function unreadable(date: string, reason: CorpusDayUnreadable["reason"]) {
  return (cause: unknown) => new CorpusDayUnreadable({ date, reason, cause })
}
