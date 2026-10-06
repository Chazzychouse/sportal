import { Cause, Effect, type Exit, Layer, Logger, Metric, References, Tracer } from "effect"

/**
 * A logger for a test that records every message it is given, with its level, annotations, and cause (pretty-printed,
 * empty when there is none), beside the default one. `layer` installs it.
 */
export function recordingLogs() {
  const logs: Array<{
    readonly level: string
    readonly message: string
    readonly annotations: Readonly<Record<string, unknown>>
    readonly cause: string
  }> = []
  const recorder = Logger.make(({ logLevel, message, fiber, cause }) => {
    logs.push({
      level: logLevel,
      message: JSON.stringify(message),
      annotations: fiber.getRef(References.CurrentLogAnnotations),
      cause: Cause.pretty(cause)
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

/** The count of counter `id` with `attributes` among its others, if it has counted. */
export function counted(id: string, attributes: Readonly<Record<string, string>> = {}) {
  return Effect.map(Metric.snapshot, (metrics) => {
    const metric = metrics.find(
      (candidate) => candidate.id === id && matches(candidate.attributes, attributes)
    )
    return metric?.type === "Counter" ? metric.state.count : undefined
  })
}

/** The value of gauge `id` with `attributes` among its others, if it has been set. */
export function gauged(id: string, attributes: Readonly<Record<string, string>> = {}) {
  return Effect.map(Metric.snapshot, (metrics) => {
    const metric = metrics.find(
      (candidate) => candidate.id === id && matches(candidate.attributes, attributes)
    )
    return metric?.type === "Gauge" ? metric.state.value : undefined
  })
}

function matches(
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>
) {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value)
}
