import { GameDay } from "@sportal/domain/GameDay"
import type { GameEvent } from "@sportal/domain/GameEvent"
import { Slate, type Taken } from "@sportal/domain/Slate"
import {
  Array as Arr,
  Cause,
  Chunk,
  Console,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Pool,
  Queue,
  Ref,
  Schema,
  type Scope,
  Stream
} from "effect"
import { Worker, type WorkerError } from "effect/workers"
import { CorpusDays, CorpusDayUnreadable } from "./CorpusDay.ts"

/**
 * Plays corpus day `date` through the slate on virtual time: each frame taken at its `at`, which first ticks every
 * instant due before it, then a tick to the next day's start. No clock runs: the slate's now is always the input's.
 * `subject` steps over each take and the last tick, a `Raised` observation among the rest, and gives what it has at
 * the end.
 *
 * @public Read outside this file by the corpus tests and the events dump script.
 */
export const day = Effect.fn("CorpusRun.day")(function* <S, A>(
  date: GameDay,
  subject: Subject<S, A>
): Effect.fn.Return<A, CorpusDayUnreadable, CorpusDays | DateTime.CurrentTimeZone> {
  const zone = yield* DateTime.CurrentTimeZone
  const { until } = GameDay.bounds(date, zone)
  const corpusDays = yield* CorpusDays
  const { frames } = yield* corpusDays.read(date)

  const taken = yield* Stream.runFoldEffect(
    frames,
    () => ({ slate: Slate.empty, state: subject.initial }),
    ({ slate, state }, frame) =>
      Effect.map(slate.take(frame), (step) => ({ slate: step.next, state: subject.step(state, step) }))
  )
  const ended = yield* taken.slate.tick(until)
  return subject.done(subject.step(taken.state, ended))
})

/**
 * What a run plays a day through: a pure step over each take or tick of the slate, and what it gives at the end.
 *
 * @public Named by the Synthesis tests' own subject.
 */
export interface Subject<S, A> {
  readonly initial: S
  readonly step: (state: S, taken: Taken) => S
  readonly done: (state: S) => A
}

/**
 * The subject this spec runs: the day's game events, in order.
 *
 * @public Read outside this file by the corpus tests and the events dump script.
 */
export const events: Subject<Chunk.Chunk<GameEvent>, ReadonlyArray<GameEvent>> = {
  initial: Chunk.empty(),
  step: (seen, { events }) =>
    events.length === 0 ? seen : Chunk.appendAll(seen, Chunk.fromIterable(events)),
  done: Chunk.toReadonlyArray
}

/** A worker's request: run one day with the events subject; its reply is the day's event count and duration. */
export class RunDay extends Schema.TaggedClass<RunDay>()("RunDay", { date: GameDay }) {
  /** What a worker serves: the day run through the slate with the events subject, timed. */
  run(): Effect.Effect<DayRun, CorpusDayUnreadable, CorpusDays | DateTime.CurrentTimeZone> {
    return day(this.date, events).pipe(
      Effect.timed,
      Effect.map(
        ([took, told]) =>
          new DayRun({ date: this.date, events: told.length, millis: Math.round(Duration.toMillis(took)) })
      )
    )
  }
}

/** A day a worker ran: how many events its run gave, and how long the run took. */
export class DayRun extends Schema.Class<DayRun>("sportal/hub/DayRun")({
  date: GameDay,
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
export const runDays = Effect.fn("CorpusRun.runDays")(function* (
  dates: ReadonlyArray<GameDay>,
  workers: number
): Effect.fn.Return<
  void,
  WorkerError.WorkerError | DaysFailed,
  Worker.WorkerPlatform | Worker.Spawner | Scope.Scope
> {
  const next = yield* Ref.make(1)
  const pool = yield* Pool.make({ acquire: spawned(next), size: Math.min(workers, dates.length) })

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
                    error instanceof CorpusDayUnreadable
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

  const runs = ran.flatMap(({ worker, exit }) => (Exit.isSuccess(exit) ? [{ worker, run: exit.value }] : []))
  const means = Object.entries(Arr.groupBy(runs, ({ worker }) => String(worker))).map(
    ([worker, of]) =>
      `worker ${worker} ${Math.round(Arr.reduce(of, 0, (sum, { run }) => sum + run.millis) / of.length)} ms`
  )
  const failed = dates.length - runs.length
  const total = Arr.reduce(runs, 0, (sum, { run }) => sum + run.events)
  yield* Console.log(
    `${dates.length} days, ${failed} failed, ${total} events in ${Math.round(Duration.toMillis(wall))} ms; mean day: ${means.join(", ") || "none"}`
  )
  if (failed > 0) {
    return yield* new DaysFailed({ failed, days: dates.length })
  }
}, Effect.scoped)

/** Of the `days` a corpus command built or ran, `failed` did not succeed; each was logged as it failed. */
export class DaysFailed extends Schema.TaggedError<DaysFailed>()("DaysFailed", {
  failed: Schema.Int,
  days: Schema.Int
}) {
  override get message() {
    return `${this.failed} of ${this.days} days failed`
  }
}

// A worker thread of the pool, numbered by `next`, asked one day at a time; its thread closes with the pool.
const spawned = Effect.fn("CorpusRun.spawned")(function* (next: Ref.Ref<number>) {
  const id = yield* Ref.getAndUpdate(next, (id) => id + 1)
  const platform = yield* Worker.WorkerPlatform
  const worker = yield* platform.spawn<unknown, unknown>(id)
  const replies = yield* Queue.unbounded<unknown>()
  const running = yield* worker.run((reply) => Queue.offer(replies, reply)).pipe(Effect.forkScoped)
  return {
    id,
    ask: (date: GameDay) =>
      encodeRequest(new RunDay({ date })).pipe(
        Effect.orDie,
        Effect.flatMap((request) => worker.send(request)),
        // A thread that stops fails the day's wait instead of leaving it waiting.
        Effect.andThen(Effect.raceFirst(Queue.take(replies), Fiber.join(running))),
        Effect.flatMap(DayRun.fromReply)
      )
  }
})

const Reply = Schema.toCodecJson(Schema.Exit(DayRun, CorpusDayUnreadable, Schema.Defect()))

const encodeReply = Schema.encodeEffect(Reply)

const decodeReply = Schema.decodeUnknownEffect(Reply)

const encodeRequest = Schema.encodeEffect(RunDay)
