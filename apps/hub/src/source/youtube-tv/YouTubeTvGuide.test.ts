import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import type { LeagueId } from "@sportal/domain/League"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Logger, Option } from "effect"
import { TestClock } from "effect/testing"
import * as TestEspn from "../../provider/espn/TestEspn.ts"
import * as TestProvider from "../../provider/TestProvider.ts"
import { Guide } from "../Guide.ts"
import { GuideReader } from "../GuideReader.ts"
import { Source } from "../Source.ts"
import * as TestSource from "../TestSource.ts"
import * as TestYouTubeTv from "./TestYouTubeTv.ts"
import * as YouTubeTvGuide from "./YouTubeTvGuide.ts"

const youTubeTv = Source.layerYouTubeTv.pipe(Layer.provideMerge(GuideReader.layerYouTubeTv))

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

describe("YouTubeTvGuide.decode", () => {
  it.effect("should return a complete guide stamped by the Effect clock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(TestYouTubeTv.recordedAt)

      const guide = yield* YouTubeTvGuide.decode(TestYouTubeTv.recordedGuide)

      assert.isTrue(guide instanceof Guide)
      assert.strictEqual(guide.source, "YouTube TV")
      assert.strictEqual(DateTime.toEpochMillis(guide.readAt), TestYouTubeTv.recordedAt)
      assert.isAbove(guide.channels.length, 0)
      assert.isAbove(guide.airings.length, 0)
    })
  )

  it.effect("should reject a response with no channels as GuideUnreadable", () =>
    Effect.gen(function* () {
      const response = JSON.stringify({
        contents: { epgRenderer: { paginationRenderer: { epgPaginationRenderer: { contents: [] } } } }
      })

      const error = yield* YouTubeTvGuide.decode(response).pipe(Effect.flip)

      assert.strictEqual(error._tag, "GuideUnreadable")
    })
  )

  it.effect("should reject malformed JSON as GuideUnreadable", () =>
    Effect.gen(function* () {
      const error = yield* YouTubeTvGuide.decode("not json").pipe(Effect.flip)

      assert.strictEqual(error._tag, "GuideUnreadable")
    })
  )

  it.effect("should reject JSON that is not a guide as GuideUnreadable", () =>
    Effect.gen(function* () {
      const error = yield* YouTubeTvGuide.decode("{}").pipe(Effect.flip)

      assert.strictEqual(error._tag, "GuideUnreadable")
    })
  )

  it.effect("should give the recorded guide's channels, live addresses, and airings", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(TestYouTubeTv.recordedAt)

      const guide = yield* YouTubeTvGuide.decode(TestYouTubeTv.recordedGuide)
      const availability = guide.availabilityOf(ohioStateAtIowa, guide.readAt)

      assert.deepStrictEqual([availability], [onNews3])
    })
  )

  it.effect("should leave a channel without a live address when its row's live id is not one", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(TestYouTubeTv.recordedAt)

      const guide = yield* YouTubeTvGuide.decode(TestYouTubeTv.oneRowGuide("y6zFA17zDsw?x"))
      const availability = guide.availabilityOf(ohioStateAtIowa, guide.readAt)

      assert.deepStrictEqual(
        [availability],
        [
          {
            _tag: "Upcoming",
            channel: Option.some("News 3"),
            begin: Option.some(DateTime.makeUnsafe("2026-10-03T19:35:00Z"))
          }
        ]
      )
    })
  )

  it.effect("should log why a response could not be read, without the response", () =>
    Effect.gen(function* () {
      const logged: Array<{ readonly level: string; readonly message: string }> = []
      const collector = Logger.make(({ logLevel, message }) => {
        logged.push({ level: logLevel, message: JSON.stringify(message) })
      })
      const response = JSON.stringify({ contents: { secret: "payload" } })

      yield* YouTubeTvGuide.decode(response).pipe(Effect.flip, Effect.provide(Logger.layer([collector])))

      const warnings = logged.filter(({ level }) => level === "Warn")
      assert.strictEqual(warnings.length, 1)
      assert.include(warnings[0]?.message, "epgRenderer")
      assert.notInclude(warnings[0]?.message, "secret")
    })
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
const tallied = Effect.fn("YouTubeTvGuide.test.tallied")(function* (league: LeagueId) {
  yield* TestYouTubeTv.readRecordedGuide
  const availabilityOf = yield* TestSource.availabilityNow
  const carried: Record<string, string> = {}
  const upcomingOn: Record<string, string> = {}
  const tally = { carried, upcomingOn, upcomingUnknown: 0, streamingOnly: 0, notInGuide: 0 }
  const listed = yield* TestProvider.listedBy(league)
  for (const game of listed) {
    for (const availability of availabilityOf(game))
      ChannelAvailability.match(availability, {
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

/** YouTube TV, and ESPN giving its 2026-10-03 recordings. */
function matchingLayer() {
  const espn = TestEspn.recordedEspn({
    nfl: TestEspn.recordedScoreboard("nfl-scoreboard-pregame"),
    fbs: TestEspn.recordedScoreboard("fbs-scoreboard-2026-10-03T2024Z")
  })
  return Layer.mergeAll(youTubeTv, espn)
}
