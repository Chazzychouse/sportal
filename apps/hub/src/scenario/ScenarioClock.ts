import { Clock, Duration, Effect, Layer } from "effect"

/**
 * Scenario time: a clock that starts where the one it replaces is and runs `speed` times faster, its sleeps
 * shortened to match. Ingest and the Scenario provider run on it, so a scenario plays faster without either
 * one waiting differently.
 */
export const layer = (speed: number) =>
  Layer.effect(
    Clock.Clock,
    Effect.gen(function* () {
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
