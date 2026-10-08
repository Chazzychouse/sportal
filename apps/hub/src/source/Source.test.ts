import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { broadcast, snapshot } from "@sportal/domain/TestGame"
import { Effect, Layer, Option, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { HubConfig } from "../HubConfig.ts"
import * as EspnProvider from "../provider/espn/EspnProvider.ts"
import { FastCast } from "../provider/espn/FastCast.ts"
import { fixtures } from "../provider/espn/TestEspn.ts"
import { listedBy } from "../provider/TestProvider.ts"
import { GuideReader } from "./GuideReader.ts"
import { Source } from "./Source.ts"
import { readRecordedGuide } from "./youtube-tv/TestYouTubeTv.ts"

const youTubeTv = Source.layerYouTubeTv.pipe(Layer.provideMerge(GuideReader.layerYouTubeTv))

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
    youTubeTv,
    EspnProvider.layer.pipe(
      Layer.provide([FastCast.layerTest(Stream.never), recorded, HubConfig.layerTest({}).pipe(Layer.orDie)])
    )
  )
}

/** A recorded ESPN site scoreboard from the ESPN adapter's fixtures. */
function recordedScoreboard(name: "fbs-scoreboard-2026-10-03T2024Z" | "nfl-scoreboard-pregame") {
  return readFileSync(join(fixtures, `${name}.json`), "utf8")
}
