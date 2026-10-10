import { assert, describe, it } from "@effect/vitest"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { type GameSnapshot, Network } from "@sportal/domain/Game"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Option, Stream } from "effect"
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
const youTubeTvAndTwitch = Source.layerAll([Source.layerYouTubeTv, Source.layerTwitch]).pipe(
  Layer.provideMerge(GuideReader.layerYouTubeTv)
)

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
})

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

  it.effect("should give its lineup once, never changing", () =>
    Effect.gen(function* () {
      const source = yield* Source

      const given = yield* Stream.runCount(source.availability)

      assert.strictEqual(given, 1)
    }).pipe(Effect.provide(Source.layerTwitch))
  )
})

describe("Source.layerAll", () => {
  const carried = (source: "YouTube TV" | "Twitch"): ChannelAvailability => ({
    _tag: "Carried",
    channel: { name: source, source, locator: { _tag: "WebView", url: `https://example.test/${source}` } }
  })
  const streamingOnly: ChannelAvailability = { _tag: "NotCarried", why: "StreamingOnly" }
  const notInGuide: ChannelAvailability = { _tag: "NotCarried", why: "NotInGuide" }

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

  it.effect("should give its availability again whenever any of its sources changes", () =>
    Effect.gen(function* () {
      const all = Source.layerAll([
        Source.layerTest(() => notInGuide),
        Source.layerTest(() => notInGuide, Stream.make(undefined))
      ])

      const given = yield* Source.use(({ availability }) => Stream.runCount(availability)).pipe(
        Effect.provide(all)
      )

      assert.strictEqual(given, 2)
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
