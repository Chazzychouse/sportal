import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import type { LeagueId } from "@sportal/domain/League"
import { Scenario } from "@sportal/domain/Scenario"
import { DateTime, Effect, FileSystem, Option, Schema } from "effect"
// A script entry point, like main.ts, so it may name the scenario adapter's folder.
import { folder } from "../../scenario/ScenarioIngest.ts"
import * as EspnDecode from "./EspnDecode.ts"
import * as EspnPayload from "./EspnPayload.ts"

/**
 * A window of a recorded game day as a scenario: each scoreboard poll in it, decoded as ESPN's live ones are, is a
 * frame, timed from the first. `recording` is a league's folder of one of the spike's recorders (`…/college-football`
 * or `…/nfl`); `games`, when not empty, keeps only those games.
 */
export const cut = Effect.fn("CutScenario.cut")(function* (options: {
  name: string
  recording: string
  from: DateTime.Utc
  to: DateTime.Utc
  games: ReadonlyArray<string>
}) {
  const league = yield* Option.match(leagueOf(options.recording), {
    onNone: () =>
      Effect.fail(
        new CutFailed({ reason: `${options.recording} is not a college-football or nfl recording` })
      ),
    onSome: Effect.succeed
  })
  const fs = yield* FileSystem.FileSystem
  const scoreboards = join(options.recording, "scoreboard")
  const polls = (yield* fs.readDirectory(scoreboards))
    .flatMap((file) => Option.toArray(Option.map(instantOf(file), (instant) => ({ file, instant }))))
    .filter(({ instant }) => DateTime.between(instant, { minimum: options.from, maximum: options.to }))
    .sort((a, b) => DateTime.toEpochMillis(a.instant) - DateTime.toEpochMillis(b.instant))
  const [first] = polls
  if (first === undefined)
    return yield* Effect.fail(
      new CutFailed({ reason: `no scoreboard poll in ${scoreboards} falls in the window` })
    )

  const frames: Array<Scenario["frames"][number]> = []
  for (const { file, instant } of polls) {
    const bytes = yield* fs.readFile(join(scoreboards, file))
    const scoreboard = yield* Effect.try({
      try: () => gunzipSync(bytes).toString("utf8"),
      catch: () => new CutFailed({ reason: `${file} is not gzipped` })
    }).pipe(
      Effect.flatMap((json) =>
        decodeScoreboard(json).pipe(
          Effect.mapError(() => new CutFailed({ reason: `${file} is not an ESPN scoreboard` }))
        )
      )
    )
    const slate = (yield* EspnDecode.slateOf(league, scoreboard)).filter(
      (game) => options.games.length === 0 || options.games.includes(game.id)
    )
    frames.push({ at: DateTime.toEpochMillis(instant) - DateTime.toEpochMillis(first.instant), slate })
  }
  return new Scenario({ name: options.name, origin: first.instant, frames })
})

/** A recording could not be cut into a scenario, and why. */
class CutFailed extends Schema.TaggedError<CutFailed>()("CutFailed", { reason: Schema.String }) {}

/** The league a recording's folder (`…/college-football` or `…/nfl`) holds. */
export function leagueOf(recording: string): Option.Option<LeagueId> {
  return Option.fromUndefinedOr(leagues[basename(recording)])
}

const leagues: Record<string, LeagueId> = { "college-football": "fbs", nfl: "nfl" }

/**
 * The instant a recorded poll was taken, from its name: "20261003T160848Z.json.gz" (record.sh) or
 * "1791130515.585.json.gz" (record.py: epoch seconds, then milliseconds).
 */
export function instantOf(file: string): Option.Option<DateTime.Utc> {
  return utcNameInstant(file).pipe(Option.orElse(() => epochNameInstant(file)))
}

function utcNameInstant(file: string): Option.Option<DateTime.Utc> {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json\.gz$/.exec(file)
  if (match === null) return Option.none()
  const [, year, month, day, hour, minute, second] = match
  return Option.some(DateTime.makeUnsafe(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`))
}

function epochNameInstant(file: string): Option.Option<DateTime.Utc> {
  const match = /^(\d{10})\.(\d{3})\.json\.gz$/.exec(file)
  if (match === null) return Option.none()
  return Option.some(DateTime.makeUnsafe(Number(match[1]) * 1000 + Number(match[2])))
}

const decodeScoreboard = Schema.decodeEffect(Schema.fromJsonString(EspnPayload.Scoreboard))

// As a script: pnpm --filter @sportal/hub scenario:cut <name> <recording-dir> <from> <to> [game ids…]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, recording, from, to, ...games] = process.argv.slice(2)
  const window = Option.all({
    from: DateTime.make(from ?? "").pipe(Option.map(DateTime.toUtc)),
    to: DateTime.make(to ?? "").pipe(Option.map(DateTime.toUtc))
  })
  if (name === undefined || !/^[a-z0-9-]+$/.test(name) || recording === undefined || Option.isNone(window)) {
    console.error(
      "Usage: scenario:cut <name, lowercase-and-dashes> <recording-dir> <from ISO instant> <to ISO instant> [game ids…]"
    )
    process.exitCode = 1
  } else {
    Effect.gen(function* () {
      // pnpm runs scripts in the package; a relative recording path is the caller's.
      const scenario = yield* cut({
        name,
        recording: resolve(process.env.INIT_CWD ?? process.cwd(), recording),
        ...window.value,
        games
      })
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(Scenario))(scenario)
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(folder, { recursive: true })
      const path = join(folder, `${name}.json`)
      yield* fs.writeFileString(path, json)
      yield* Effect.logInfo(
        `CutScenario: wrote ${path}: ${scenario.frames.length} frames, ${Math.round(json.length / 1024)} KB`
      )
    }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
  }
}
