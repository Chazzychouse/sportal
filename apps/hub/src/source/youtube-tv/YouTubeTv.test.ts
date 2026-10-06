import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Fiber, Layer, Logger, Option, Ref, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as EspnProvider from "../../provider/espn/EspnProvider.ts"
import { listedBy } from "../../provider/TestProvider.ts"
import * as TestDatabase from "../../TestDatabase.ts"
import { ChannelStore } from "../ChannelStore.ts"
import { Source } from "../Source.ts"
import * as YouTubeTv from "./YouTubeTv.ts"

// Addresses recorded from YouTube TV's live guide on 2026-10-03.
const cbsLive = "https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D"
const foxLive = "https://tv.youtube.com/watch/_MpmFlh-Wzc?vp=0gEEEgIwAQ%3D%3D"
const foxFromTheBeginning =
  "https://tv.youtube.com/watch/_MpmFlh-Wzc?vpp=gAKAzYTWBg%3D%3D&vp=0gEKEgIwARiAzYTWBg%3D%3D"

const espn = Network.make("ESPN")
const disney = Network.make("Disney+")
const onEspn = snapshot({ broadcasts: [broadcast(espn)] })
const onEspnAndDisney = snapshot({ broadcasts: [broadcast(disney), broadcast(espn)] })
const guide = { _tag: "WebView" as const, url: "https://tv.youtube.com/live" }
describe("YouTubeTv source", () => {
  it.effect("starts with every network unlearned, pointing at the live guide", () =>
    Effect.gen(function* () {
      const availabilityOf = yield* (yield* Source).availability
      assert.deepStrictEqual(
        availabilityOf(onEspn),
        ChannelAvailability.Unlearned({ network: espn, source: "YouTube TV", guide })
      )
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("learns a channel from a guide address and keeps its live address", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, foxFromTheBeginning)
      assert.deepStrictEqual(
        (yield* source.availability)(onEspn),
        ChannelAvailability.Carried({
          channel: { name: espn, source: "YouTube TV", locator: { _tag: "WebView", url: foxLive } },
          learnedFor: Option.some(espn)
        })
      )
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("keeps a live channel address as it is", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, cbsLive)
      assert.deepStrictEqual(
        (yield* source.availability)(onEspn),
        ChannelAvailability.Carried({
          channel: { name: espn, source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } },
          learnedFor: Option.some(espn)
        })
      )
    }).pipe(Effect.provide(testSource()))
  )

  it.effect.each([
    "https://tv.youtube.com/live",
    "https://tv.youtube.com/watch/",
    "https://tv.youtube.com/watch/abc/extra",
    "http://tv.youtube.com/watch/abc",
    "https://www.youtube.com/watch/abc",
    "https://tv.youtube.com.evil.example/watch/abc",
    "not a url"
  ])("refuses to learn %s, which is not a channel address, and learns nothing", (url) =>
    Effect.gen(function* () {
      const source = yield* Source
      const error = yield* source.learn(espn, url).pipe(Effect.flip)
      assert.strictEqual(error._tag, "ChannelUrlRefused")
      assert.strictEqual((yield* source.availability)(onEspn)._tag, "Unlearned")
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("moves on to the next network once one is marked not carried", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.markNotCarried(disney)
      assert.deepStrictEqual(
        (yield* source.availability)(onEspnAndDisney),
        ChannelAvailability.Unlearned({ network: espn, source: "YouTube TV", guide })
      )
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("forgets a learned channel", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, cbsLive)
      yield* source.forget(espn)
      assert.strictEqual((yield* source.availability)(onEspn)._tag, "Unlearned")
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("signals a change after each write, not before", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const signals = yield* source.changes.pipe(Stream.take(2), Stream.runCount, Effect.forkChild)
      yield* Effect.yieldNow
      yield* source.learn(espn, cbsLive)
      yield* source.markNotCarried(disney)
      assert.strictEqual(yield* Fiber.join(signals), 2)
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("loads what the channel store already holds", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* (yield* Source).availability)(onEspn)._tag, "Carried")
    }).pipe(Effect.provide(YouTubeTv.layer.pipe(Layer.provide(storeKnowingEspn()))))
  )
})

/** The source over a fresh in-memory database. */
function testSource() {
  return YouTubeTv.layer.pipe(
    Layer.provide(ChannelStore.layer),
    Layer.provide(TestDatabase.layer(":memory:"))
  )
}

/** An in-memory channel store that already holds ESPN's channel when the source starts. */
function storeKnowingEspn() {
  return Layer.effect(
    ChannelStore,
    Effect.gen(function* () {
      const store = yield* ChannelStore
      yield* store.record({
        _tag: "Carried",
        network: espn,
        channel: { name: espn, source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } }
      })
      return store
    })
  ).pipe(Layer.provide(ChannelStore.layer), Layer.provide(TestDatabase.layer(":memory:")))
}

// The first page of YouTube TV's live guide, read 2026-10-03T20:24:45Z, reduced to what the source reads.
const recordedGuide = readFileSync(new URL("./fixtures/guide-2026-10-03T2024Z.json", import.meta.url), "utf8")
const readAt = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T20:24:45Z"))
const ohioStateAtIowa = snapshot({
  status: "live",
  kickoff: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
  away: { team: team("OSU", "fbs", { name: "Ohio State Buckeyes", location: "Ohio State" }), score: 0 },
  home: { team: team("IOWA", "fbs", { name: "Iowa Hawkeyes", location: "Iowa" }), score: 0 },
  broadcasts: [broadcast("CBS")]
})
const onNews3 = ChannelAvailability.Carried({
  channel: { name: "News 3", source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } },
  learnedFor: Option.none()
})

describe("YouTubeTv source reading its guide", () => {
  it.effect("reads the recorded guide's channels, live addresses, and airings", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(readAt)
      const source = yield* Source
      yield* source.readGuide(recordedGuide)
      assert.deepStrictEqual((yield* source.availability)(ohioStateAtIowa), onNews3)
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("signals a change after a guide is read", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const signals = yield* source.changes.pipe(Stream.take(1), Stream.runCount, Effect.forkChild)
      yield* Effect.yieldNow
      yield* source.readGuide(recordedGuide)
      assert.strictEqual(yield* Fiber.join(signals), 1)
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("falls back to the lineup once its guide is 45 minutes old, and signals then", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(readAt)
      const source = yield* Source
      yield* source.readGuide(recordedGuide)
      const changes = yield* counted(source.changes)
      yield* TestClock.adjust("44 minutes")
      assert.deepStrictEqual((yield* source.availability)(ohioStateAtIowa), onNews3)
      assert.strictEqual(yield* Ref.get(changes), 0)
      yield* TestClock.adjust("1 minute")
      assert.strictEqual((yield* source.availability)(ohioStateAtIowa)._tag, "Unlearned")
      assert.strictEqual(yield* Ref.get(changes), 1)
    }).pipe(Effect.provide(testSource()))
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
    }).pipe(Effect.provide(testSource()))
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
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("keeps answering from the guide after the lineup changes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(readAt)
      const source = yield* Source
      yield* source.readGuide(recordedGuide)
      const cbs = Network.make("CBS")
      yield* source.learn(cbs, foxLive)
      yield* source.markNotCarried(espn)
      yield* source.forget(cbs)
      assert.deepStrictEqual((yield* source.availability)(ohioStateAtIowa), onNews3)
    }).pipe(Effect.provide(testSource()))
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
    }).pipe(Effect.provide(testSource()))
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
      }).pipe(Effect.provide(Layer.merge(testSource(), Logger.layer([collector]))))
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
        // Still answering from the lineup: nothing was read.
        assert.strictEqual((yield* source.availability)(onEspn)._tag, "Unlearned")
      }).pipe(Effect.provide(testSource()))
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
        Unlearned: () => assert.fail(`${game.id} was left to the lineup`),
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
  const espn = (name: string) =>
    readFileSync(new URL(`../../provider/espn/fixtures/${name}.json`, import.meta.url), "utf8")
  const fbs = espn("fbs-scoreboard-2026-10-03T2024Z")
  const nfl = espn("nfl-scoreboard-pregame")
  const recorded = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(request.url.includes("/nfl/") ? nfl : fbs))
      )
    )
  )
  return Layer.mergeAll(testSource(), EspnProvider.layer.pipe(Layer.provide(recorded)))
}
