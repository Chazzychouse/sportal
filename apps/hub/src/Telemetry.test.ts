import { NodePath } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Logger, Metric, Ref, References, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { HubConfig } from "./HubConfig.ts"
import * as Telemetry from "./Telemetry.ts"

describe("Telemetry", () => {
  it.effect("exports nothing without SPORTAL_OTLP_URL", () =>
    Effect.gen(function* () {
      const requests = yield* exported({}, Effect.logInfo("hello").pipe(Effect.withSpan("test.span")))
      assert.deepStrictEqual(requests, [])
    })
  )

  it.effect("keeps the level as today", () => {
    const unused = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Telemetry made a request with no SPORTAL_OTLP_URL"))
    )
    return Effect.gen(function* () {
      assert.strictEqual(yield* References.MinimumLogLevel, "Warn")
    }).pipe(
      Effect.provide(Telemetry.layer.pipe(Layer.provide([withEnv({ SPORTAL_LOG_LEVEL: "Warn" }), unused])))
    )
  })

  it.effect("sends spans, logs, and metrics below the base URL", () =>
    Effect.gen(function* () {
      const requests = yield* exported(
        { SPORTAL_OTLP_URL: "http://collector:4318" },
        Effect.gen(function* () {
          yield* Effect.logInfo("hello").pipe(Effect.withSpan("test.span"))
          yield* Metric.update(Metric.counter("test_counter"), 1)
        })
      )
      const urls = new Set(requests.map(({ url }) => url))
      assert.deepStrictEqual(
        urls,
        new Set([
          "http://collector:4318/v1/traces",
          "http://collector:4318/v1/logs",
          "http://collector:4318/v1/metrics"
        ])
      )
      const traces = yield* bodiesTo(requests, "/v1/traces", TraceBody)
      assert.include(
        traces.flatMap(({ resourceSpans }) =>
          resourceSpans.flatMap(({ scopeSpans }) =>
            scopeSpans.flatMap(({ spans }) => spans.map(({ name }) => name))
          )
        ),
        "test.span"
      )
      const logs = yield* bodiesTo(requests, "/v1/logs", LogBody)
      assert.include(
        logs.flatMap(({ resourceLogs }) =>
          resourceLogs.flatMap(({ scopeLogs }) =>
            scopeLogs.flatMap(({ logRecords }) => logRecords.map(({ body }) => body.stringValue))
          )
        ),
        "hello"
      )
    })
  )

  it.effect("names the Hub and its mode in the resource", () =>
    Effect.gen(function* () {
      const resource = (env: Record<string, string>) =>
        Effect.gen(function* () {
          const requests = yield* exported(
            { SPORTAL_OTLP_URL: "http://collector:4318", SPORTAL_VERSION: "1.2.3", ...env },
            Effect.void.pipe(Effect.withSpan("test.span"))
          )
          const [trace] = yield* bodiesTo(requests, "/v1/traces", TraceBody)
          return new Map(
            (trace?.resourceSpans[0]?.resource.attributes ?? []).map(({ key, value }) => [
              key,
              value.stringValue
            ])
          )
        })

      const live = yield* resource({})
      assert.strictEqual(live.get("service.name"), "sportal-hub")
      assert.strictEqual(live.get("service.version"), "1.2.3")
      assert.strictEqual(live.get("sportal.mode"), "live")

      const scenario = yield* resource({ SPORTAL_SCENARIO: "two-minute-drill-tie" })
      assert.strictEqual(scenario.get("sportal.mode"), "scenario:two-minute-drill-tie")
    })
  )

  it.effect("warns once when the collector cannot be reached", () =>
    Effect.gen(function* () {
      const logged: Array<{ readonly level: string; readonly message: string }> = []
      const recorder = Logger.make(({ logLevel, message }) => {
        logged.push({ level: logLevel, message: JSON.stringify(message) })
      })
      const unreachable = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "connection refused" })
            })
          )
        )
      )
      const telemetry = Telemetry.layer.pipe(
        Layer.provide([
          withEnv({ SPORTAL_OTLP_URL: "http://collector:4318" }),
          unreachable,
          Logger.layer([recorder], { mergeWithExisting: true })
        ])
      )

      yield* Effect.forEach(
        Arr.range(1, 130),
        () => Effect.void.pipe(Effect.withSpan("test.span"), Effect.andThen(TestClock.adjust("1 second"))),
        { discard: true }
      ).pipe(Effect.provide(telemetry))

      const warnings = logged.filter(({ level }) => level === "Warn")
      assert.strictEqual(warnings.length, 1)
      assert.include(warnings[0]?.message, "http://collector:4318/")
    })
  )
})

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
      const context = yield* Layer.build(Telemetry.layer.pipe(Layer.provide([withEnv(env), collector])))
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

/** HubConfig read from exactly these variables and a HOME, and nothing from the machine running the test. */
function withEnv(env: Record<string, string>) {
  return HubConfig.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: "/home/fan", ...env } })),
        NodePath.layer
      )
    )
  )
}
