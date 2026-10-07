import { availableParallelism } from "node:os"
import { Worker } from "node:worker_threads"
import { NodeRuntime, NodeServices, NodeWorker } from "@effect/platform-node"
import { GameDay } from "@sportal/domain/GameDay"
import { LeagueId } from "@sportal/domain/League"
import { Array as Arr, DateTime, Duration, Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { FeedLog } from "../feed-log/FeedLog.ts"
import { HubConfig } from "../HubConfig.ts"
import { ArchiveFetchFailed, Archiver } from "../provider/Archiver.ts"
import * as Espn from "../provider/espn/Espn.ts"
import * as CorpusBuild from "./CorpusBuild.ts"
import { type CorpusDay, CorpusDays } from "./CorpusDay.ts"
import * as CorpusRun from "./CorpusRun.ts"

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

// ESPN's archiver and decode, over the network: only the commands that read or fetch the archive are given it.
const archival = Espn.layerArchival.pipe(Layer.provide(FetchHttpClient.layer))

const build = Command.make(
  "build",
  {
    ...days,
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Every game day the feed log has frames of, and every day the corpus has"),
      Flag.withDefault(false)
    ),
    backfilled: Flag.Boolean("backfilled").pipe(
      Flag.withDescription(
        "Build each day from the archive, as a backfilled day, whatever the corpus has of it"
      ),
      Flag.withDefault(false)
    )
  },
  Effect.fn(function* ({ all, backfilled, ...chosen }) {
    const corpusDays = yield* CorpusDays
    const chosenDays = yield* all ? everyDay(chosen) : named(chosen)
    const buildDay = Effect.fn("Corpus.buildDay")(function* (date: GameDay) {
      const existing = yield* corpusDays.day(date)
      if (!backfilled && !Option.exists(existing, ({ kind }) => kind === "backfilled")) {
        return yield* reported(date, "captured", CorpusBuild.captured(date))
      }
      // The day's own leagues, or, for a day the corpus does not have, every league the archive has of it.
      const leagues = Option.isSome(existing) ? [] : LeagueId.literals
      return yield* reported(date, "backfilled", CorpusBuild.backfilled(date, leagues, "archived"))
    })
    const outcomes = yield* Effect.forEach(chosenDays, buildDay)
    const failed = outcomes.filter(({ outcome }) => outcome === "failed").length
    if (failed > 0) {
      return yield* new CorpusRun.DaysFailed({ failed, days: chosenDays.length })
    }
  })
).pipe(
  Command.withDescription("Build corpus days: captured from the feed log, backfilled from the archive"),
  Command.provide(Layer.mergeAll(FeedLog.layerInDataDir, archival))
)

const backfill = Command.make(
  "backfill",
  {
    league: Flag.Literals("league", LeagueId.literals).pipe(Flag.withDescription("The league to backfill")),
    from: Flag.String("from").pipe(Flag.withDescription("The first game day"), Flag.withSchema(GameDay)),
    to: Flag.String("to").pipe(Flag.withDescription("The last game day"), Flag.withSchema(GameDay))
  },
  Effect.fn(function* ({ league, from, to }) {
    if (to < from) {
      return yield* unchosen(`--to ${to} is before --from ${from}`)
    }
    const span = GameDay.dates(from, to)
    // An archived scoreboard is never fetched again, so a day not over yet would be kept part way for good.
    const now = yield* DateTime.now
    const zone = yield* DateTime.CurrentTimeZone
    const unended = Arr.filterMap(span, (date) => {
      const { until } = GameDay.bounds(date, zone)
      return DateTime.isGreaterThan(until, now) ? Result.succeed({ date, until }) : Result.failVoid
    })
    if (Arr.isReadonlyArrayNonEmpty(unended)) {
      const { date, until } = Arr.headNonEmpty(unended)
      const ends = DateTime.formatIsoZoned(DateTime.setZone(until, zone))
      return yield* new CliError.UserError({
        cause: "day not over",
        userMessage: `${date} is not over until ${ends}; backfill only days that have ended, since an archived scoreboard is never fetched again`
      })
    }

    const { pacing } = yield* Archiver
    const [took, outcomes] = yield* Stream.fromIterable(span).pipe(
      Stream.schedule(pacing),
      Stream.mapEffect((date) =>
        reported(date, "backfilled", CorpusBuild.backfilled(date, [league], "fetch"))
      ),
      Stream.runCollect,
      Effect.timed
    )
    const of = (outcome: (typeof outcomes)[number]["outcome"]) =>
      outcomes.filter((reported) => reported.outcome === outcome)
    const failed = of("failed")
    yield* Effect.log(
      [
        `Backfilled ${league} from ${from} to ${to} in ${Math.round(Duration.toSeconds(took))} s:`,
        `${of("built").length} days built,`,
        `${outcomes.reduce((games, reported) => games + reported.games, 0)} games;`,
        `${of("kept").length} captured kept, ${of("absent").length} without games, ${failed.length} failed`,
        ...(failed.length > 0 ? [`(${failed.map(({ date }) => date).join(", ")})`] : [])
      ].join(" ")
    )
    if (failed.length > 0) {
      return yield* new CorpusRun.DaysFailed({ failed: failed.length, days: span.length })
    }
  })
).pipe(
  Command.withDescription(
    "Fetch a league's days into the archive, and build each as a backfilled corpus day"
  ),
  Command.provide(archival)
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
    const chosenDays = yield* named(chosen)
    yield* CorpusRun.runDays(chosenDays, workers)
  })
).pipe(
  Command.withDescription("Run corpus days through the slate, on worker threads"),
  Command.provide(NodeWorker.layer(() => new Worker(new URL("./worker.ts", import.meta.url))))
)

// Every game day the feed log has frames of, and every day the corpus has: `--all`, which names no day beside it.
function everyDay(chosen: {
  readonly date: Option.Option<GameDay>
  readonly from: Option.Option<GameDay>
  readonly to: Option.Option<GameDay>
}) {
  if (Option.isSome(chosen.date) || Option.isSome(chosen.from) || Option.isSome(chosen.to)) {
    return unchosen("Name a date, --from and --to, or --all alone")
  }
  return Effect.all([
    // A feed-log day that does not decode means the log itself is broken, so a defect, not a failure to report.
    FeedLog.use((feedLog) => feedLog.days).pipe(Effect.flatMap(decodeDays), Effect.orDie),
    CorpusDays.use((corpusDays) => corpusDays.dates)
  ]).pipe(Effect.map(([logged, built]) => [...new Set([...logged, ...built])].toSorted()))
}

// The days a command names: one, or every day of a span.
function named({
  date,
  from,
  to
}: {
  readonly date: Option.Option<GameDay>
  readonly from: Option.Option<GameDay>
  readonly to: Option.Option<GameDay>
}) {
  if (Option.isSome(date) && Option.isNone(from) && Option.isNone(to)) return Effect.succeed([date.value])
  if (Option.isNone(date) && Option.isSome(from) && Option.isSome(to)) {
    return to.value < from.value
      ? unchosen(`--to ${to.value} is before --from ${from.value}`)
      : Effect.succeed(GameDay.dates(from.value, to.value))
  }
  return unchosen("Name a date, or --from and --to")
}

/**
 * Runs `build` of day `date` as a `kind` day, and logs how it went: built, kept (a captured day a backfill does not
 * replace), absent (a day the feed log or archive does not have, which is not a failure of the command), or failed.
 */
const reported = Effect.fn("Corpus.reported")(function* <R>(
  date: GameDay,
  kind: CorpusDay["kind"],
  build: Effect.Effect<CorpusDay, CorpusBuild.CorpusBuildFailed | ArchiveFetchFailed, R>
): Effect.fn.Return<
  {
    readonly date: GameDay
    readonly outcome: "built" | "kept" | "absent" | "failed"
    readonly games: number
  },
  never,
  R
> {
  const [took, built] = yield* Effect.timed(Effect.result(build))
  if (Result.isSuccess(built)) {
    const day = built.success
    if (day.kind !== kind) {
      yield* Effect.log(`Kept ${day.date}: a captured day is never replaced by a backfilled one`)
      return { date, outcome: "kept", games: 0 }
    }
    yield* Effect.log(
      `Built ${kind} ${day.date} in ${Math.round(Duration.toMillis(took))} ms: ${day.games} games of ${day.leagues.join(", ")}`
    )
    return { date, outcome: "built", games: day.games }
  }
  const failed = built.failure
  if (
    failed.reason === "NoFrames" ||
    failed.reason === "NoGames" ||
    (failed instanceof ArchiveFetchFailed && failed.reason === "NotArchived" && failed.game === undefined)
  ) {
    yield* Effect.logWarning(failed.message)
    return { date, outcome: "absent", games: 0 }
  }
  yield* Effect.logError(failed.message, failed.cause)
  return { date, outcome: "failed", games: 0 }
})

function unchosen(userMessage: string) {
  return Effect.fail(new CliError.UserError({ cause: "no days chosen", userMessage }))
}

// A feed log day is always YYYY-MM-DD.
const decodeDays = Schema.decodeUnknownEffect(Schema.Array(GameDay))

Command.make("corpus").pipe(
  Command.withDescription("Build, backfill, and run the corpus's game days"),
  Command.withSubcommands([build, backfill, run]),
  Command.run({ version: "dev" }),
  Effect.provide(
    Layer.mergeAll(CorpusDays.layer, DateTime.layerCurrentZoneLocal).pipe(
      Layer.provideMerge(HubConfig.layer),
      Layer.provideMerge(NodeServices.layer)
    )
  ),
  NodeRuntime.runMain
)
