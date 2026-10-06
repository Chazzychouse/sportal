import { Clock, Duration, Effect, Layer } from "effect"
import { HubConfig } from "../HubConfig.ts"

/**
 * Scenario time: a clock that starts where the one it replaces is and runs `SPORTAL_SCENARIO_SPEED` times faster, its
 * sleeps shortened to match. The scenario's ingest, the fold, and the Slate run on it, so a scenario plays faster
 * without any of them waiting differently.
 */
export const layer = Layer.effect(
  Clock.Clock,
  Effect.gen(function* () {
    const { scenarioSpeed: speed } = yield* HubConfig
    const real = yield* Clock.Clock
    const startMillis = real.currentTimeMillisUnsafe()
    const startMonotonic = real.monotonicTimeNanosUnsafe()
    const millis = () => startMillis + (real.currentTimeMillisUnsafe() - startMillis) * speed
    const nanos = () => BigInt(Math.round(millis() * 1_000_000))
    const monotonic = () =>
      startMonotonic + BigInt(Math.round(Number(real.monotonicTimeNanosUnsafe() - startMonotonic) * speed))
    return {
      currentTimeMillisUnsafe: millis,
      currentTimeMillis: Effect.sync(millis),
      currentTimeNanosUnsafe: nanos,
      currentTimeNanos: Effect.sync(nanos),
      monotonicTimeNanosUnsafe: monotonic,
      monotonicTimeNanos: Effect.sync(monotonic),
      sleep: (duration) => real.sleep(Duration.millis(Duration.toMillis(duration) / speed))
    } satisfies Clock.Clock
  })
)
