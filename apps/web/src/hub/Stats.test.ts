import { assert, describe, it } from "@effect/vitest"
import { CalendarDate } from "@sportal/api/GamesQuery"
import { StatsUnavailable } from "@sportal/api/StatsUnavailable"
import { GameId } from "@sportal/domain/Game"
import { GameStats } from "@sportal/domain/GameStats"
import type { Highlight } from "@sportal/domain/Highlight"
import { HighlightId } from "@sportal/domain/Highlight"
import { PlayId } from "@sportal/domain/Play"
import { highlight } from "@sportal/domain/TestGame"
import { Clock, Effect, Layer, Option, Ref } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { TestClock } from "effect/testing"
import { Shell } from "../shell/Shell.ts"
import * as TestWeb from "../TestWeb.ts"
import { HubClient } from "./HubClient.ts"
import * as Stats from "./Stats.ts"

describe("Stats.statsLive", () => {
  it.effect("should ask the Hub for that game's live stats", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const open = yield* Effect.gen(function* () {
        yield* Atom.mount(Stats.statsLive(id))

        return yield* TestWeb.asked(hub, `stats ${id}`)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.include(open, `stats ${id}`)
    })
  )

  it.effect("should hold the latest stats the Hub sends", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()
      const sent = new GameStats({ ...GameStats.empty(id), scoringPlays: [PlayId.make("p1")] })

      const { value } = yield* Effect.gen(function* () {
        yield* Atom.mount(Stats.statsLive(id))

        yield* TestWeb.answer(hub, `stats ${id}`, hub.stats, sent)
        return yield* TestWeb.until(Stats.statsLive(id), ({ value }) => Option.isSome(value))
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(value, Option.some(sent))
    })
  )
})

describe("Stats.highlightsToday", () => {
  it.effect("should ask the Hub again after five minutes", () =>
    Effect.gen(function* () {
      const { registry, asked } = yield* answering([[first], [first, second]])

      const value = yield* Effect.gen(function* () {
        yield* Atom.mount(Stats.highlightsToday(today))
        yield* TestWeb.until(Stats.highlightsToday(today), AsyncResult.isSuccess)

        yield* TestClock.adjust("5 minutes")
        return yield* TestWeb.until(Stats.highlightsToday(today), (result) => clipsIn(result).length === 2)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(clipsIn(value), [first, second])
      assert.strictEqual(yield* Ref.get(asked), 2)
    })
  )

  it.effect("should keep the last highlights while an asking fails", () =>
    Effect.gen(function* () {
      const { registry, asked } = yield* answering([[first], unavailable])

      const value = yield* Effect.gen(function* () {
        yield* Atom.mount(Stats.highlightsToday(today))
        yield* TestWeb.until(Stats.highlightsToday(today), AsyncResult.isSuccess)

        yield* TestClock.adjust("5 minutes")
        yield* TestWeb.afterTasks
        return yield* TestWeb.until(Stats.highlightsToday(today), () => true)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(clipsIn(value), [first])
      assert.strictEqual(yield* Ref.get(asked), 2)
    })
  )
})

describe("Stats.highlights", () => {
  it.effect("should ask the Hub again five minutes after an asking fails", () =>
    Effect.gen(function* () {
      const { registry, asked } = yield* answering([unavailable, [first]])

      const value = yield* Effect.gen(function* () {
        yield* Atom.mount(Stats.highlights(yesterday))
        yield* TestWeb.afterTasks

        yield* TestClock.adjust("5 minutes")
        return yield* TestWeb.until(Stats.highlights(yesterday), AsyncResult.isSuccess)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(clipsIn(value), [first])
      assert.strictEqual(yield* Ref.get(asked), 2)
    })
  )

  it.effect("should not ask the Hub again after an asking succeeds", () =>
    Effect.gen(function* () {
      const { registry, asked } = yield* answering([[first], [first, second]])

      yield* Effect.gen(function* () {
        yield* Atom.mount(Stats.highlights(yesterday))
        yield* TestWeb.until(Stats.highlights(yesterday), AsyncResult.isSuccess)

        yield* TestClock.adjust("5 minutes")
        yield* TestWeb.afterTasks
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(yield* Ref.get(asked), 1)
    })
  )
})

const id = GameId.make("401")
const today = { league: "nfl", date: CalendarDate.make("2026-10-16") } as const
const yesterday = { league: "nfl", date: CalendarDate.make("2026-10-15") } as const
const first = highlight()
const second = highlight({ id: HighlightId.make("h2") })
const unavailable = "unavailable" as const

/**
 * A registry whose Hub client answers each highlights asking with the next of `answers` (a failure for "unavailable",
 * then the last answer again), its clock the test's, and how many askings it had.
 */
const answering = Effect.fnUntraced(function* (
  answers: ReadonlyArray<ReadonlyArray<Highlight> | typeof unavailable>
) {
  const asked = yield* Ref.make(0)
  const clock = yield* TestClock.testClockWith(Effect.succeed)
  const hub = yield* TestWeb.liveHub()
  const highlights = () =>
    Ref.getAndUpdate(asked, (count) => count + 1).pipe(
      Effect.flatMap((count) => {
        const answer = answers[Math.min(count, answers.length - 1)] ?? []
        return answer === unavailable ? Effect.fail(new StatsUnavailable()) : Effect.succeed(answer)
      })
    )
  const registry = TestWeb.registryOf(
    Layer.mergeAll(
      Shell.layerTest({ record: () => Effect.void }),
      HubClient.layerTest({ highlights }),
      hub.layer,
      Layer.succeed(Clock.Clock, clock)
    )
  )
  return { registry, asked }
})

function clipsIn(
  result: AsyncResult.AsyncResult<ReadonlyArray<Highlight>, unknown>
): ReadonlyArray<Highlight> {
  return AsyncResult.getOrElse(result, () => [])
}
