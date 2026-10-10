import { assert, describe, it } from "@effect/vitest"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { type GameSnapshot, Network } from "@sportal/domain/Game"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { GuideReader } from "./GuideReader.ts"
import { Source } from "./Source.ts"
import * as TestYouTubeTv from "./youtube-tv/TestYouTubeTv.ts"

const now = Effect.gen(function* () {
  const source = yield* Source
  const now = yield* DateTime.now

  const latest = yield* Stream.runHead(source.availability)
  const availabilityOf = Option.getOrThrow(latest)
  return (game: GameSnapshot) => availabilityOf(game, now)
})

const youTubeTv = Source.layerYouTubeTv.pipe(Layer.provideMerge(GuideReader.layerYouTubeTv))

// News 3's live address, recorded from YouTube TV's live guide on 2026-10-03.
const cbsLive = "https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D"

const espn = Network.make("ESPN")
const onEspn = snapshot({ broadcasts: [broadcast(espn)] })

const ohioStateAtIowa = snapshot({
  status: "live",
  kickoff: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
  away: { team: team("OSU", "fbs", { name: "Ohio State Buckeyes", location: "Ohio State" }), score: 0 },
  home: { team: team("IOWA", "fbs", { name: "Iowa Hawkeyes", location: "Iowa" }), score: 0 },
  broadcasts: [broadcast("CBS")]
})
const onNews3: ChannelAvailability = {
  _tag: "Carried",
  channel: { name: "News 3", source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } }
}

describe("GuideReader.layerYouTubeTv", () => {
  it.effect("should signal a change after a guide is read", () =>
    Effect.gen(function* () {
      const reader = yield* GuideReader
      const signals = yield* laterGuides.pipe(Stream.take(1), Stream.runCount, Effect.forkChild)
      yield* Effect.yieldNow

      yield* reader.readGuide(TestYouTubeTv.recordedGuide)

      const signalled = yield* Fiber.join(signals)
      assert.strictEqual(signalled, 1)
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should keep its guide 44 minutes after reading it, signalling nothing", () =>
    Effect.gen(function* () {
      yield* TestYouTubeTv.readRecordedGuide
      const changes = yield* counted(laterGuides)

      yield* TestClock.adjust("44 minutes")

      const availabilityOf = yield* now
      const signalled = yield* Ref.get(changes)
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), [onNews3])
      assert.strictEqual(signalled, 0)
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should give no guide once its guide is 45 minutes old, signalling then", () =>
    Effect.gen(function* () {
      yield* TestYouTubeTv.readRecordedGuide
      const changes = yield* counted(laterGuides)
      yield* TestClock.adjust("44 minutes")

      yield* TestClock.adjust("1 minute")

      const availabilityOf = yield* now
      const signalled = yield* Ref.get(changes)
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), [{ _tag: "NoGuide", source: "YouTube TV" }])
      assert.strictEqual(signalled, 1)
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should keep a newer guide when an older one would have gone stale", () =>
    Effect.gen(function* () {
      yield* TestYouTubeTv.readRecordedGuide
      const reader = yield* GuideReader
      yield* TestClock.adjust("30 minutes")
      yield* reader.readGuide(TestYouTubeTv.recordedGuide)

      yield* TestClock.adjust("20 minutes")

      const availabilityOf = yield* now
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), [onNews3])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should not renew freshness when a rejected read arrives near expiry", () =>
    Effect.gen(function* () {
      yield* TestYouTubeTv.readRecordedGuide
      const reader = yield* GuideReader
      yield* TestClock.adjust("44 minutes")

      yield* reader.readGuide("{}").pipe(Effect.flip)
      yield* TestClock.adjust("1 minute")

      const availabilityOf = yield* now
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), [{ _tag: "NoGuide", source: "YouTube TV" }])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should expire the guide surviving overlapping reads exactly once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(TestYouTubeTv.recordedAt)
      const reader = yield* GuideReader

      yield* Effect.forEach([TestYouTubeTv.recordedGuide, TestYouTubeTv.recordedGuide], reader.readGuide, {
        concurrency: "unbounded",
        discard: true
      })
      const changes = yield* counted(laterGuides)
      yield* TestClock.adjust("45 minutes")

      const current = yield* Stream.runHead(reader.guide)
      const signalled = yield* Ref.get(changes)
      assert.deepStrictEqual(current, Option.some(Option.none()))
      assert.strictEqual(signalled, 1)
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should still expire a published guide when its reading fiber is interrupted", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(TestYouTubeTv.recordedAt)
      const reader = yield* GuideReader
      const published = yield* reader.guide.pipe(
        Stream.filter(Option.isSome),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild({ startImmediately: true })
      )

      const reading = yield* reader.readGuide(TestYouTubeTv.recordedGuide).pipe(Effect.forkChild)
      yield* Fiber.join(published)
      yield* Fiber.interrupt(reading)
      yield* TestClock.adjust("45 minutes")

      const current = yield* Stream.runHead(reader.guide)
      assert.deepStrictEqual(current, Option.some(Option.none()))
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should keep the guide it has, and signal nothing, when a later response cannot be read", () =>
    Effect.gen(function* () {
      yield* TestYouTubeTv.readRecordedGuide
      const reader = yield* GuideReader
      const changes = yield* counted(laterGuides)

      yield* reader.readGuide("{}").pipe(Effect.flip)
      yield* Effect.yieldNow

      const availabilityOf = yield* now
      const signalled = yield* Ref.get(changes)
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), [onNews3])
      assert.strictEqual(signalled, 0)
    }).pipe(Effect.provide(youTubeTv))
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
      const reader = yield* GuideReader

      const error = yield* reader.readGuide(response).pipe(Effect.flip)

      const availabilityOf = yield* now
      assert.strictEqual(error._tag, "GuideUnreadable")
      assert.strictEqual(availabilityOf(onEspn)[0]?._tag, "NoGuide")
    }).pipe(Effect.provide(youTubeTv))
  )
})

/** Each guide the reader gives after the one it has now: a change. */
const laterGuides = Stream.unwrap(GuideReader.use(({ guide }) => Effect.succeed(Stream.drop(guide, 1))))

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
