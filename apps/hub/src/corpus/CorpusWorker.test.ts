import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option } from "effect"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import { CorpusDayUnreadable } from "./CorpusDay.ts"
import * as CorpusRun from "./CorpusRun.ts"
import { DayRun, RunDay } from "./CorpusWorker.ts"
import { built, inCorpus, logged, recorded } from "./TestCorpus.ts"

describe("RunDay.run", () => {
  it.effect(
    "answers RunDay for the recorded NE at BUF day with the event count its run gives",
    () =>
      inCorpus(EspnDecode.layer, () =>
        Effect.gen(function* () {
          yield* logged(yield* recorded)
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
