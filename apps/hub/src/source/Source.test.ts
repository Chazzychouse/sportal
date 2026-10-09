import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Option, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { recordedEspn, recordedScoreboard } from "../provider/espn/TestEspn.ts"
import { listedBy } from "../provider/TestProvider.ts"
import { GuideReader } from "./GuideReader.ts"
import { Source } from "./Source.ts"
import { readRecordedGuide, recordedAt } from "./youtube-tv/TestYouTubeTv.ts"

const youTubeTv = Source.layerYouTubeTv.pipe(Layer.provideMerge(GuideReader.layerYouTubeTv))
const youTubeTvAndTwitch = Source.layerAll([Source.layerYouTubeTv, Source.layerTwitch]).pipe(
  Layer.provideMerge(GuideReader.layerYouTubeTv)
)

const espn = Network.make("ESPN")
const onEspn = snapshot({ broadcasts: [broadcast(espn)] })

describe("Source.layerYouTubeTv", () => {
  it.effect("should answer no guide before any guide is read", () =>
    Effect.gen(function* () {
      const source = yield* Source

      const availabilityOf = yield* source.availability

      assert.deepStrictEqual(availabilityOf(onEspn), ChannelAvailability.NoGuide({ source: "YouTube TV" }))
    }).pipe(Effect.provide(youTubeTv))
  )

  it.effect("should answer streaming only for a Prime Video game the guide does not list", () =>
    Effect.gen(function* () {
      yield* readRecordedGuide
      const source = yield* Source

      const availabilityOf = yield* source.availability

      assert.deepStrictEqual(
        availabilityOf(primeVideoSoonAfterRecording),
        ChannelAvailability.NotCarried({ why: "StreamingOnly" })
      )
    }).pipe(Effect.provide(youTubeTv))
  )
})

describe("matching the 2026-10-03 slates to the guide read at 20:24:45Z", () => {
  it.effect(
    "should place every college game on television that is under way, and the rest as the guide allows",
    () =>
      Effect.gen(function* () {
        const tally = yield* tallied("fbs")

        assert.deepStrictEqual(tally.carried, {
          "401858473": "News 3", // Ohio State at Iowa: CBS is the local affiliate's name in the guide
          "401856710": "ESPN",
          "401858247": "CBS Sports Network",
          "401858248": "ACC Network",
          "401858253": "ESPN2",
          "401864515": "WVBTDT2", // Wyoming at North Dakota State, on the CW affiliate
          "401869956": "ESPN", // Old Dominion at Georgia State: ESPN says ESPN+, the guide has it on an ESPN channel
          "401869962": "ESPNU",
          "401856708": "ABC 13",
          "401858475": "FS1",
          "401856709": "SEC Network",
          "401858472": "BTN"
        })
        assert.deepStrictEqual(tally.upcomingOn, {
          "401860899": "USA",
          "401856818": "ESPN",
          "401856711": "ESPN2",
          "401858249": "ABC 13", // Miami at Clemson: on ABC 13 and ACC Network; ESPN's "ABC" settles it
          "401856821": "FOX 43",
          "401858478": "WAVY 10",
          "401860898": "CBS Sports Network",
          "401862792": "ESPNU",
          "401856706": "SEC Network"
        })
        assert.strictEqual(tally.upcomingUnknown, 8)
        assert.strictEqual(tally.streamingOnly, 13)
        assert.strictEqual(tally.notInGuide, 17)
      }).pipe(Effect.provide(matchingLayer()))
  )

  it.effect("should put each of Sunday's CBS and FOX games on its own Sunday Ticket station", () =>
    Effect.gen(function* () {
      const tally = yield* tallied("nfl")

      const stations = Object.values(tally.upcomingOn)
      assert.strictEqual(stations.length, 12)
      assert.strictEqual(stations.filter((name) => name === "NFL ST - CBS").length, 7)
      assert.strictEqual(stations.filter((name) => name === "NFL ST - FOX").length, 5)
      assert.strictEqual(tally.upcomingUnknown, 3)
      assert.strictEqual(tally.streamingOnly, 1)
    }).pipe(Effect.provide(matchingLayer()))
  )
})

/** Reads the recorded guide at the moment it was recorded, then sorts a league's slate by availability. */
function tallied(league: LeagueId) {
  return Effect.gen(function* () {
    yield* readRecordedGuide
    const source = yield* Source
    const availabilityOf = yield* source.availability
    const tally = {
      carried: {} as Record<string, string>,
      upcomingOn: {} as Record<string, string>,
      upcomingUnknown: 0,
      streamingOnly: 0,
      notInGuide: 0
    }
    const listed = yield* listedBy(league)
    for (const game of listed) {
      ChannelAvailability.$match(availabilityOf(game), {
        Carried: ({ channel }) => {
          tally.carried[game.id] = channel.name
        },
        Upcoming: ({ channel }) =>
          Option.match(channel, {
            onNone: () => {
              tally.upcomingUnknown++
            },
            onSome: (name) => {
              tally.upcomingOn[game.id] = name
            }
          }),
        NoGuide: () => assert.fail(`${game.id} had no guide`),
        NotCarried: ({ why }) => {
          if (why === "StreamingOnly") tally.streamingOnly++
          else if (why === "NotInGuide") tally.notInGuide++
          else assert.fail(`${game.id} is not carried for ${why}`)
        }
      })
    }
    return tally
  })
}

/** YouTube TV, and ESPN answering from its 2026-10-03 recordings. */
function matchingLayer() {
  const espn = recordedEspn({
    nfl: recordedScoreboard("nfl-scoreboard-pregame"),
    fbs: recordedScoreboard("fbs-scoreboard-2026-10-03T2024Z")
  })
  return Layer.mergeAll(youTubeTv, espn)
}

const thursdayKickoff = DateTime.makeUnsafe("2026-10-09T00:15:00Z")
const thursdayNight = primeVideoGame(thursdayKickoff)
// A Prime Video game whose teams the recorded guide does not list, kicking off 20 minutes after it was read.
const primeVideoSoonAfterRecording = primeVideoGame(
  DateTime.add(DateTime.makeUnsafe(recordedAt), { minutes: 20 })
)
const onPrimeVideo = ChannelAvailability.Carried({
  channel: {
    name: "Prime Video",
    source: "Twitch",
    locator: {
      _tag: "WebView",
      url: "https://player.twitch.tv/?channel=primevideo&parent=twitch.tv&player=popout"
    }
  }
})

describe("Source.layerTwitch", () => {
  it.effect("should carry a Prime Video game on primevideo from 30 minutes before kickoff", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.subtract(thursdayKickoff, { minutes: 30 })))
      const source = yield* Source

      const availabilityOf = yield* source.availability

      assert.deepStrictEqual(availabilityOf(thursdayNight), onPrimeVideo)
    }).pipe(Effect.provide(Source.layerTwitch))
  )

  it.effect("should say it may have changed once a minute", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const changes = yield* Ref.make(0)
      yield* source.changes.pipe(
        Stream.runForEach(() => Ref.update(changes, (n) => n + 1)),
        Effect.forkChild
      )
      yield* Effect.yieldNow

      yield* TestClock.adjust("1 minute")

      const signalled = yield* Ref.get(changes)
      assert.strictEqual(signalled, 1)
    }).pipe(Effect.provide(Source.layerTwitch))
  )
})

describe("Source.layerAll", () => {
  const carried = (source: "YouTube TV" | "Twitch") =>
    ChannelAvailability.Carried({
      channel: { name: source, source, locator: { _tag: "WebView", url: `https://example.test/${source}` } }
    })
  const upcomingOn = ChannelAvailability.Upcoming({
    channel: Option.some("Prime Video"),
    begin: Option.some(thursdayKickoff)
  })
  const upcomingUnknown = ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
  const noGuide = ChannelAvailability.NoGuide({ source: "YouTube TV" })
  const streamingOnly = ChannelAvailability.NotCarried({ why: "StreamingOnly" })
  const notInGuide = ChannelAvailability.NotCarried({ why: "NotInGuide" })

  it.effect("should answer a later source's carried over an earlier source's not carried", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([streamingOnly, carried("Twitch")])

      assert.deepStrictEqual(answer, carried("Twitch"))
    })
  )

  it.effect("should answer carried over upcoming", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([upcomingOn, carried("Twitch")])

      assert.deepStrictEqual(answer, carried("Twitch"))
    })
  )

  it.effect("should answer upcoming on a named channel over upcoming with nothing known", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([upcomingUnknown, upcomingOn])

      assert.deepStrictEqual(answer, upcomingOn)
    })
  )

  it.effect("should answer upcoming over no guide", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([noGuide, upcomingUnknown])

      assert.deepStrictEqual(answer, upcomingUnknown)
    })
  )

  it.effect("should answer no guide over not carried", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([streamingOnly, noGuide])

      assert.deepStrictEqual(answer, noGuide)
    })
  )

  it.effect("should answer streaming only over not in the guide", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([notInGuide, streamingOnly])

      assert.deepStrictEqual(answer, streamingOnly)
    })
  )

  it.live("should change whenever any of its sources changes", () =>
    Effect.gen(function* () {
      const all = Source.layerAll([
        Source.layerTest(() => notInGuide, Stream.never),
        Source.layerTest(() => notInGuide, Stream.make(undefined))
      ])

      const changes = yield* Source.use(({ changes }) => Stream.runCount(Stream.take(changes, 1))).pipe(
        Effect.provide(all),
        Effect.timeout("1 second")
      )

      assert.strictEqual(changes, 1)
    })
  )

  it.effect("should carry Thursday's Prime Video game on Twitch while YouTube TV has no guide", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.subtract(thursdayKickoff, { minutes: 10 })))
      const source = yield* Source

      const availabilityOf = yield* source.availability

      assert.deepStrictEqual(availabilityOf(thursdayNight), onPrimeVideo)
    }).pipe(Effect.provide(youTubeTvAndTwitch))
  )

  it.effect("should carry a Prime Video game on Twitch over YouTube TV's streaming only", () =>
    Effect.gen(function* () {
      yield* readRecordedGuide
      const source = yield* Source

      const availabilityOf = yield* source.availability

      assert.deepStrictEqual(availabilityOf(primeVideoSoonAfterRecording), onPrimeVideo)
    }).pipe(Effect.provide(youTubeTvAndTwitch))
  )
})

/** What every source answering one of `answers`, in order, answers as one. */
function answerOf(answers: ReadonlyArray<ChannelAvailability>) {
  const all = Source.layerAll(answers.map((answer) => Source.layerTest(() => answer)))
  return Effect.gen(function* () {
    const source = yield* Source

    const availabilityOf = yield* source.availability
    return availabilityOf(thursdayNight)
  }).pipe(Effect.provide(all))
}

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
