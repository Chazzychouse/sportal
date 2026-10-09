import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { Network } from "@sportal/domain/Game"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Fiber, Layer, Logger, Option, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { GuideReader } from "./GuideReader.ts"
import { Source } from "./Source.ts"
import { readRecordedGuide, recordedAt, recordedGuide } from "./youtube-tv/TestYouTubeTv.ts"

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
const onNews3 = ChannelAvailability.Carried({
  channel: { name: "News 3", source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } }
})

describe("GuideReader.layerYouTubeTv", () => {
  it.effect("should read the recorded guide's channels, live addresses, and airings", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recordedAt)
      const source = yield* Source
      const reader = yield* GuideReader

      yield* reader.readGuide(recordedGuide)

      const availabilityOf = yield* source.availability
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), onNews3)
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should signal a change after a guide is read", () =>
    Effect.gen(function* () {
      const reader = yield* GuideReader
      const signals = yield* reader.changes.pipe(Stream.take(1), Stream.runCount, Effect.forkChild)
      yield* Effect.yieldNow

      yield* reader.readGuide(recordedGuide)

      const signalled = yield* Fiber.join(signals)
      assert.strictEqual(signalled, 1)
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should keep its guide 44 minutes after reading it, signalling nothing", () =>
    Effect.gen(function* () {
      const source = yield* guideReadAtRecording()
      const reader = yield* GuideReader
      const changes = yield* counted(reader.changes)

      yield* TestClock.adjust("44 minutes")

      const availabilityOf = yield* source.availability
      const signalled = yield* Ref.get(changes)
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), onNews3)
      assert.strictEqual(signalled, 0)
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should answer no guide once its guide is 45 minutes old, signalling then", () =>
    Effect.gen(function* () {
      const source = yield* guideReadAtRecording()
      const reader = yield* GuideReader
      const changes = yield* counted(reader.changes)
      yield* TestClock.adjust("44 minutes")

      yield* TestClock.adjust("1 minute")

      const availabilityOf = yield* source.availability
      const signalled = yield* Ref.get(changes)
      assert.deepStrictEqual(
        availabilityOf(ohioStateAtIowa),
        ChannelAvailability.NoGuide({ source: "YouTube TV" })
      )
      assert.strictEqual(signalled, 1)
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should keep a newer guide when an older one would have gone stale", () =>
    Effect.gen(function* () {
      const source = yield* guideReadAtRecording()
      const reader = yield* GuideReader
      yield* TestClock.adjust("30 minutes")
      yield* reader.readGuide(recordedGuide)

      yield* TestClock.adjust("20 minutes")

      const availabilityOf = yield* source.availability
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), onNews3)
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should keep the guide it has, and signal nothing, when a later response cannot be read", () =>
    Effect.gen(function* () {
      const source = yield* guideReadAtRecording()
      const reader = yield* GuideReader
      const changes = yield* counted(reader.changes)

      yield* reader.readGuide("{}").pipe(Effect.flip)
      yield* Effect.yieldNow

      const availabilityOf = yield* source.availability
      const signalled = yield* Ref.get(changes)
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), onNews3)
      assert.strictEqual(signalled, 0)
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should leave a channel without a live address when its row's live id is not one", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recordedAt)
      const source = yield* Source
      const reader = yield* GuideReader

      yield* reader.readGuide(oneRowGuide("y6zFA17zDsw?x"))

      const availabilityOf = yield* source.availability
      assert.deepStrictEqual(
        availabilityOf(ohioStateAtIowa),
        ChannelAvailability.Upcoming({
          channel: Option.some("News 3"),
          begin: Option.some(DateTime.makeUnsafe("2026-10-03T19:35:00Z"))
        })
      )
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should log why a response could not be read, without the response", () =>
    Effect.gen(function* () {
      const logged: Array<{ readonly level: string; readonly message: string }> = []
      const collector = Logger.make(({ logLevel, message }) => {
        logged.push({ level: logLevel, message: JSON.stringify(message) })
      })
      const response = JSON.stringify({ contents: { secret: "payload" } })

      yield* GuideReader.use((reader) => Effect.flip(reader.readGuide(response))).pipe(
        Effect.provide(Layer.merge(youTubeTv, Logger.layer([collector])))
      )

      const warnings = logged.filter(({ level }) => level === "Warn")
      assert.strictEqual(warnings.length, 1)
      assert.include(warnings[0]?.message, "epgRenderer")
      assert.notInclude(warnings[0]?.message, "secret")
    })
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
  ] as const)("should refuse %s, answering no guide still", ([_name, response]) =>
    Effect.gen(function* () {
      const source = yield* Source
      const reader = yield* GuideReader

      const error = yield* reader.readGuide(response).pipe(Effect.flip)

      const availabilityOf = yield* source.availability
      assert.strictEqual(error._tag, "GuideUnreadable")
      assert.strictEqual(availabilityOf(onEspn)._tag, "NoGuide")
    }).pipe(Effect.provide(youTubeTv))
  )
})

/** The source once its reader has read the recorded guide, on the test clock at the moment it was recorded. */
function guideReadAtRecording() {
  return Effect.gen(function* () {
    yield* readRecordedGuide
    return yield* Source
  })
}

/** Counts what `stream` emits from now on, in the background. */
function counted(stream: Stream.Stream<void>) {
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

/** A guide response with one row, News 3 airing Ohio State at Iowa, whose live id is `videoId`. */
function oneRowGuide(videoId: string) {
  const row = {
    station: {
      epgStationRenderer: {
        stationId: "UCPc5PkgTSfcJCi3-dJyg3Tg",
        icon: { accessibility: { accessibilityData: { label: "News 3" } } }
      }
    },
    navigationEndpoint: { watchEndpoint: { videoId } },
    airings: [
      {
        epgAiringRenderer: {
          beginTimeMs: String(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T19:35:00Z"))),
          endTimeMs: String(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T23:00:00Z"))),
          title: { runs: [{ text: "Ohio State at Iowa" }] }
        }
      }
    ]
  }
  return JSON.stringify({
    contents: {
      epgRenderer: { paginationRenderer: { epgPaginationRenderer: { contents: [{ epgRowRenderer: row }] } } }
    }
  })
}
