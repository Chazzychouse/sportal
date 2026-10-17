import { assert, describe, it } from "@effect/vitest"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { Network } from "@sportal/domain/Game"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { HubConfig } from "../HubConfig.ts"
import * as TestHub from "../TestHub.ts"
import { Source } from "./Source.ts"

const config = HubConfig.layerTest({ SPORTAL_LINEUP_CHANNELS: "News 3" })
const youTubeTv = Source.layerYouTubeTv.pipe(Layer.provide(config))
const youTubeTvAndTwitch = Source.layerAll([Source.layerYouTubeTv, Source.layerTwitch]).pipe(
  Layer.provide(config)
)

const espn = Network.make("ESPN")
const onEspn = snapshot({ broadcasts: [broadcast(espn)] })

describe("Source.layerYouTubeTv", () => {
  it.effect("should give no guide before any guide is read", () =>
    Effect.gen(function* () {
      const availabilityOf = yield* TestHub.availabilityNow

      assert.deepStrictEqual(availabilityOf(onEspn), [{ _tag: "NoGuide", source: "YouTube TV" }])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should give streaming only for a Prime Video game the guide does not list", () =>
    Effect.gen(function* () {
      yield* TestHub.readRecordedGuide
      const availabilityOf = yield* TestHub.availabilityNow

      assert.deepStrictEqual(availabilityOf(primeVideoSoonAfterRecording), [
        { _tag: "NotCarried", why: "StreamingOnly" }
      ])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should keep the guide it has when a later response cannot be read", () =>
    Effect.gen(function* () {
      yield* TestHub.readRecordedGuide

      yield* Source.use((source) => source.readGuide("{}")).pipe(Effect.flip)

      const availabilityOf = yield* TestHub.availabilityNow
      assert.deepStrictEqual(availabilityOf(TestHub.ohioStateAtIowa), [TestHub.onNews3])
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
      const error = yield* Source.use((source) => source.readGuide(response)).pipe(Effect.flip)

      const availabilityOf = yield* TestHub.availabilityNow
      assert.strictEqual(error._tag, "GuideUnreadable")
      assert.deepStrictEqual(availabilityOf(onEspn), [{ _tag: "NoGuide", source: "YouTube TV" }])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should carry from a guide 44 minutes after reading it", () =>
    Effect.gen(function* () {
      yield* TestHub.readRecordedGuide

      yield* TestClock.adjust("44 minutes")

      const availabilityOf = yield* TestHub.availabilityNow
      assert.deepStrictEqual(availabilityOf(TestHub.ohioStateAtIowa), [TestHub.onNews3])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should give no guide once its guide is 45 minutes old", () =>
    Effect.gen(function* () {
      yield* TestHub.readRecordedGuide

      yield* TestClock.adjust("45 minutes")

      const availabilityOf = yield* TestHub.availabilityNow
      assert.deepStrictEqual(availabilityOf(TestHub.ohioStateAtIowa), [
        { _tag: "NoGuide", source: "YouTube TV" }
      ])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should carry from a newer guide when an older one would have gone stale", () =>
    Effect.gen(function* () {
      yield* TestHub.readRecordedGuide
      yield* TestClock.adjust("30 minutes")
      yield* Source.use((source) => source.readGuide(TestHub.recordedGuide))

      yield* TestClock.adjust("20 minutes")

      const availabilityOf = yield* TestHub.availabilityNow
      assert.deepStrictEqual(availabilityOf(TestHub.ohioStateAtIowa), [TestHub.onNews3])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should give an empty lineup before any guide is read", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const lineupAt = yield* Source.use((source) => source.lineup)

      assert.deepStrictEqual(lineupAt(now), [])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should give the recorded guide's sports channels, and the channel the setting names", () =>
    Effect.gen(function* () {
      yield* TestHub.readRecordedGuide
      const now = yield* DateTime.now
      const lineupAt = yield* Source.use((source) => source.lineup)

      const names = lineupAt(now).map(({ channel }) => channel.name)

      assert.include(names, "ESPN")
      assert.include(names, "News 3")
      assert.notInclude(names, "HGTV")
      assert.notInclude(names, "Dabl")
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should give an empty lineup once its guide is 45 minutes old", () =>
    Effect.gen(function* () {
      yield* TestHub.readRecordedGuide
      yield* TestClock.adjust("45 minutes")
      const now = yield* DateTime.now
      const lineupAt = yield* Source.use((source) => source.lineup)

      assert.deepStrictEqual(lineupAt(now), [])
    }).pipe(Effect.provide(youTubeTv))
  )
})

const thursdayStart = DateTime.makeUnsafe("2026-10-09T00:15:00Z")
const thursdayNight = primeVideoGame(thursdayStart)
const thursdayNightStarted = snapshot({ ...thursdayNight, status: "live" })
// A Prime Video game whose teams the recorded guide does not list, starting 20 minutes after it was read.
const primeVideoSoonAfterRecording = primeVideoGame(
  DateTime.add(DateTime.makeUnsafe(TestHub.recordedAt), { minutes: 20 })
)
const onPrimeVideo: ChannelAvailability = {
  _tag: "Carried",
  channel: {
    name: "Prime Video",
    source: "Twitch",
    locator: {
      _tag: "WebView",
      url: "https://player.twitch.tv/?channel=primevideo&parent=twitch.tv&player=popout"
    }
  }
}

describe("Source.layerTwitch", () => {
  it.effect("should carry a Prime Video game on primevideo once it has started", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(thursdayStart))

      const availabilityOf = yield* TestHub.availabilityNow

      assert.deepStrictEqual(availabilityOf(thursdayNightStarted), [onPrimeVideo])
    }).pipe(Effect.provide(Source.layerTwitch))
  )

  it.effect("should give Prime Video in its lineup", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const lineupAt = yield* Source.use((source) => source.lineup)

      assert.deepStrictEqual(
        lineupAt(now).map(({ channel }) => channel.name),
        ["Prime Video"]
      )
    }).pipe(Effect.provide(Source.layerTwitch))
  )
})

describe("Source.layerAll", () => {
  const carried = (source: "YouTube TV" | "Twitch"): ChannelAvailability => ({
    _tag: "Carried",
    channel: { name: source, source, locator: { _tag: "WebView", url: `https://example.test/${source}` } }
  })
  const streamingOnly: ChannelAvailability = { _tag: "NotCarried", why: "StreamingOnly" }

  it.effect("should give every source's availability, in the order given", () =>
    Effect.gen(function* () {
      const all = Source.layerAll([
        Source.layerTest(() => streamingOnly),
        Source.layerTest(() => carried("Twitch"))
      ])

      const availabilityOf = yield* TestHub.availabilityNow.pipe(Effect.provide(all))

      assert.deepStrictEqual(availabilityOf(thursdayNight), [streamingOnly, carried("Twitch")])
    })
  )

  it.effect(
    "should give no guide from YouTube TV and carried from Twitch for Thursday's Prime Video game once it has started",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(thursdayStart, { minutes: 10 })))

        const availabilityOf = yield* TestHub.availabilityNow

        assert.deepStrictEqual(availabilityOf(thursdayNightStarted), [
          { _tag: "NoGuide", source: "YouTube TV" },
          onPrimeVideo
        ])
      }).pipe(Effect.provide(youTubeTvAndTwitch))
  )

  it.effect(
    "should give YouTube TV's streaming only and Twitch's carried for a Prime Video game under way",
    () =>
      Effect.gen(function* () {
        yield* TestHub.readRecordedGuide
        const availabilityOf = yield* TestHub.availabilityNow

        assert.deepStrictEqual(
          availabilityOf(snapshot({ ...primeVideoSoonAfterRecording, status: "live" })),
          [{ _tag: "NotCarried", why: "StreamingOnly" }, onPrimeVideo]
        )
      }).pipe(Effect.provide(youTubeTvAndTwitch))
  )

  it.effect("should give every source's lineup, in the order given", () =>
    Effect.gen(function* () {
      const member = (name: string, source: "YouTube TV" | "Twitch") => ({
        channel: { name, source, locator: { _tag: "WebView" as const, url: `https://example.test/${name}` } },
        now: Option.none(),
        next: Option.none()
      })
      const all = Source.layerAll([
        Source.layerTest(() => streamingOnly, [member("ESPN", "YouTube TV")]),
        Source.layerTest(() => streamingOnly, [member("Prime Video", "Twitch")])
      ])

      const lineupAt = yield* Source.use((source) => source.lineup).pipe(Effect.provide(all))

      assert.deepStrictEqual(
        lineupAt(DateTime.makeUnsafe(0)).map(({ channel }) => channel.name),
        ["ESPN", "Prime Video"]
      )
    })
  )
})

/** An NFL game, Jets at Broncos, streaming only on Prime Video, starting at `startsAt`. */
function primeVideoGame(startsAt: DateTime.Utc) {
  return snapshot({
    league: "nfl",
    startsAt,
    away: { team: team("NYJ", "nfl", { name: "New York Jets", shortName: "Jets" }), score: 0 },
    home: { team: team("DEN", "nfl", { name: "Denver Broncos", shortName: "Broncos" }), score: 0 },
    broadcasts: [broadcast("Prime Video", "streaming")]
  })
}
