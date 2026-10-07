import { GameDay } from "@sportal/domain/GameDay"
import { LeagueId } from "@sportal/domain/League"
import { Context, Effect, FileSystem, Layer, Option, Path, type PlatformError, Schema, Stream } from "effect"
import * as Gzip from "../Gzip.ts"
import { HubConfig } from "../HubConfig.ts"
import type { Decoded } from "../provider/Decoder.ts"
import { CorpusLine } from "./CorpusLine.ts"

/** A day of the corpus: what kind it is and the inputs it holds, by arrival. */
export class CorpusDay extends Schema.Class<CorpusDay>("sportal/hub/CorpusDay")({
  date: GameDay,
  kind: Schema.Literals(["captured", "backfilled"]),
  format: Schema.Int,
  leagues: Schema.Array(LeagueId),
  games: Schema.Int,
  built: Schema.DateTimeUtcFromString
}) {}

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
    read(date: GameDay): Effect.Effect<
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
    day(date: GameDay): Effect.Effect<Option.Option<CorpusDay>, PlatformError.PlatformError>
    /** The dates of the days there are, sorted; none when the corpus has no days yet. */
    readonly dates: Effect.Effect<ReadonlyArray<GameDay>, PlatformError.PlatformError>
  }
>()("sportal/hub/corpus/CorpusDays") {
  static readonly layer: Layer.Layer<CorpusDays, never, HubConfig | FileSystem.FileSystem | Path.Path> =
    Layer.effect(
      CorpusDays,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { join } = yield* Path.Path
        const config = yield* HubConfig
        const days = join(config.corpusDir, "days")
        const files = (date: GameDay) => ({
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
        const readLines = (date: GameDay, file: string) =>
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
        const dayOf = Effect.fnUntraced(function* (date: GameDay) {
          const file = files(date).day
          const exists = yield* fs.exists(file)
          if (!exists) return Option.none()
          const json = yield* fs.readFileString(file)
          const day = yield* decodeDay(json).pipe(Effect.mapError(unreadable(date, "Invalid")))
          return Option.some(day)
        })

        const write = Effect.fn("CorpusDays.write")(function* (
          day: CorpusDay,
          lines: { readonly poll: Stream.Stream<CorpusLine>; readonly push: Stream.Stream<CorpusLine> }
        ) {
          const at = files(day.date)
          yield* fs.makeDirectory(join(days, day.date), { recursive: true })
          yield* fs.remove(at.day, { force: true })
          yield* Effect.all([writeLines(at.poll, lines.poll), writeLines(at.push, lines.push)], {
            concurrency: 2
          })

          const written = `${at.day}.tmp`
          const json = yield* encodeDay(day).pipe(Effect.orDie)
          yield* fs.writeFileString(written, json)
          yield* fs.rename(written, at.day)
        })

        const read = Effect.fn("CorpusDays.read")(function* (date: GameDay) {
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
              Effect.map(([poll, push]) => CorpusLine.decodedOf([...poll, ...push]))
            )
          )
          return { day, frames }
        })

        const dates = Effect.gen(function* () {
          const exists = yield* fs.exists(days)
          if (!exists) return []
          const entries = yield* fs.readDirectory(days)
          const built = yield* Effect.filter(entries.filter(Schema.is(GameDay)), (date) =>
            fs.exists(files(date).day)
          )
          return built.toSorted()
        })

        return CorpusDays.of({
          write,
          read,
          day: (date) => dayOf(date).pipe(Effect.catchTag("CorpusDayUnreadable", () => Effect.succeedNone)),
          dates
        })
      })
    )
}

/**
 * Corpus day `date` cannot be read: it has no `day.json`, a file of it does not decode, or it was built to another
 * format than this corpus reads, and must be built again.
 */
export class CorpusDayUnreadable extends Schema.TaggedError<CorpusDayUnreadable>()("CorpusDayUnreadable", {
  date: GameDay,
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

const encodeLine = Schema.encodeEffect(Schema.fromJsonString(CorpusLine))

const decodeLine = Schema.decodeEffect(Schema.fromJsonString(CorpusLine))

const encodeDay = Schema.encodeEffect(Schema.fromJsonString(CorpusDay))

const decodeDay = Schema.decodeEffect(Schema.fromJsonString(CorpusDay))

function unreadable(date: GameDay, reason: CorpusDayUnreadable["reason"]) {
  return (cause: unknown) => new CorpusDayUnreadable({ date, reason, cause })
}
