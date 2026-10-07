import { assert, describe, it } from "@effect/vitest"
import { Clock, Context, Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { withEnv } from "../TestHubConfig.ts"
import * as ScenarioClock from "./ScenarioClock.ts"

describe("ScenarioClock", () => {
  it.effect("should start where the clock it replaces is", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute")

      const clock = yield* tenTimesFasterClock

      assert.strictEqual(clock.currentTimeMillisUnsafe(), 60_000)
    }).pipe(Effect.scoped)
  )

  it.effect("should run speed times faster than the clock it replaces", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute")
      const clock = yield* tenTimesFasterClock

      yield* TestClock.adjust("1 second")

      assert.strictEqual(clock.currentTimeMillisUnsafe(), 70_000)
    }).pipe(Effect.scoped)
  )

  it.effect("should not wake a sleeper before its duration has passed in scenario time", () =>
    Effect.gen(function* () {
      const woke = yield* sleepingTenSeconds

      yield* TestClock.adjust(999)

      assert.isFalse(woke())
    }).pipe(Effect.scoped)
  )

  it.effect("should wake a sleeper once its duration has passed in scenario time", () =>
    Effect.gen(function* () {
      const woke = yield* sleepingTenSeconds
      yield* TestClock.adjust(999)

      yield* TestClock.adjust(1)

      assert.isTrue(woke())
    }).pipe(Effect.scoped)
  )
})

const tenTimesFaster = ScenarioClock.layer.pipe(
  Layer.provide(withEnv({ SPORTAL_SCENARIO_SPEED: "10" }).pipe(Layer.orDie))
)

/** The scenario clock at ten times the speed of the clock it replaces, built now. */
const tenTimesFasterClock = Effect.map(Layer.build(tenTimesFaster), (built) =>
  Context.get(built, Clock.Clock)
)

/** Forks a 10 s sleep on the ten-times-faster clock; gives whether it has woken. */
const sleepingTenSeconds = Effect.gen(function* () {
  const clock = yield* tenTimesFasterClock
  let woke = false

  yield* Effect.forkChild(
    clock.sleep(Duration.seconds(10)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          woke = true
        })
      )
    )
  )

  return () => woke
})
