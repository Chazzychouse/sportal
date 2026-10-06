import { Effect, type Exit, Layer, Logger, Metric, References, Tracer } from "effect"

/**
 * A logger for a test that records every message it is given, with its level and annotations, beside the default
 * one. `layer` installs it.
 */
export function recordingLogs() {
  const logs: Array<{
    readonly level: string
    readonly message: string
    readonly annotations: Readonly<Record<string, unknown>>
  }> = []
  const recorder = Logger.make(({ logLevel, message, fiber }) => {
    logs.push({
      level: logLevel,
      message: JSON.stringify(message),
      annotations: fiber.getRef(References.CurrentLogAnnotations)
    })
  })
  return { logs, layer: Logger.layer([recorder], { mergeWithExisting: true }) }
}

/** A tracer for a test that records each span in `ended` as it ends. */
export function recordingSpans(ended: Array<Tracer.Span>) {
  class RecordedSpan extends Tracer.NativeSpan {
    override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
      super.end(endTime, exit)
      ended.push(this)
    }
  }
  return Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new RecordedSpan(options) }))
}

/** Runs `effect` with a metric registry of its own, so every metric starts from nothing. */
export function withMetrics<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.provideService(effect, Metric.MetricRegistry, new Map())
}

/** A counter's count in the test's registry, for the series whose attributes include `attributes`. */
export function counted(id: string, attributes: Record<string, string> = {}) {
  return Effect.map(Metric.snapshot, (metrics) => {
    const metric = metrics.find(
      (candidate) => candidate.id === id && matches(candidate.attributes, attributes)
    )
    return metric?.type === "Counter" ? metric.state.count : undefined
  })
}

/** A gauge's value in the test's registry, for the series whose attributes include `attributes`. */
export function gauged(id: string, attributes: Record<string, string> = {}) {
  return Effect.map(Metric.snapshot, (metrics) => {
    const metric = metrics.find(
      (candidate) => candidate.id === id && matches(candidate.attributes, attributes)
    )
    return metric?.type === "Gauge" ? metric.state.value : undefined
  })
}

function matches(actual: Readonly<Record<string, string>> | undefined, expected: Record<string, string>) {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value)
}
