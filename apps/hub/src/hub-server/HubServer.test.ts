import { NodeCrypto, NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { GameId, Network } from "@sportal/domain/Game"
import type { Tile } from "@sportal/domain/Stage"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Option, Queue, Result, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import * as Database from "../Database.ts"
import { FeedLog } from "../FeedLog.ts"
import * as Ingest from "../Ingest.ts"
import { Slate } from "../Slate.ts"
import { StageSessions } from "../StageSessions.ts"
import * as YouTubeTv from "../source/youtube-tv/YouTubeTv.ts"
import { polled } from "../TestFeed.ts"
import { withEnv } from "../TestHubConfig.ts"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import * as HubServer from "./HubServer.ts"

const espn = Network.make("ESPN")
const game = snapshot({
  id: GameId.make("401856707"),
  status: "live",
  home: { team: team("MSST"), score: 0 },
  away: { team: team("ALA"), score: 0 },
  broadcasts: [broadcast(espn)]
})
const noGuide = { _tag: "DataTile", game: game.id, why: { _tag: "NoGuide" } } as const

const makeClient = HttpApiClient.make(SportalApi)

describe("Hub API", () => {
  it.effect("turns an assignment with no guide read into a data tile saying so", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      yield* firstSlateOnTestClock()

      const stage = yield* client.stage.dispatch({
        payload: { command: { _tag: "Assign", tile: 0, game: game.id } }
      })
      assert.deepStrictEqual(stage.tiles[0], noGuide)

      const rejected = yield* client.stage
        .dispatch({ payload: { command: { _tag: "Clear", tile: 9 } } })
        .pipe(Effect.flip)
      assert.strictEqual(rejected._tag, "StageRejection")
    }).pipe(Effect.provide(serverUnderTest()))
  )

  it.effect("lists the addresses a Remote can reach the Hub at, none of them loopback", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const addresses = yield* client.host.addresses()
      assert.isFalse(addresses.includes("127.0.0.1"))
    }).pipe(Effect.provide(serverUnderTest()))
  )

  it.effect("says it is up, with its version and when it started", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const health = yield* client.host.health()
      assert.strictEqual(health.version, "1.2.3")
      assert.strictEqual(DateTime.toEpochMillis(health.startedAt), 0)
    }).pipe(Effect.provide(serverUnderTest()))
  )

  it.live("reads a guide the size of a real one, and a waiting tile plays once its airing is on", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      yield* firstSlate()
      yield* client.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })

      // The game's teams and network are on ESPN, on now, in this guide; padding brings it to a real response's size.
      const now = DateTime.toEpochMillis(yield* DateTime.now)
      const guide = JSON.stringify({
        contents: {
          epgRenderer: {
            paginationRenderer: {
              epgPaginationRenderer: {
                contents: [
                  {
                    epgRowRenderer: {
                      station: {
                        epgStationRenderer: {
                          stationId: "UCW7W_WAogi3qWDbO9PqOmZQ",
                          icon: { accessibility: { accessibilityData: { label: "ESPN" } } }
                        }
                      },
                      navigationEndpoint: { watchEndpoint: { videoId: "PFuNFGzJDE4" } },
                      airings: [
                        {
                          epgAiringRenderer: {
                            beginTimeMs: String(now - 3_600_000),
                            endTimeMs: String(now + 3_600_000),
                            title: { runs: [{ text: "ALA at MSST" }] }
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        },
        padding: "x".repeat(700_000)
      })
      yield* client.guide.read({ payload: { guide } })

      const tile = yield* tileOnceItIs("StreamTile")
      assert.deepStrictEqual(tile, {
        _tag: "StreamTile",
        game: game.id,
        channel: {
          name: "ESPN",
          source: "YouTube TV",
          locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/PFuNFGzJDE4?vp=0gEEEgIwAQ%3D%3D" }
        }
      })
    }).pipe(Effect.provide(serverUnderTest()))
  )

  it.effect("refuses a guide it cannot read", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const error = yield* client.guide.read({ payload: { guide: "{}" } }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "GuideUnreadable")
    }).pipe(Effect.provide(serverUnderTest()))
  )
})

describe("GET /api/slate", () => {
  it.effect("is not served: the slate comes only on the live stream", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const response = yield* http.get("/api/slate")
      assert.strictEqual(response.status, 404)
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )
})

describe("GET /api/live", () => {
  it.effect("streams the current slate and stage first, then each change, as server-sent events", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const api = yield* HttpApiClient.make(SportalApi)
      yield* firstSlateOnTestClock()

      const response = yield* http.get("/api/live")
      assert.strictEqual(response.headers["content-type"], "text/event-stream")
      const messages = response.stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line !== ""),
        Stream.map((line) => {
          // Each event is one line, `data: <json>`, followed by a blank line.
          assert.isTrue(line.startsWith("data: "))
          return Schema.decodeSync(LiveMessageJson)(line.slice("data: ".length))
        })
      )

      const received = yield* Queue.unbounded<LiveMessage>()
      yield* messages.pipe(
        Stream.runForEach((message) => Queue.offer(received, message)),
        Effect.forkScoped
      )
      // The server subscribes as the body is pulled; once both initial messages are here, it is subscribed.
      const first = yield* Queue.take(received)
      const second = yield* Queue.take(received)
      assert.sameMembers([first._tag, second._tag], ["SlateChanged", "StageChanged"])
      assert.deepStrictEqual(
        [first, second].flatMap((message) => (message._tag === "SlateChanged" ? [message.recentPlays] : [])),
        [{}]
      )

      yield* api.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })
      const third = yield* Queue.take(received)
      assert.deepStrictEqual(third._tag === "StageChanged" ? third.stage.tiles[0] : third, noGuide)
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("sends each listed game as its snapshot, and none of what the slate remembers", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      yield* firstSlateOnTestClock()

      const response = yield* http.get("/api/live")
      const lines = yield* Queue.unbounded<string>()
      yield* response.stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.includes("SlateChanged")),
        Stream.runForEach((line) => Queue.offer(lines, line)),
        Effect.forkScoped
      )
      const line = yield* Queue.take(lines)

      const [entry] = JSON.parse(line.slice("data: ".length)).slate
      assert.strictEqual(entry.id, game.id)
      assert.notMatch(line, /"plays"|"state"|"updatedAt"|"from"/)
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("sends a comment every 20 seconds, so a proxy does not close a quiet stream", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const api = yield* HttpApiClient.make(SportalApi)
      yield* firstSlateOnTestClock()

      const response = yield* http.get("/api/live")
      const lines = yield* Queue.unbounded<string>()
      yield* response.stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line !== ""),
        Stream.runForEach((line) => Queue.offer(lines, line)),
        Effect.forkScoped
      )
      yield* Queue.take(lines)
      yield* Queue.take(lines)

      // Ingest polls during these 20 seconds too; skip the data lines that causes.
      yield* TestClock.adjust("20 seconds")
      const comment = yield* Queue.take(lines).pipe(
        Effect.repeat({ until: (line) => !line.startsWith("data: ") })
      )
      assert.strictEqual(comment, ": keep-alive")

      yield* api.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })
      const change = yield* Queue.take(lines).pipe(
        Effect.repeat({ until: (line) => line.includes("StageChanged") })
      )
      assert.isTrue(change.startsWith("data: "))
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )
})

/** Waits until the Slate has published its first games. */
function firstSlate() {
  return Effect.gen(function* () {
    const slate = yield* Slate
    yield* slate.publishedChanges.pipe(
      Stream.filter((latest) => latest.games.length > 0),
      Stream.take(1),
      Stream.runDrain
    )
  })
}

/** `firstSlate` on the test clock, moved on through the first poll and the Slate's 250 ms to settle. */
function firstSlateOnTestClock() {
  return TestClock.adjust(0).pipe(
    Effect.andThen(TestClock.adjust("250 millis")),
    Effect.andThen(firstSlate())
  )
}

/** The first tile 0 the Stage shows that has the given kind; the current Stage is replayed, so this may not wait. */
function tileOnceItIs(tag: Tile["_tag"]) {
  return Effect.gen(function* () {
    const sessions = yield* StageSessions
    return yield* sessions.changes.pipe(
      Stream.filterMap((stage) => {
        const tile = stage.tiles[0]
        return tile?._tag === tag ? Result.succeed(tile) : Result.failVoid
      }),
      Stream.take(1),
      Stream.runHead,
      Effect.timeout("2 seconds"),
      Effect.map(Option.getOrThrow)
    )
  })
}

/** Everything behind the API, over a feed log in memory and a provider that always returns `game`. */
function hubUnderTest() {
  return StageSessions.layer.pipe(
    Layer.provideMerge(YouTubeTv.layer),
    Layer.provideMerge(Ingest.layer),
    Layer.provideMerge(
      Slate.layer.pipe(
        Layer.provideMerge(FeedLog.layer.pipe(Layer.provide([Database.at(":memory:"), NodeCrypto.layer]))),
        Layer.provide([TestSnapshotFeed.decoder, DateTime.layerCurrentZoneLocal])
      )
    ),
    Layer.provide(polled(() => Effect.succeed([game]))),
    Layer.provideMerge(
      withEnv({ SPORTAL_VERSION: "1.2.3", SPORTAL_DATA_DIR: "unused", SPORTAL_LEAGUES: "fbs" })
    )
  )
}

/** The Hub's routes served on an ephemeral port, with an HTTP client pointed at them. */
function serverUnderTest() {
  return HubServer.serve.pipe(
    Layer.provideMerge(hubUnderTest()),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
}
