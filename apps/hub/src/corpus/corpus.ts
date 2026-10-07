import { availableParallelism } from "node:os"
import { Worker } from "node:worker_threads"
import { NodeRuntime, NodeServices, NodeWorker } from "@effect/platform-node"
import { DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { FeedLog } from "../FeedLog.ts"
import { HubConfig } from "../HubConfig.ts"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import * as CorpusBuild from "./CorpusBuild.ts"
import { CorpusDay, CorpusDays } from "./CorpusDay.ts"
import * as CorpusWorker from "./CorpusWorker.ts"

const GameDay = Schema.String.check(
  Schema.makeFilter(
    (date) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Option.exists(DateTime.make(`${date}T12:00:00Z`), (noon) => DateTime.formatIsoDateUtc(noon) === date),
    { expected: "a date, YYYY-MM-DD" }
  )
)

const days = {
  date: Argument.String("date").pipe(
    Argument.withDescription("The game day, YYYY-MM-DD"),
    Argument.withSchema(GameDay),
    Argument.optional
  ),
  from: Flag.String("from").pipe(
    Flag.withDescription("The first game day of a span, with --to"),
    Flag.withSchema(GameDay),
    Flag.optional
  ),
  to: Flag.String("to").pipe(
    Flag.withDescription("The last game day of a span, with --from"),
    Flag.withSchema(GameDay),
    Flag.optional
  )
}

const build = Command.make(
  "build",
  {
    ...days,
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Every game day the feed log has frames of"),
      Flag.withDefault(false)
    )
  },
  Effect.fn(function* ({ all, ...chosen }) {
    const dates = all
      ? Option.isNone(chosen.date) && Option.isNone(chosen.from) && Option.isNone(chosen.to)
        ? yield* (yield* FeedLog).days
        : yield* unchosen("Name a date, --from and --to, or --all alone")
      : yield* named(chosen)
    yield* Effect.forEach(
      dates,
      (date) =>
        CorpusBuild.captured(date).pipe(
          Effect.timed,
          Effect.matchEffect({
            onSuccess: ([took, day]) =>
              Effect.log(
                `Built ${day.date} in ${Math.round(Duration.toMillis(took))} ms: ${day.games} games of ${day.leagues.join(", ")}`
              ),
            onFailure: (failed) =>
              failed.reason === "NoFrames"
                ? Effect.logWarning(failed.message)
                : Effect.logError(failed.message, failed.cause)
          })
        ),
      { discard: true }
    )
  })
).pipe(
  Command.withDescription("Build captured corpus days from the feed log"),
  Command.provide(Layer.mergeAll(FeedLog.inDataDir, EspnDecode.layer))
)

const run = Command.make(
  "run",
  {
    ...days,
    workers: Flag.Int("workers").pipe(
      Flag.withDescription("How many days run at once, each on its own worker thread"),
      Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      Flag.withDefault(Math.max(1, availableParallelism() - 1))
    )
  },
  Effect.fn(function* ({ workers, ...chosen }) {
    yield* CorpusWorker.runDays(yield* named(chosen), workers)
  })
).pipe(
  Command.withDescription("Run corpus days through the slate, on worker threads"),
  Command.provide(NodeWorker.layer(() => new Worker(new URL("./worker.ts", import.meta.url))))
)

Command.make("corpus").pipe(
  Command.withDescription("Build and run the corpus's game days"),
  Command.withSubcommands([build, run]),
  Command.run({ version: "dev" }),
  Effect.provide(
    Layer.mergeAll(CorpusDays.layer, DateTime.layerCurrentZoneLocal).pipe(
      Layer.provideMerge(HubConfig.layer),
      Layer.provideMerge(NodeServices.layer)
    )
  ),
  NodeRuntime.runMain
)

// The days a command names: one, or every day of a span.
function named({
  date,
  from,
  to
}: {
  readonly date: Option.Option<string>
  readonly from: Option.Option<string>
  readonly to: Option.Option<string>
}) {
  if (Option.isSome(date) && Option.isNone(from) && Option.isNone(to)) return Effect.succeed([date.value])
  if (Option.isNone(date) && Option.isSome(from) && Option.isSome(to)) {
    return Effect.succeed(CorpusDay.dates(from.value, to.value))
  }
  return unchosen("Name a date, or --from and --to")
}

function unchosen(userMessage: string) {
  return Effect.fail(new CliError.UserError({ cause: "no days chosen", userMessage }))
}
