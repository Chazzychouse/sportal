import {
  Array as Arr,
  Cause,
  Console,
  type DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Pool,
  Queue,
  Ref,
  Schema
} from "effect"
import { Worker, type WorkerError } from "effect/workers"
import { type CorpusDays, CorpusDayUnreadable, DaysFailed } from "./CorpusDay.ts"
import * as CorpusRun from "./CorpusRun.ts"

/** A worker's request: run one day with the events subject; its reply is the day's event count and duration. */
export class RunDay extends Schema.TaggedClass<RunDay>()("RunDay", { date: Schema.String }) {
  /** What a worker serves: the day run through the slate with the events subject, timed. */
  run(): Effect.Effect<DayRun, CorpusDayUnreadable, CorpusDays | DateTime.CurrentTimeZone> {
    return CorpusRun.day(this.date, CorpusRun.events).pipe(
      Effect.timed,
      Effect.map(
        ([took, events]) =>
          new DayRun({ date: this.date, events: events.length, millis: Math.round(Duration.toMillis(took)) })
      )
    )
  }
}

/** A day a worker ran: how many events its run gave, and how long the run took. */
export class DayRun extends Schema.Class<DayRun>("sportal/hub/DayRun")({
  date: Schema.String,
  events: Schema.Int,
  millis: Schema.Int
}) {
  /** A worker's reply to a `RunDay` as it crosses to the parent thread: the day's run, or how it failed. */
  static reply(exit: Exit.Exit<DayRun, CorpusDayUnreadable>): Effect.Effect<unknown> {
    // A reply built from its own schema always encodes.
    return encodeReply(exit).pipe(Effect.orDie)
  }

  /** The run or failure a worker's reply holds. */
  static fromReply(reply: unknown): Effect.Effect<Exit.Exit<DayRun, CorpusDayUnreadable>> {
    return decodeReply(reply).pipe(Effect.orDie)
  }
}

/**
 * Runs `dates` across up to `workers` worker threads, one day to a worker at a time, and ends with one summary line:
 * days, failed days, events, wall time, and each worker's mean day time. A failed day is logged and counted, and fails
 * the run with `DaysFailed` once every day has run. A thread that crashes fails its day alone: a fresh one takes its
 * place. Only a thread that cannot be spawned stops the run.
 */
export function runDays(
  dates: ReadonlyArray<string>,
  workers: number
): Effect.Effect<void, WorkerError.WorkerError | DaysFailed, Worker.WorkerPlatform | Worker.Spawner> {
  return Effect.gen(function* () {
    const pool = yield* Pool.make({
      acquire: spawned(yield* Ref.make(1)),
      size: Math.min(workers, dates.length)
    })
    const [wall, ran] = yield* Effect.forEach(
      dates,
      (date) =>
        Pool.use(pool, (worker) =>
          worker.ask(date).pipe(
            Effect.catch((crashed) => Pool.invalidate(pool, worker).pipe(Effect.as(Exit.fail(crashed)))),
            Effect.map((exit): Exit.Exit<DayRun, CorpusDayUnreadable | WorkerError.WorkerError> => exit),
            Effect.tap(
              Exit.match({
                onSuccess: () => Effect.void,
                onFailure: (cause) =>
                  Option.match(Cause.findErrorOption(cause), {
                    // A day that cannot be read says why; a crashed thread is logged with its cause.
                    onSome: (error) =>
                      error._tag === "CorpusDayUnreadable"
                        ? Effect.logError(error.message)
                        : Effect.logError(`Corpus day ${date} failed`, cause),
                    onNone: () => Effect.logError(`Corpus day ${date} failed`, cause)
                  })
              })
            ),
            Effect.map((exit) => ({ worker: worker.id, exit }))
          )
        ),
      { concurrency: "unbounded" }
    ).pipe(Effect.timed)
    const runs = ran.flatMap(({ worker, exit }) =>
      Exit.isSuccess(exit) ? [{ worker, run: exit.value }] : []
    )
    const means = Object.entries(Arr.groupBy(runs, ({ worker }) => String(worker))).map(
      ([worker, of]) =>
        `worker ${worker} ${Math.round(Arr.reduce(of, 0, (sum, { run }) => sum + run.millis) / of.length)} ms`
    )
    const failed = dates.length - runs.length
    yield* Console.log(
      `${dates.length} days, ${failed} failed, ${Arr.reduce(runs, 0, (sum, { run }) => sum + run.events)} events in ${Math.round(Duration.toMillis(wall))} ms; mean day: ${means.join(", ") || "none"}`
    )
    if (failed > 0) return yield* new DaysFailed({ failed, days: dates.length })
  }).pipe(Effect.scoped)
}

const Reply = Schema.toCodecJson(Schema.Exit(DayRun, CorpusDayUnreadable, Schema.Defect()))

const encodeReply = Schema.encodeEffect(Reply)

const decodeReply = Schema.decodeUnknownEffect(Reply)

const encodeRequest = Schema.encodeEffect(RunDay)

// A worker thread of the pool, numbered by `next`, asked one day at a time; its thread closes with the pool.
function spawned(next: Ref.Ref<number>) {
  return Effect.gen(function* () {
    const id = yield* Ref.getAndUpdate(next, (id) => id + 1)
    const worker = yield* (yield* Worker.WorkerPlatform).spawn<unknown, unknown>(id)
    const replies = yield* Queue.unbounded<unknown>()
    const running = yield* worker.run((reply) => Queue.offer(replies, reply)).pipe(Effect.forkScoped)
    return {
      id,
      ask: (date: string) =>
        encodeRequest(new RunDay({ date })).pipe(
          Effect.orDie,
          Effect.flatMap((request) => worker.send(request)),
          // A thread that stops fails the day's wait instead of leaving it waiting.
          Effect.andThen(Effect.raceFirst(Queue.take(replies), Fiber.join(running))),
          Effect.flatMap(DayRun.fromReply)
        )
    }
  })
}
