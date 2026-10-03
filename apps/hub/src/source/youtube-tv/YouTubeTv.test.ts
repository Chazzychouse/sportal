import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { ChannelAvailability } from "@sportal/domain/Source"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as Database from "../../database/Database.ts"
import * as EspnProvider from "../../provider/espn/EspnProvider.ts"
import { Provider } from "../../provider/Provider.ts"
import { ChannelStore } from "../ChannelStore.ts"
import { Source } from "../Source.ts"
import * as SqlChannelStore from "../SqlChannelStore.ts"
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
const decodeLive = Schema.decodeUnknownOption(YouTubeTv.LiveChannelUrl)

describe("YouTubeTv.LiveChannelUrl", () => {
  it("keeps a live channel address as it is", () => {
    assert.deepStrictEqual(decodeLive(cbsLive), Option.some(cbsLive))
  })

  it("decodes a from-the-beginning address to the live address for the same channel", () => {
    assert.deepStrictEqual(decodeLive(foxFromTheBeginning), Option.some(foxLive))
  })

  it.each([
    "https://tv.youtube.com/live",
    "https://tv.youtube.com/watch/",
    "https://tv.youtube.com/watch/abc/extra",
    "http://tv.youtube.com/watch/abc",
    "https://www.youtube.com/watch/abc",
    "https://tv.youtube.com.evil.example/watch/abc",
    "not a url"
  ])("refuses %s", (url) => {
    assert.isTrue(Option.isNone(decodeLive(url)))
  })
})

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

  it.effect("refuses to learn an address that is not a channel, and learns nothing", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const error = yield* source.learn(espn, "https://tv.youtube.com/live").pipe(Effect.flip)
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
  return YouTubeTv.layer.pipe(Layer.provide(SqlChannelStore.layer), Layer.provide(Database.layer(":memory:")))
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
  ).pipe(Layer.provide(SqlChannelStore.layer), Layer.provide(Database.layer(":memory:")))
}

// The first page of YouTube TV's live guide, read 2026-10-03T20:24:45Z, reduced to what the source reads.
const recordedGuide = readFileSync(new URL("./fixtures/guide-2026-10-03T2024Z.json", import.meta.url), "utf8")
const readAt = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T20:24:45Z"))

describe("YouTubeTv source reading its guide", () => {
  it.effect("reads the recorded guide's channels, live addresses, and airings", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(readAt)
      const source = yield* Source
      yield* source.readGuide(recordedGuide)
      const ohioStateAtIowa = snapshot({
        status: "live",
        kickoff: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
        away: { team: team("OSU", "fbs", { name: "Ohio State Buckeyes", location: "Ohio State" }), score: 0 },
        home: { team: team("IOWA", "fbs", { name: "Iowa Hawkeyes", location: "Iowa" }), score: 0 },
        broadcasts: [broadcast("CBS")]
      })
      assert.deepStrictEqual(
        (yield* source.availability)(ohioStateAtIowa),
        ChannelAvailability.Carried({
          channel: { name: "News 3", source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } },
          learnedFor: Option.none()
        })
      )
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
    for (const game of yield* (yield* Provider).slate(league)) {
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
