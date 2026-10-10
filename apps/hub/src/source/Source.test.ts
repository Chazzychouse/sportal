import { assert, describe, it } from "@effect/vitest"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { type GameSnapshot, Network } from "@sportal/domain/Game"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"
import { Source } from "./Source.ts"
import * as TestYouTubeTv from "./youtube-tv/TestYouTubeTv.ts"

const now = Effect.gen(function* () {
  const source = yield* Source
  const now = yield* DateTime.now

  const availabilityOf = yield* source.availability
  return (game: GameSnapshot) => availabilityOf(game, now)
})

const youTubeTv = Source.layerYouTubeTv
const youTubeTvAndTwitch = Source.layerAll([Source.layerYouTubeTv, Source.layerTwitch])

const espn = Network.make("ESPN")
const onEspn = snapshot({ broadcasts: [broadcast(espn)] })

describe("Source.layerYouTubeTv", () => {
  it.effect("should give no guide before any guide is read", () =>
    Effect.gen(function* () {
      const availabilityOf = yield* now

      assert.deepStrictEqual(availabilityOf(onEspn), [{ _tag: "NoGuide", source: "YouTube TV" }])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should give streaming only for a Prime Video game the guide does not list", () =>
    Effect.gen(function* () {
      yield* TestYouTubeTv.readRecordedGuide
      const availabilityOf = yield* now

      assert.deepStrictEqual(availabilityOf(primeVideoSoonAfterRecording), [
        { _tag: "NotCarried", why: "StreamingOnly" }
      ])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should keep the guide it has when a later response cannot be read", () =>
    Effect.gen(function* () {
      yield* TestYouTubeTv.readRecordedGuide

      yield* Source.use((source) => source.readGuide("{}")).pipe(Effect.flip)

      const availabilityOf = yield* now
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), [onNews3])
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

      const availabilityOf = yield* now
      assert.strictEqual(error._tag, "GuideUnreadable")
      assert.deepStrictEqual(availabilityOf(onEspn), [{ _tag: "NoGuide", source: "YouTube TV" }])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should carry from a guide 44 minutes after reading it", () =>
    Effect.gen(function* () {
      yield* TestYouTubeTv.readRecordedGuide

      yield* TestClock.adjust("44 minutes")

      const availabilityOf = yield* now
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), [onNews3])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should give no guide once its guide is 45 minutes old", () =>
    Effect.gen(function* () {
      yield* TestYouTubeTv.readRecordedGuide

      yield* TestClock.adjust("45 minutes")

      const availabilityOf = yield* now
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), [{ _tag: "NoGuide", source: "YouTube TV" }])
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should carry from a newer guide when an older one would have gone stale", () =>
    Effect.gen(function* () {
      yield* TestYouTubeTv.readRecordedGuide
      yield* TestClock.adjust("30 minutes")
      yield* Source.use((source) => source.readGuide(TestYouTubeTv.recordedGuide))

      yield* TestClock.adjust("20 minutes")

      const availabilityOf = yield* now
      assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), [onNews3])
    }).pipe(Effect.provide(youTubeTv))
  )
})

// News 3's live address, recorded from YouTube TV's live guide on 2026-10-03.
const cbsLive = "https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D"

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

const thursdayKickoff = DateTime.makeUnsafe("2026-10-09T00:15:00Z")
const thursdayNight = primeVideoGame(thursdayKickoff)
const thursdayNightStarted = snapshot({ ...thursdayNight, status: "live" })
// A Prime Video game whose teams the recorded guide does not list, kicking off 20 minutes after it was read.
const primeVideoSoonAfterRecording = primeVideoGame(
  DateTime.add(DateTime.makeUnsafe(TestYouTubeTv.recordedAt), { minutes: 20 })
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
      yield* TestClock.setTime(DateTime.toEpochMillis(thursdayKickoff))

      const availabilityOf = yield* now

      assert.deepStrictEqual(availabilityOf(thursdayNightStarted), [onPrimeVideo])
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

      const availabilityOf = yield* now.pipe(Effect.provide(all))

      assert.deepStrictEqual(availabilityOf(thursdayNight), [streamingOnly, carried("Twitch")])
    })
  )

  it.effect(
    "should give no guide from YouTube TV and carried from Twitch for Thursday's Prime Video game once it has started",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(thursdayKickoff, { minutes: 10 })))

        const availabilityOf = yield* now

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
        yield* TestYouTubeTv.readRecordedGuide
        const availabilityOf = yield* now

        assert.deepStrictEqual(
          availabilityOf(snapshot({ ...primeVideoSoonAfterRecording, status: "live" })),
          [{ _tag: "NotCarried", why: "StreamingOnly" }, onPrimeVideo]
        )
      }).pipe(Effect.provide(youTubeTvAndTwitch))
  )
})

/** An NFL game, Jets at Broncos, streaming only on Prime Video, kicking off at `kickoff`. */
function primeVideoGame(kickoff: DateTime.Utc) {
  return snapshot({
    league: "nfl",
    kickoff,
    away: { team: team("NYJ", "nfl", { name: "New York Jets", shortName: "Jets" }), score: 0 },
    home: { team: team("DEN", "nfl", { name: "Denver Broncos", shortName: "Broncos" }), score: 0 },
    broadcasts: [broadcast("Prime Video", "streaming")]
  })
}
