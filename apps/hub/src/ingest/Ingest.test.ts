import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "@sportal/domain/Game"
import { snapshot, team } from "@sportal/domain/TestGame"
import { Effect, type Exit, Layer, Metric, Option, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { Provider, ProviderError } from "../provider/Provider.ts"
import { Ingest } from "./Ingest.ts"

function liveGame(homeScore: number) {
  return snapshot({
    status: "live",
    period: 1,
    clock: "10:00",
    home: { team: team("MSST"), score: homeScore },
    away: { team: team("ALA"), score: 0 }
  })
}

/** A provider that answers each poll with the next scripted response. */
function scripted(responses: ReadonlyArray<ReadonlyArray<GameSnapshot> | "fail">) {
  let call = 0
  return Layer.succeed(
    Provider,
    Provider.of({
      slate: (league) => {
        const response = responses[Math.min(call++, responses.length - 1)]
        return (
          response === "fail" || response === undefined
            ? Effect.fail(new ProviderError({ league, cause: "down" }))
            : Effect.succeed(response)
        ).pipe(Effect.withSpan("provider.slate"))
      }
    })
  )
}

describe("Ingest", () => {
  it.effect("polls again after the live cadence and publishes the new slate", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      yield* TestClock.adjust(0)
      assert.strictEqual((yield* ingest.slate)[0]?.home.score, 0)

      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* ingest.slate)[0]?.home.score, 7)
    }).pipe(
      Effect.provide(Ingest.layer(["fbs"]).pipe(Layer.provide(scripted([[liveGame(0)], [liveGame(7)]]))))
    )
  )

  it.effect("keeps the last slate when the provider fails", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* ingest.slate)[0]?.home.score, 7)
    }).pipe(Effect.provide(Ingest.layer(["fbs"]).pipe(Layer.provide(scripted([[liveGame(7)], "fail"])))))
  )

  it.effect("retries after 30 seconds when the first poll fails", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      yield* TestClock.adjust(0)
      assert.strictEqual((yield* ingest.slate).length, 0)

      yield* TestClock.adjust("30 seconds")
      assert.strictEqual((yield* ingest.slate)[0]?.home.score, 3)
    }).pipe(Effect.provide(Ingest.layer(["fbs"]).pipe(Layer.provide(scripted(["fail", [liveGame(3)]])))))
  )

  it.effect("a poll is one span with the provider's span inside it", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* Ingest
      yield* TestClock.adjust(0)
      const polls = ended.filter((span) => span.name === "Ingest.poll")
      assert.strictEqual(polls.length, 1)
      const poll = polls[0]
      const slate = ended.find((span) => span.name === "provider.slate")
      assert.strictEqual(
        slate?.parent.pipe(
          Option.map((parent) => parent.spanId),
          Option.getOrUndefined
        ),
        poll?.spanId
      )
      assert.deepStrictEqual(poll?.attributes.get("sportal.leagues"), ["fbs"])
      assert.deepStrictEqual(poll?.attributes.get("sportal.failed_leagues"), [])
    }).pipe(Effect.provide(polling(scripted([[liveGame(0)]]), ended)))
  })

  it.effect("the span ends before the poll sleeps", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* Ingest
      yield* TestClock.adjust(0)
      assert.isTrue(ended.some((span) => span.name === "Ingest.poll"))
    }).pipe(Effect.provide(polling(scripted([[liveGame(0)]]), ended)))
  })

  it.effect("a failed league is on the span and counted", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* Ingest
      yield* TestClock.adjust(0)
      const poll = ended.find((span) => span.name === "Ingest.poll")
      assert.deepStrictEqual(poll?.attributes.get("sportal.failed_leagues"), ["fbs"])
      const errors = (yield* Metric.snapshot).find(
        (metric) => metric.id === "sportal_provider_errors" && metric.attributes?.league === "fbs"
      )
      assert.deepStrictEqual(errors?.type === "Counter" ? errors.state.count : undefined, 1)
    }).pipe(
      Effect.provide(polling(scripted(["fail"]), ended)),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )
  })

  it.effect("each poll records its duration", () =>
    Effect.gen(function* () {
      yield* Ingest
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")
      const duration = (yield* Metric.snapshot).find((metric) => metric.id === "sportal_poll_duration")
      assert.strictEqual(duration?.type === "Histogram" ? duration.state.count : undefined, 2)
    }).pipe(
      Effect.provide(polling(scripted([[liveGame(0)], [liveGame(7)]]), [])),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )
  )
})

/** Ingest of the fbs league over `provider`, with each span that ends recorded in `ended`. */
function polling(provider: Layer.Layer<Provider>, ended: Array<Tracer.Span>) {
  class RecordedSpan extends Tracer.NativeSpan {
    override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
      super.end(endTime, exit)
      ended.push(this)
    }
  }
  return Ingest.layer(["fbs"]).pipe(
    Layer.provide(provider),
    Layer.provideMerge(
      Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new RecordedSpan(options) }))
    )
  )
}
