import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option, Queue, Ref, Schema } from "effect"
import { Worker, WorkerError } from "effect/workers"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import { recordedNeAtBuf } from "../provider/espn/TestEspn.ts"
import { logged } from "../TestFeedLog.ts"
import { CorpusDayUnreadable, DaysFailed } from "./CorpusDay.ts"
import * as CorpusRun from "./CorpusRun.ts"
import { DayRun, RunDay, runDays } from "./CorpusWorker.ts"
import { built, inCorpus } from "./TestCorpus.ts"

describe("RunDay.run", () => {
  it.effect(
    "answers RunDay for the recorded NE at BUF day with the event count its run gives",
    () =>
      inCorpus(EspnDecode.layer, () =>
        Effect.gen(function* () {
          yield* logged(yield* recordedNeAtBuf)
          yield* built("2026-10-04")
          const run = yield* new RunDay({ date: "2026-10-04" }).run()
          const events = yield* CorpusRun.day("2026-10-04", CorpusRun.events)
          assert.strictEqual(run.date, "2026-10-04")
          assert.strictEqual(run.events, events.length)
          assert.isAbove(run.events, 0)
          assert.isAtLeast(run.millis, 0)
        })
      ),
    { timeout: 60_000 }
  )

  it.effect("fails a day that has not been built as CorpusDayUnreadable Missing", () =>
    inCorpus(EspnDecode.layer, () =>
      Effect.gen(function* () {
        const error = yield* new RunDay({ date: "2026-10-04" }).run().pipe(Effect.flip)
        assert.deepStrictEqual([error.date, error.reason], ["2026-10-04", "Missing"])
      })
    )
  )
})

describe("DayRun.reply", () => {
  it.effect("crosses a thread as the run or the typed failure it holds", () =>
    Effect.gen(function* () {
      const run = Exit.succeed(new DayRun({ date: "2026-10-04", events: 266, millis: 95 }))
      const missing = Exit.fail(
        new CorpusDayUnreadable({ date: "2026-10-05", reason: "Missing", cause: "day.json" })
      )
      const crossed = (exit: Exit.Exit<DayRun, CorpusDayUnreadable>) =>
        DayRun.reply(exit).pipe(Effect.flatMap((reply) => DayRun.fromReply(structuredClone(reply))))

      assert.deepStrictEqual(yield* crossed(run), run)
      const failed = yield* crossed(missing)
      assert.isTrue(Exit.isFailure(failed))
      if (Exit.isFailure(failed)) {
        const error = Cause.findErrorOption(failed.cause)
        assert.deepStrictEqual(
          Option.map(error, ({ _tag, date, reason }) => [_tag, date, reason]),
          Option.some(["CorpusDayUnreadable", "2026-10-05", "Missing"])
        )
      }
    })
  )
})

describe("runDays", () => {
  it.effect("runs every day, and succeeds when none failed", () =>
    Effect.gen(function* () {
      const threads = yield* stubThreads()
      yield* runDays([ok, "2026-10-06"], 2).pipe(Effect.provide(threads.layer))
      assert.deepStrictEqual((yield* Ref.get(threads.answered)).toSorted(), [ok, "2026-10-06"])
      assert.strictEqual(yield* Ref.get(threads.spawned), 2)
    })
  )

  it.effect(
    "fails a crashed thread's day alone, a fresh thread runs the rest, and the run fails DaysFailed",
    () =>
      Effect.gen(function* () {
        const threads = yield* stubThreads()
        const error = yield* runDays([ok, crash, missing, "2026-10-06"], 1).pipe(
          Effect.provide(threads.layer),
          Effect.flip
        )
        assert.instanceOf(error, DaysFailed)
        assert.deepStrictEqual([error.failed, error.days], [2, 4])
        assert.deepStrictEqual(yield* Ref.get(threads.answered), [ok, "2026-10-06"])
        assert.strictEqual(yield* Ref.get(threads.spawned), 2)
      })
  )
})

const ok = "2026-10-03"
const crash = "2026-10-04"
const missing = "2026-10-05"

/**
 * Worker threads in this one: each answers a day with one event, a day not built as `CorpusDayUnreadable`, and stops
 * with a `WorkerError` on `crash`'s, as a thread that crashed would.
 */
function stubThreads() {
  return Effect.gen(function* () {
    const answered = yield* Ref.make<ReadonlyArray<string>>([])
    const spawned = yield* Ref.make(0)
    const platform = Worker.WorkerPlatform.of({
      spawn: () =>
        Effect.gen(function* () {
          yield* Ref.update(spawned, (count) => count + 1)
          const inbox = yield* Queue.unbounded<unknown>()
          return Worker.makeUnsafe({
            send: (message) => Queue.offer(inbox, message).pipe(Effect.asVoid),
            run: (handler) =>
              Queue.take(inbox).pipe(
                Effect.flatMap((message) => Schema.decodeUnknownEffect(RunDay)(message).pipe(Effect.orDie)),
                Effect.flatMap(({ date }) =>
                  date === crash
                    ? Effect.fail(
                        new WorkerError.WorkerError({
                          reason: new WorkerError.WorkerReceiveError({ message: "exited with code 1" })
                        })
                      )
                    : DayRun.reply(
                        date === missing
                          ? Exit.fail(new CorpusDayUnreadable({ date, reason: "Missing", cause: "day.json" }))
                          : Exit.succeed(new DayRun({ date, events: 1, millis: 1 }))
                      ).pipe(
                        Effect.tap(() =>
                          date === missing ? Effect.void : Ref.update(answered, (dates) => [...dates, date])
                        )
                      )
                ),
                Effect.flatMap((reply) => handler([1, reply])),
                Effect.forever
              )
          })
        })
    })
    return {
      answered,
      spawned,
      layer: Layer.merge(
        Layer.succeed(Worker.WorkerPlatform, platform),
        Worker.layerSpawner(() => undefined)
      )
    }
  })
}
