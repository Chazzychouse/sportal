import type { LeagueId } from "@sportal/domain/League"
import { Array as Arr, DateTime, Effect, FileSystem, Option, Order, Path, Schema } from "effect"

/**
 * A recorded day's polls, as they were saved to disk: a folder per league (`…/college-football`, `…/nfl`)
 * holds that league's scoreboard polls, each gzip'd under the instant it was taken. Both dev tools read a day
 * through this. The polls come in order of that instant; a file not named for an instant is skipped.
 */
export function polls(
  dir: string
): Effect.Effect<
  ReadonlyArray<{ league: LeagueId; at: DateTime.Utc; path: string }>,
  RecordingUnreadable,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const league = yield* Option.match(leagueOf(dir), {
      onNone: () =>
        Effect.fail(new RecordingUnreadable({ reason: `${dir} is not a college-football or nfl recording` })),
      onSome: Effect.succeed
    })
    const { join } = yield* Path.Path
    const scoreboards = join(dir, "scoreboard")
    const files = yield* (yield* FileSystem.FileSystem)
      .readDirectory(scoreboards)
      .pipe(
        Effect.mapError(
          (cause) => new RecordingUnreadable({ reason: `${scoreboards} could not be read`, cause })
        )
      )
    return Arr.sort(
      files.flatMap((file) =>
        Option.toArray(Option.map(instantOf(file), (at) => ({ league, at, path: join(scoreboards, file) })))
      ),
      Order.mapInput(DateTime.Order, (poll: { at: DateTime.Utc }) => poll.at)
    )
  })
}

/** The league a recording's folder holds: `college-football` is `fbs`, `nfl` is `nfl`. */
function leagueOf(folder: string): Option.Option<LeagueId> {
  const name = folder.split(/[\\/]/).findLast((part) => part.length > 0)
  return Option.fromUndefinedOr(name === undefined ? undefined : leagues[name])
}

/**
 * The instant a poll was taken, from its file name: "20261003T160848Z.json.gz" (a UTC instant) or
 * "1791130515.585.json.gz" (epoch seconds, then milliseconds).
 */
function instantOf(file: string): Option.Option<DateTime.Utc> {
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json\.gz$/.exec(file)
  if (utc !== null) {
    const [, year, month, day, hour, minute, second] = utc
    return Option.some(DateTime.makeUnsafe(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`))
  }
  const epoch = /^(\d{10})\.(\d{3})\.json\.gz$/.exec(file)
  return epoch === null
    ? Option.none()
    : Option.some(DateTime.makeUnsafe(Number(epoch[1]) * 1000 + Number(epoch[2])))
}

/** A recording could not be read, and why. */
export class RecordingUnreadable extends Schema.TaggedError<RecordingUnreadable>()("RecordingUnreadable", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

const leagues: Record<string, LeagueId> = { "college-football": "fbs", nfl: "nfl" }
