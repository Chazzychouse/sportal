import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Fiber, Layer, Logger, Option, Ref, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as EspnDecode from "../../provider/espn/EspnDecode.ts"
import * as EspnProvider from "../../provider/espn/EspnProvider.ts"
import { FastCast } from "../../provider/espn/FastCast.ts"
import { noSocket, recordedScoreboard } from "../../provider/espn/TestEspn.ts"
import { listedBy } from "../../TestFeed.ts"
import { withEnv } from "../../TestHubConfig.ts"
import { Source } from "../Source.ts"
import { recordedGuide } from "./TestYouTubeTv.ts"
import * as YouTubeTv from "./YouTubeTv.ts"

// News 3's live address, recorded from YouTube TV's live guide on 2026-10-03.
const cbsLive = "https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D"

const espn = Network.make("ESPN")
const onEspn = snapshot({ broadcasts: [broadcast(espn)] })

describe("YouTubeTv source", () => {
  it.effect("answers no guide before any guide is read", () =>
    Effect.gen(function* () {
      const availabilityOf = yield* (yield* Source).availability
      assert.deepStrictEqual(availabilityOf(onEspn), ChannelAvailability.NoGuide({ source: "YouTube TV" }))
    }).pipe(Effect.provide(YouTubeTv.layer))
  )
})

const readAt = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T20:24:45Z"))
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

describe("YouTubeTv source reading its guide", () => {
  it.effect("reads the recorded guide's channels, live addresses, and airings", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(readAt)
      const source = yield* Source
      yield* source.readGuide(recordedGuide)
      assert.deepStrictEqual((yield* source.availability)(ohioStateAtIowa), onNews3)
    }).pipe(Effect.provide(YouTubeTv.layer))
  )

  it.effect("signals a change after a guide is read", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const signals = yield* source.changes.pipe(Stream.take(1), Stream.runCount, Effect.forkChild)
      yield* Effect.yieldNow
      yield* source.readGuide(recordedGuide)
      assert.strictEqual(yield* Fiber.join(signals), 1)
    }).pipe(Effect.provide(YouTubeTv.layer))
  )

  it.effect("answers no guide once its guide is 45 minutes old, and signals then", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(readAt)
      const source = yield* Source
      yield* source.readGuide(recordedGuide)
      const changes = yield* counted(source.changes)
      yield* TestClock.adjust("44 minutes")
      assert.deepStrictEqual((yield* source.availability)(ohioStateAtIowa), onNews3)
      assert.strictEqual(yield* Ref.get(changes), 0)
      yield* TestClock.adjust("1 minute")
      assert.deepStrictEqual(
        (yield* source.availability)(ohioStateAtIowa),
        ChannelAvailability.NoGuide({ source: "YouTube TV" })
      )
      assert.strictEqual(yield* Ref.get(changes), 1)
    }).pipe(Effect.provide(YouTubeTv.layer))
  )

  it.effect("keeps a newer guide when an older one would have gone stale", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(readAt)
      const source = yield* Source
      yield* source.readGuide(recordedGuide)
      yield* TestClock.adjust("30 minutes")
      yield* source.readGuide(recordedGuide)
      yield* TestClock.adjust("20 minutes")
      assert.deepStrictEqual((yield* source.availability)(ohioStateAtIowa), onNews3)
    }).pipe(Effect.provide(YouTubeTv.layer))
  )

  it.effect("keeps the guide it has, and signals nothing, when a later response cannot be read", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(readAt)
      const source = yield* Source
      yield* source.readGuide(recordedGuide)
      const changes = yield* counted(source.changes)
      yield* source.readGuide("{}").pipe(Effect.flip)
      yield* Effect.yieldNow
      assert.deepStrictEqual((yield* source.availability)(ohioStateAtIowa), onNews3)
      assert.strictEqual(yield* Ref.get(changes), 0)
    }).pipe(Effect.provide(YouTubeTv.layer))
  )

  it.effect("leaves a channel without a live address when its row's live id is not one", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(readAt)
      const source = yield* Source
      yield* source.readGuide(oneRowGuide("y6zFA17zDsw?x"))
      assert.deepStrictEqual(
        (yield* source.availability)(ohioStateAtIowa),
        ChannelAvailability.Upcoming({
          channel: Option.some("News 3"),
          begin: Option.some(DateTime.makeUnsafe("2026-10-03T19:35:00Z"))
        })
      )
    }).pipe(Effect.provide(YouTubeTv.layer))
  )

  it.effect("logs why a response could not be read, without the response", () =>
    Effect.gen(function* () {
      const logged: Array<{ readonly level: string; readonly message: string }> = []
      const collector = Logger.make(({ logLevel, message }) => {
        logged.push({ level: logLevel, message: JSON.stringify(message) })
      })
      const response = JSON.stringify({ contents: { secret: "payload" } })
      yield* Effect.gen(function* () {
        yield* (yield* Source).readGuide(response).pipe(Effect.flip)
      }).pipe(Effect.provide(Layer.merge(YouTubeTv.layer, Logger.layer([collector]))))
      const warnings = logged.filter(({ level }) => level === "Warn")
      assert.strictEqual(warnings.length, 1)
      assert.include(warnings[0]?.message, "epgRenderer")
      assert.notInclude(warnings[0]?.message, "secret")
    })
  )

  for (const response of [
    "not json",
    "{}",
    JSON.stringify({
      contents: { epgRenderer: { paginationRenderer: { epgPaginationRenderer: { contents: [] } } } }
    })
  ])
    it.effect(`refuses a response that is not a guide with channels: ${response.slice(0, 40)}`, () =>
      Effect.gen(function* () {
        const source = yield* Source
        const error = yield* source.readGuide(response).pipe(Effect.flip)
        assert.strictEqual(error._tag, "GuideUnreadable")
        assert.strictEqual((yield* source.availability)(onEspn)._tag, "NoGuide")
      }).pipe(Effect.provide(YouTubeTv.layer))
    )
})

describe("matching the 2026-10-03 slates to the guide read at 20:24:45Z", () => {
  it.effect(
    "places every college game on television that is under way, and the rest as the guide allows",
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

  it.effect("puts each of Sunday's CBS and FOX games on its own Sunday Ticket station", () =>
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

/** Reads the recorded guide at the moment it was recorded, then sorts a league's slate by availability. */
function tallied(league: LeagueId) {
  return Effect.gen(function* () {
    yield* TestClock.setTime(readAt)
    const source = yield* Source
    yield* source.readGuide(recordedGuide)
    const availabilityOf = yield* source.availability
    const tally = {
      carried: {} as Record<string, string>,
      upcomingOn: {} as Record<string, string>,
      upcomingUnknown: 0,
      streamingOnly: 0,
      notInGuide: 0
    }
    for (const game of yield* listedBy(league)) {
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

/** The source over a fresh database, and ESPN answering from its 2026-10-03 recordings. */
function matchingLayer() {
  const fbs = recordedScoreboard("fbs-scoreboard-2026-10-03T2024Z")
  const nfl = recordedScoreboard("nfl-scoreboard-pregame")
  const recorded = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(request.url.includes("/nfl/") ? nfl : fbs))
      )
    )
  )
  return Layer.mergeAll(
    YouTubeTv.layer,
    EspnProvider.layer.pipe(
      Layer.provide(FastCast.layer),
      Layer.provide([recorded, noSocket, withEnv({}).pipe(Layer.orDie)])
    ),
    EspnDecode.layer
  )
}
