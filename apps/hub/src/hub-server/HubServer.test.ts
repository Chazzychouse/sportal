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
import { LiveSlate } from "../LiveSlate.ts"
import { LiveStage } from "../LiveStage.ts"
import * as YouTubeTv from "../source/youtube-tv/YouTubeTv.ts"
import { withEnv } from "../TestHubConfig.ts"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import { polled } from "../TestSnapshotFeed.ts"
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
  it.effect("should turn an assignment with no guide read into a data tile saying so", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      yield* firstSlateOnTestClock()

      const stage = yield* client.stage.dispatch({
        payload: { command: { _tag: "Assign", tile: 0, game: game.id } }
      })

      assert.deepStrictEqual(stage.tiles[0], noGuide)
    }).pipe(Effect.provide(serverUnderTest()))
  )

  it.effect("should reject a command for a missing tile", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      yield* firstSlateOnTestClock()

      const rejected = yield* client.stage
        .dispatch({ payload: { command: { _tag: "Clear", tile: 9 } } })
        .pipe(Effect.flip)

      assert.strictEqual(rejected._tag, "StageRejection")
    }).pipe(Effect.provide(serverUnderTest()))
  )

  it.effect("should list the addresses a Remote can reach the Hub at, none of them loopback", () =>
    Effect.gen(function* () {
      const client = yield* makeClient

      const addresses = yield* client.host.addresses()

      assert.isFalse(addresses.includes("127.0.0.1"))
    }).pipe(Effect.provide(serverUnderTest()))
  )

  it.effect("should say it is up, with its version and when it started", () =>
    Effect.gen(function* () {
      const client = yield* makeClient

      const health = yield* client.host.health()

      assert.strictEqual(health.version, "1.2.3")
      assert.strictEqual(DateTime.toEpochMillis(health.startedAt), 0)
    }).pipe(Effect.provide(serverUnderTest()))
  )

  it.live("should read a guide the size of a real one, playing a waiting tile once its airing is on", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      yield* firstSlate()
      yield* client.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })
      const now = yield* DateTime.now
      const guide = realSizedGuideAiring(now)

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

  it.effect("should refuse a guide it cannot read", () =>
    Effect.gen(function* () {
      const client = yield* makeClient

      const error = yield* client.guide.read({ payload: { guide: "{}" } }).pipe(Effect.flip)

      assert.strictEqual(error._tag, "GuideUnreadable")
    }).pipe(Effect.provide(serverUnderTest()))
  )
})

describe("GET /api/slate", () => {
  it.effect("should not be served: the slate comes only on the live stream", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient

      const response = yield* http.get("/api/slate")

      assert.strictEqual(response.status, 404)
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )
})

describe("GET /api/live", () => {
  it.effect("should stream the current slate and stage first, as server-sent events", () =>
    Effect.gen(function* () {
      yield* firstSlateOnTestClock()

      const { response, lines } = yield* liveLines()
      // The server subscribes as the body is pulled; once both initial messages are here, it is subscribed.
      const firstLine = yield* Queue.take(lines)
      const secondLine = yield* Queue.take(lines)

      const first = messageOf(firstLine)
      const second = messageOf(secondLine)
      assert.strictEqual(response.headers["content-type"], "text/event-stream")
      // Each event is one line, `data: <json>`, followed by a blank line.
      assert.isTrue(firstLine.startsWith("data: "))
      assert.isTrue(secondLine.startsWith("data: "))
      assert.sameMembers([first._tag, second._tag], ["SlateChanged", "StageChanged"])
      assert.deepStrictEqual(
        [first, second].flatMap((message) => (message._tag === "SlateChanged" ? [message.recentPlays] : [])),
        [{}]
      )
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("should stream each change after the current slate and stage", () =>
    Effect.gen(function* () {
      const api = yield* makeClient
      yield* firstSlateOnTestClock()
      const lines = yield* pastInitialMessages()

      yield* api.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })
      const thirdLine = yield* Queue.take(lines)

      const third = messageOf(thirdLine)
      assert.isTrue(thirdLine.startsWith("data: "))
      assert.deepStrictEqual(third._tag === "StageChanged" ? third.stage.tiles[0] : third, noGuide)
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("should send each listed game as its snapshot, and none of what the slate remembers", () =>
    Effect.gen(function* () {
      yield* firstSlateOnTestClock()

      const { lines } = yield* liveLines()
      const line = yield* Queue.take(lines).pipe(
        Effect.repeat({ until: (line) => line.includes("SlateChanged") })
      )

      const [entry] = JSON.parse(line.slice("data: ".length)).slate
      assert.strictEqual(entry.id, game.id)
      assert.notMatch(line, /"plays"|"state"|"updatedAt"|"from"/)
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("should send a comment every 20 seconds, so a proxy does not close a quiet stream", () =>
    Effect.gen(function* () {
      yield* firstSlateOnTestClock()
      const lines = yield* pastInitialMessages()

      yield* TestClock.adjust("20 seconds")
      const comment = yield* nextComment(lines)

      assert.strictEqual(comment, ": keep-alive")
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("should still send each change as data after a keep-alive comment", () =>
    Effect.gen(function* () {
      const api = yield* makeClient
      yield* firstSlateOnTestClock()
      const lines = yield* pastInitialMessages()
      yield* TestClock.adjust("20 seconds")
      yield* nextComment(lines)

      yield* api.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })
      const change = yield* Queue.take(lines).pipe(
        Effect.repeat({ until: (line) => line.includes("StageChanged") })
      )

      assert.isTrue(change.startsWith("data: "))
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )
})

/** Waits until the LiveSlate has published its first games. */
function firstSlate() {
  return Effect.gen(function* () {
    const slate = yield* LiveSlate
    yield* slate.publishedChanges.pipe(
      Stream.filter((latest) => latest.games.length > 0),
      Stream.take(1),
      Stream.runDrain
    )
  })
}

/** `firstSlate` on the test clock, moved on through the first poll and the LiveSlate's 250 ms to settle. */
function firstSlateOnTestClock() {
  return TestClock.adjust(0).pipe(
    Effect.andThen(TestClock.adjust("250 millis")),
    Effect.andThen(firstSlate())
  )
}

/**
 * A guide with the game's teams and network on ESPN, on at `now`; padding brings it to a real response's size.
 */
function realSizedGuideAiring(now: DateTime.Utc) {
  const at = DateTime.toEpochMillis(now)
  return JSON.stringify({
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
                        beginTimeMs: String(at - 3_600_000),
                        endTimeMs: String(at + 3_600_000),
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
}

/** The first tile 0 the Stage shows that has the given kind; the current Stage is replayed, so this may not wait. */
function tileOnceItIs(tag: Tile["_tag"]) {
  return Effect.gen(function* () {
    const liveStage = yield* LiveStage

    return yield* liveStage.changes.pipe(
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

/** Opens the live stream: its response, and a queue of its lines that are not blank, as they arrive. */
function liveLines() {
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const lines = yield* Queue.unbounded<string>()

    const response = yield* http.get("/api/live")
    yield* response.stream.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line !== ""),
      Stream.runForEach((line) => Queue.offer(lines, line)),
      Effect.forkScoped
    )

    return { response, lines }
  })
}

/** Opens the live stream and takes its first two messages, the current slate and stage: the lines after them. */
function pastInitialMessages() {
  return Effect.gen(function* () {
    const { lines } = yield* liveLines()

    yield* Queue.take(lines)
    yield* Queue.take(lines)

    return lines
  })
}

/** The live message a `data: <json>` line carries. */
function messageOf(line: string): LiveMessage {
  return Schema.decodeSync(LiveMessageJson)(line.slice("data: ".length))
}

/** The next line of `lines` that is not data. Ingest polls while the clock moves, so data lines come between. */
function nextComment(lines: Queue.Queue<string>) {
  return Queue.take(lines).pipe(Effect.repeat({ until: (line) => !line.startsWith("data: ") }))
}

/** Everything behind the API, over a feed log in memory and a provider that always returns `game`. */
function hubUnderTest() {
  return LiveStage.layer.pipe(
    Layer.provideMerge(YouTubeTv.layer),
    Layer.provideMerge(Ingest.layer),
    Layer.provideMerge(
      LiveSlate.layer.pipe(
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
