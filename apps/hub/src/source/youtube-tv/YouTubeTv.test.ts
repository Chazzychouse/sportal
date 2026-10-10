import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Ref, Stream } from "effect"
import * as TestYouTubeTv from "./TestYouTubeTv.ts"
import { YouTubeTv } from "./YouTubeTv.ts"

describe("YouTubeTv.layer", () => {
  it.effect("should signal a change after a guide is read", () =>
    Effect.gen(function* () {
      const youTubeTv = yield* YouTubeTv
      const signals = yield* laterGuides.pipe(Stream.take(1), Stream.runCount, Effect.forkChild)
      yield* Effect.yieldNow

      yield* youTubeTv.readGuide(TestYouTubeTv.recordedGuide)

      const signalled = yield* Fiber.join(signals)
      assert.strictEqual(signalled, 1)
    }).pipe(Effect.provide(YouTubeTv.layer))
  )

  it.effect("should keep the guide it has, and signal nothing, when a later response cannot be read", () =>
    Effect.gen(function* () {
      yield* TestYouTubeTv.readRecordedGuide
      const youTubeTv = yield* YouTubeTv
      const before = yield* Stream.runHead(youTubeTv.guide)
      const changes = yield* counted(laterGuides)

      yield* youTubeTv.readGuide("{}").pipe(Effect.flip)
      yield* Effect.yieldNow

      const after = yield* Stream.runHead(youTubeTv.guide)
      const signalled = yield* Ref.get(changes)
      assert.strictEqual(Option.getOrThrow(after), Option.getOrThrow(before))
      assert.strictEqual(signalled, 0)
    }).pipe(Effect.provide(YouTubeTv.layer))
  )

  it.effect.each([
    ["text that is not JSON", "not json"],
    ["JSON that is not a guide", "{}"],
    [
      "a guide without channels",
      JSON.stringify({
        contents: { epgRenderer: { paginationRenderer: { epgPaginationRenderer: { contents: [] } } } }
      })
    ]
  ] as const)("should refuse %s, giving no guide still", ([_name, response]) =>
    Effect.gen(function* () {
      const youTubeTv = yield* YouTubeTv

      const error = yield* youTubeTv.readGuide(response).pipe(Effect.flip)

      const current = yield* Stream.runHead(youTubeTv.guide)
      assert.strictEqual(error._tag, "GuideUnreadable")
      assert.deepStrictEqual(current, Option.some(Option.none()))
    }).pipe(Effect.provide(YouTubeTv.layer))
  )
})

/** Each guide YouTube TV gives after the one it has now: a change. */
const laterGuides = Stream.unwrap(YouTubeTv.use(({ guide }) => Effect.succeed(Stream.drop(guide, 1))))

/** Counts what `stream` emits from now on, in the background. */
function counted<R>(stream: Stream.Stream<unknown, never, R>) {
  return Effect.gen(function* () {
    const count = yield* Ref.make(0)
    yield* stream.pipe(
      Stream.runForEach(() => Ref.update(count, (n) => n + 1)),
      Effect.forkChild
    )
    yield* Effect.yieldNow
    return count
  })
}
