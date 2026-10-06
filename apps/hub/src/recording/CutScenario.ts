import { fileURLToPath } from "node:url"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Array as Arr, DateTime, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { Argument, Command } from "effect/cli"
import * as Gzip from "../Gzip.ts"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import { RecordedScenario } from "../scenario/RecordedScenario.ts"
import { Scenario } from "../scenario/Scenario.ts"
import * as Recording from "./Recording.ts"

/**
 * A window of a recorded game day as a scenario: each scoreboard poll in it, decoded as ESPN's live ones are, is a
 * frame, timed from the first. `recording` is a league's folder of a recorded day; `games`, when not empty, keeps
 * only those games.
 */
export const cut = Effect.fn("CutScenario.cut")(function* (options: {
  name: string
  recording: string
  from: DateTime.Utc
  to: DateTime.Utc
  games: ReadonlyArray<string>
}) {
  const polls = (yield* Recording.polls(options.recording)).filter(({ at }) =>
    DateTime.between(at, { minimum: options.from, maximum: options.to })
  )
  const first = yield* Option.match(Arr.head(polls), {
    onNone: () =>
      Effect.fail(
        new CutFailed({ reason: `no scoreboard poll in ${options.recording} falls in the window` })
      ),
    onSome: Effect.succeed
  })
  const frames = yield* Effect.forEach(polls, (poll) =>
    slateOf(poll).pipe(
      Effect.map((slate) => ({
        at: DateTime.toEpochMillis(poll.at) - DateTime.toEpochMillis(first.at),
        slate: slate.filter((game) => options.games.length === 0 || options.games.includes(game.id))
      }))
    )
  )
  return new Scenario({ name: options.name, origin: first.at, frames })
})

/** A recording could not be cut into a scenario, and why. */
class CutFailed extends Schema.TaggedError<CutFailed>()("CutFailed", { reason: Schema.String }) {}

/** The games ESPN's provider lists from one poll: the poll as a frame, through `decode`. */
function slateOf(poll: {
  league: LeagueId
  at: DateTime.Utc
  path: string
}): Effect.Effect<ReadonlyArray<GameSnapshot>, CutFailed, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const body = yield* (yield* FileSystem.FileSystem).readFile(poll.path).pipe(
      Effect.flatMap((bytes) => Gzip.decompress(bytes, "gzip")),
      Effect.mapError(() => new CutFailed({ reason: `${poll.path} is not gzipped` }))
    )
    const said = yield* EspnDecode.decode(
      Stream.make({
        seq: 0,
        receivedAt: poll.at,
        feed: "poll",
        channel: poll.league,
        kind: "response",
        body
      } as const)
    ).pipe(Stream.runCollect)
    const listing = said.flatMap((one) =>
      one._tag === "Delivered" && one.delivery._tag === "Listing" ? [one.delivery.games] : []
    )
    return yield* Option.match(Arr.head(listing), {
      onNone: () => Effect.fail(new CutFailed({ reason: `${poll.path} is not an ESPN scoreboard` })),
      onSome: Effect.succeed
    })
  })
}

// As a script: pnpm --filter @sportal/hub scenario:cut <name> <recording-dir> <from> <to> [game ids…]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = Command.make(
    "scenario:cut",
    {
      name: Argument.String("name").pipe(
        Argument.withDescription("The scenario's name: lowercase letters, digits, and dashes"),
        Argument.withSchema(Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/)))
      ),
      recording: Argument.String("recording-dir").pipe(
        Argument.withDescription("A recorded day's league folder")
      ),
      from: Argument.String("from").pipe(
        Argument.withDescription("The window's first instant, ISO"),
        Argument.withSchema(Schema.DateTimeUtcFromString)
      ),
      to: Argument.String("to").pipe(
        Argument.withDescription("The window's last instant, ISO"),
        Argument.withSchema(Schema.DateTimeUtcFromString)
      ),
      games: Argument.String("game").pipe(
        Argument.withDescription("Game ids to keep; every game when left out"),
        Argument.variadic()
      )
    },
    ({ name, recording, from, to, games }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fs = yield* FileSystem.FileSystem
        // pnpm runs scripts in the package; a relative recording path is the caller's.
        const scenario = yield* cut({
          name,
          recording: path.resolve(process.env.INIT_CWD ?? process.cwd(), recording),
          from,
          to,
          games
        })
        const json = yield* Schema.encodeEffect(Schema.fromJsonString(Scenario))(scenario)
        yield* fs.makeDirectory(RecordedScenario.folder, { recursive: true })
        const file = path.join(RecordedScenario.folder, `${name}.json`)
        yield* fs.writeFileString(file, json)
        yield* Effect.logInfo(
          `CutScenario: wrote ${file}: ${scenario.frames.length} frames, ${Math.round(json.length / 1024)} KB`
        )
      })
  )
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
}
