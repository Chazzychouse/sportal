import { NodeHttpServer, NodePath } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { GameId, Network } from "@sportal/domain/Game"
import type { Tile } from "@sportal/domain/Stage"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { ConfigProvider, DateTime, Effect, Layer, Option, Queue, Result, Schema, Stream } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/http"
import { HttpApiClient, HttpApiTest } from "effect/http-api"
import { TestClock } from "effect/testing"
import * as Database from "../database/Database.ts"
import { HubConfig } from "../HubConfig.ts"
import { Ingest } from "../ingest/Ingest.ts"
import { Provider } from "../provider/Provider.ts"
import { Slate } from "../Slate.ts"
import * as SqlChannelStore from "../source/SqlChannelStore.ts"
import * as YouTubeTv from "../source/youtube-tv/YouTubeTv.ts"
import { StageSessions } from "../stage/StageSessions.ts"
import * as TestCluster from "../TestCluster.ts"
import * as HubServer from "./HubServer.ts"

const espn = Network.make("ESPN")
const espnLive = "https://tv.youtube.com/watch/espn?vp=0gEEEgIwAQ%3D%3D"
const game = snapshot({
  id: GameId.make("401856707"),
  status: "live",
  home: { team: team("MSST"), score: 0 },
  away: { team: team("ALA"), score: 0 },
  broadcasts: [broadcast(espn)]
})
const picking = {
  _tag: "PickingChannel",
  game: game.id,
  network: espn,
  source: "YouTube TV",
  guide: { _tag: "WebView", url: "https://tv.youtube.com/live" }
} as const
const streaming = {
  _tag: "StreamTile",
  game: game.id,
  channel: { name: espn, source: "YouTube TV", locator: { _tag: "WebView", url: espnLive } },
  learnedFor: espn
} as const

const makeClient = HttpApiTest.groups(SportalApi, ["slate", "stage", "channels", "guide", "host"])

describe("Hub API", () => {
  it.effect("serves the slate and turns an assignment on an unlearned network into a picking tile", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      yield* firstSlateOnTestClock()

      const slate = yield* client.slate.current()
      assert.strictEqual(slate[0]?.away.team.abbreviation, "ALA")
      assert.isTrue(DateTime.isDateTime(slate[0]?.kickoff))

      const stage = yield* client.stage.dispatch({
        payload: { command: { _tag: "Assign", tile: 0, game: game.id } }
      })
      assert.deepStrictEqual(stage.tiles[0], picking)

      const rejected = yield* client.stage
        .dispatch({ payload: { command: { _tag: "Clear", tile: 9 } } })
        .pipe(Effect.flip)
      assert.strictEqual(rejected._tag, "StageRejection")
    }).pipe(Effect.provide(apiUnderTest()))
  )

  it.live("learns a channel, and the picking tile becomes a stream tile", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const sessions = yield* StageSessions
      yield* firstSlate()
      yield* client.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })

      // The Stage refreshes on its own fiber after each change, so wait for the tile rather than assume timing.
      yield* client.channels.learn({ payload: { network: espn, url: "https://tv.youtube.com/watch/espn" } })
      assert.deepStrictEqual(yield* tileOnceItIs(sessions, "StreamTile"), streaming)

      yield* client.channels.forget({ payload: { network: espn } })
      assert.deepStrictEqual(yield* tileOnceItIs(sessions, "PickingChannel"), picking)

      yield* client.channels.notCarried({ payload: { network: espn } })
      assert.deepStrictEqual(yield* tileOnceItIs(sessions, "DataTile"), {
        _tag: "DataTile",
        game: game.id,
        why: { _tag: "NoStream" }
      })
    }).pipe(Effect.provide(apiUnderTest()))
  )

  it.effect("lists the addresses a Remote can reach the Hub at, none of them loopback", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const addresses = yield* client.host.addresses()
      assert.isFalse(addresses.includes("127.0.0.1"))
    }).pipe(Effect.provide(apiUnderTest()))
  )

  it.effect("says it is up, with its version and when it started", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const health = yield* client.host.health()
      assert.strictEqual(health.version, "1.2.3")
      assert.strictEqual(DateTime.toEpochMillis(health.startedAt), 0)
    }).pipe(Effect.provide(apiUnderTest()))
  )

  it.effect("refuses to learn an address that is not a channel", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const error = yield* client.channels
        .learn({ payload: { network: espn, url: "https://tv.youtube.com/live" } })
        .pipe(Effect.flip)
      assert.strictEqual(error._tag, "ChannelUrlRefused")
    }).pipe(Effect.provide(apiUnderTest()))
  )

  it.live("reads a guide the size of a real one, and a waiting tile plays once its airing is on", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const sessions = yield* StageSessions
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

      const tile = yield* tileOnceItIs(sessions, "StreamTile")
      assert.deepStrictEqual(tile, {
        _tag: "StreamTile",
        game: game.id,
        channel: {
          name: "ESPN",
          source: "YouTube TV",
          locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/PFuNFGzJDE4?vp=0gEEEgIwAQ%3D%3D" }
        }
      })
    }).pipe(Effect.provide(apiUnderTest()))
  )

  it.effect("refuses a guide it cannot read", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const error = yield* client.guide.read({ payload: { guide: "{}" } }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "GuideUnreadable")
    }).pipe(Effect.provide(apiUnderTest()))
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
          return Schema.decodeUnknownSync(LiveMessageJson)(line.slice("data: ".length))
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

      yield* api.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })
      const third = yield* Queue.take(received)
      assert.deepStrictEqual(third._tag === "StageChanged" ? third.stage.tiles[0] : third, picking)
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
    yield* slate.changes.pipe(
      Stream.filter((latest) => latest.slate.length > 0),
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
function tileOnceItIs(sessions: typeof StageSessions.Service, tag: Tile["_tag"]) {
  return sessions.changes.pipe(
    Stream.filterMap((stage) => {
      const tile = stage.tiles[0]
      return tile?._tag === tag ? Result.succeed(tile) : Result.failVoid
    }),
    Stream.take(1),
    Stream.runHead,
    Effect.timeout("2 seconds"),
    Effect.map(Option.getOrThrow)
  )
}

function apiUnderTest() {
  return HubServer.ApiHandlers.pipe(
    Layer.provideMerge(hubUnderTest()),
    Layer.provideMerge(HttpServer.layerServices)
  )
}

/** Everything behind the API, over a fresh in-memory database and a provider that always returns `game`. */
function hubUnderTest() {
  return StageSessions.layer.pipe(
    Layer.provideMerge(YouTubeTv.layer),
    Layer.provide(SqlChannelStore.layer),
    Layer.provide(Database.layer(":memory:")),
    Layer.provideMerge(Slate.layer),
    Layer.provideMerge(Ingest.layer(["fbs"])),
    Layer.provide([
      Layer.succeed(Provider, Provider.of({ slate: () => Effect.succeed([game]) })),
      TestCluster.gameActors
    ]),
    Layer.provideMerge(testConfig())
  )
}

function testConfig() {
  return HubConfig.layer.pipe(
    Layer.provide([
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { SPORTAL_VERSION: "1.2.3", SPORTAL_DATA_DIR: "unused" } })
      ),
      NodePath.layer
    ])
  )
}

/** The Hub's routes served on an ephemeral port, with an HTTP client pointed at them. */
function serverUnderTest() {
  return HttpRouter.serve(HubServer.layer, { disableLogger: true }).pipe(
    Layer.provideMerge(hubUnderTest()),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
}
