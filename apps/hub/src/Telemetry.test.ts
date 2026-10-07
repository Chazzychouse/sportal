import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Metric, Ref, References, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { TestClock, TestConsole } from "effect/testing"
import * as Telemetry from "./Telemetry.ts"
import { withEnv } from "./TestHubConfig.ts"
import { recordingLogs } from "./TestTelemetry.ts"

describe("Telemetry", () => {
  it.effect("should export nothing without SPORTAL_OTLP_URL", () =>
    Effect.gen(function* () {
      const work = Effect.logInfo("hello").pipe(Effect.withSpan("test.span"))

      const requests = yield* exported({}, work)

      assert.deepStrictEqual(requests, [])
    })
  )

  it.effect("should set the minimum level from SPORTAL_LOG_LEVEL", () =>
    Effect.gen(function* () {
      const minimum = yield* References.MinimumLogLevel

      assert.strictEqual(minimum, "Warn")
    }).pipe(Effect.provide(telemetryWithoutCollector({ SPORTAL_LOG_LEVEL: "Warn" })))
  )

  it.effect("should send spans, logs, and metrics below the base URL", () =>
    Effect.gen(function* () {
      const work = Effect.gen(function* () {
        yield* Effect.logInfo("hello").pipe(Effect.withSpan("test.span"))
        yield* Metric.update(Metric.counter("test_counter"), 1)
      })

      const requests = yield* exported({ SPORTAL_OTLP_URL: "http://collector:4318" }, work)

      const urls = new Set(requests.map(({ url }) => url))
      const spans = yield* spanNames(requests)
      const messages = yield* loggedMessages(requests)
      assert.deepStrictEqual(
        urls,
        new Set([
          "http://collector:4318/v1/traces",
          "http://collector:4318/v1/logs",
          "http://collector:4318/v1/metrics"
        ])
      )
      assert.include(spans, "test.span")
      assert.include(messages, "hello")
    })
  )

  it.effect("should write JSON lines to the console while it exports logs", () =>
    Effect.gen(function* () {
      const lines = yield* Ref.make<ReadonlyArray<unknown>>([])
      const work = Effect.gen(function* () {
        yield* Effect.logInfo("hello")
        const logged = yield* TestConsole.logLines
        yield* Ref.set(lines, logged)
      }).pipe(Effect.provide(TestConsole.layer))

      const requests = yield* exported(
        { SPORTAL_OTLP_URL: "http://collector:4318", SPORTAL_LOG_FORMAT: "json" },
        work
      )

      const messages = yield* loggedMessages(requests)
      const written = yield* Ref.get(lines)
      const writtenMessages = yield* jsonMessages(written)
      assert.include(messages, "hello")
      assert.deepStrictEqual(writtenMessages, ["hello"])
    })
  )

  it.effect("should name the Hub, its version, and the live mode in the resource", () =>
    Effect.gen(function* () {
      const resource = yield* resourceOf({})

      assert.strictEqual(resource.get("service.name"), "sportal-hub")
      assert.strictEqual(resource.get("service.version"), "1.2.3")
      assert.strictEqual(resource.get("sportal.mode"), "live")
    })
  )

  it.effect("should name a scenario's mode in the resource", () =>
    Effect.gen(function* () {
      const resource = yield* resourceOf({ SPORTAL_SCENARIO: "two-minute-drill-tie" })

      assert.strictEqual(resource.get("sportal.mode"), "scenario:two-minute-drill-tie")
    })
  )

  it.effect("should name this process in the resource, a new instance each time the Hub starts", () =>
    Effect.gen(function* () {
      const live = yield* resourceOf({})
      const instance = live.get("service.instance.id")

      const scenario = yield* resourceOf({ SPORTAL_SCENARIO: "two-minute-drill-tie" })

      assert.isNotEmpty(instance)
      assert.notStrictEqual(scenario.get("service.instance.id"), instance)
    })
  )

  it.effect("should warn once when the collector cannot be reached", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const telemetry = Telemetry.layer.pipe(
        Layer.provide([
          withEnv({ SPORTAL_OTLP_URL: "http://collector:4318" }),
          unreachableCollector(),
          NodeCrypto.layer,
          layer
        ])
      )

      yield* spannedEverySecond(130).pipe(Effect.provide(telemetry))

      const warnings = logs.filter(({ level }) => level === "Warn")
      assert.strictEqual(warnings.length, 1)
      assert.include(warnings[0]?.message, "http://collector:4318/")
    })
  )
})

/** Telemetry configured from `env`, with a client that dies if Telemetry makes a request. */
function telemetryWithoutCollector(env: Record<string, string>) {
  const unused = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Telemetry made a request with no SPORTAL_OTLP_URL"))
  )
  return Telemetry.layer.pipe(Layer.provide([withEnv(env), unused, NodeCrypto.layer]))
}

/** A collector whose every request fails as connection refused. */
function unreachableCollector() {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection refused" })
        })
      )
    )
  )
}

/** A span a second for `seconds` seconds of the test clock. */
function spannedEverySecond(seconds: number) {
  return Effect.forEach(
    Arr.range(1, seconds),
    () => Effect.void.pipe(Effect.withSpan("test.span"), Effect.andThen(TestClock.adjust("1 second"))),
    { discard: true }
  )
}

/** The resource attributes of the first trace exported by a Hub at version 1.2.3 configured from `env`, by key. */
function resourceOf(env: Record<string, string>) {
  return Effect.gen(function* () {
    const requests = yield* exported(
      { SPORTAL_OTLP_URL: "http://collector:4318", SPORTAL_VERSION: "1.2.3", ...env },
      Effect.void.pipe(Effect.withSpan("test.span"))
    )
    const [trace] = yield* bodiesTo(requests, "/v1/traces", TraceBody)
    const attributes = trace?.resourceSpans[0]?.resource.attributes ?? []
    return new Map(attributes.map(({ key, value }) => [key, value.stringValue]))
  })
}

/** The name of each span sent to the collector. */
function spanNames(requests: ReadonlyArray<{ readonly url: string; readonly body: unknown }>) {
  return Effect.map(bodiesTo(requests, "/v1/traces", TraceBody), (traces) =>
    traces.flatMap(({ resourceSpans }) =>
      resourceSpans.flatMap(({ scopeSpans }) =>
        scopeSpans.flatMap(({ spans }) => spans.map(({ name }) => name))
      )
    )
  )
}

/** The message of each JSON line written to the console. */
function jsonMessages(lines: ReadonlyArray<unknown>) {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ message: Schema.Unknown })))
  return Effect.forEach(lines, (line) => Effect.map(decode(line), ({ message }) => message))
}

/**
 * Runs `work` under Telemetry configured from `env`, with a collector that accepts everything, then closes
 * Telemetry so the exporters flush, and returns each request the collector received.
 */
function exported<A, E>(env: Record<string, string>, work: Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<{ readonly url: string; readonly body: unknown }>>([])
    const collector = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "null"
          yield* Ref.update(requests, (all) => [...all, { url: request.url, body: JSON.parse(body) }])
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))
        })
      )
    )
    yield* Effect.gen(function* () {
      const context = yield* Layer.build(
        Telemetry.layer.pipe(Layer.provide([withEnv(env), collector, NodeCrypto.layer]))
      )
      yield* work.pipe(Effect.provideContext(context))
    }).pipe(Effect.scoped)
    return yield* Ref.get(requests)
  })
}

/** The bodies sent to `path`, decoded as `schema`. */
function bodiesTo<A>(
  requests: ReadonlyArray<{ readonly url: string; readonly body: unknown }>,
  path: string,
  schema: Schema.Decoder<A>
) {
  return Effect.forEach(
    requests.filter(({ url }) => url.endsWith(path)),
    ({ body }) => Schema.decodeUnknownEffect(schema)(body)
  )
}

/** The message of each log record sent to the collector. */
function loggedMessages(requests: ReadonlyArray<{ readonly url: string; readonly body: unknown }>) {
  return Effect.map(bodiesTo(requests, "/v1/logs", LogBody), (logs) =>
    logs.flatMap(({ resourceLogs }) =>
      resourceLogs.flatMap(({ scopeLogs }) =>
        scopeLogs.flatMap(({ logRecords }) => logRecords.map(({ body }) => body.stringValue))
      )
    )
  )
}

const TraceBody = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      resource: Schema.Struct({
        attributes: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            value: Schema.Struct({ stringValue: Schema.optional(Schema.String) })
          })
        )
      }),
      scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(Schema.Struct({ name: Schema.String })) }))
    })
  )
})

const LogBody = Schema.Struct({
  resourceLogs: Schema.Array(
    Schema.Struct({
      scopeLogs: Schema.Array(
        Schema.Struct({
          logRecords: Schema.Array(
            Schema.Struct({ body: Schema.Struct({ stringValue: Schema.optional(Schema.String) }) })
          )
        })
      )
    })
  )
})
