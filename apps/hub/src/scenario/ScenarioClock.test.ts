import { assert, describe, it } from "@effect/vitest"
import { Clock, Context, Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { withEnv } from "../TestHubConfig.ts"
import * as ScenarioClock from "./ScenarioClock.ts"

describe("ScenarioClock", () => {
  it.effect("starts where the clock it replaces is and runs speed times faster", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute")
      const clock = Context.get(yield* Layer.build(tenTimesFaster), Clock.Clock)
      assert.strictEqual(clock.currentTimeMillisUnsafe(), 60_000)
      yield* TestClock.adjust("1 second")
      assert.strictEqual(clock.currentTimeMillisUnsafe(), 70_000)
    }).pipe(Effect.scoped)
  )

  it.effect("wakes a sleeper once its duration has passed in scenario time", () =>
    Effect.gen(function* () {
      const clock = Context.get(yield* Layer.build(tenTimesFaster), Clock.Clock)
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
      yield* TestClock.adjust(999)
      assert.isFalse(woke)
      yield* TestClock.adjust(1)
      assert.isTrue(woke)
    }).pipe(Effect.scoped)
  )
})

const tenTimesFaster = ScenarioClock.layer.pipe(
  Layer.provide(withEnv({ SPORTAL_SCENARIO_SPEED: "10" }).pipe(Layer.orDie))
)
