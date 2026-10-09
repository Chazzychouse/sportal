import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { GameId, Network } from "@sportal/domain/Game"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Queue, Ref, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { HubConfig } from "./HubConfig.ts"
import * as HubServer from "./HubServer.ts"
import { Delivery } from "./provider/Provider.ts"
import { GuideReader } from "./source/GuideReader.ts"
import { Source } from "./source/Source.ts"
import { delivered, directorOver } from "./TestDirector.ts"

const espn = Network.make("ESPN")
const game = snapshot({
  id: GameId.make("401856707"),
  status: "live",
  home: { team: team("MSST"), score: 0 },
  away: { team: team("ALA"), score: 0 },
  broadcasts: [broadcast(espn)]
})

const makeClient = HttpApiClient.make(SportalApi)

describe("Hub API", () => {
  it.effect("should say it is up, with its version and when it started", () =>
    Effect.gen(function* () {
      const client = yield* makeClient

      const health = yield* client.host.health()

      assert.strictEqual(health.version, "1.2.3")
      assert.strictEqual(DateTime.toEpochMillis(health.startedAt), 0)
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
  it.effect("should stream the current slate first, as a server-sent event", () =>
    Effect.gen(function* () {
      yield* firstSlateOnTestClock()

      const { response, lines } = yield* liveLines()
      const line = yield* Queue.take(lines)

      const message = messageOf(line)
      assert.strictEqual(response.headers["content-type"], "text/event-stream")
      // Each event is one line, `data: <json>`, followed by a blank line.
      assert.isTrue(line.startsWith("data: "))
      assert.strictEqual(message._tag, "SlateChanged")
      assert.deepStrictEqual(
        message.games.map(({ game }) => game.plays),
        [[]]
      )
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("should stream each change after the current slate", () =>
    Effect.gen(function* () {
      yield* firstSlateOnTestClock()
      const lines = yield* pastInitialMessages()

      yield* delivered(Delivery.Snapshot({ snapshot: inPeriod(2) }))
      yield* TestClock.adjust("250 millis")
      const line = yield* Queue.take(lines)

      const message = messageOf(line)
      assert.isTrue(line.startsWith("data: "))
      assert.deepStrictEqual(
        message.games.map(({ game }) => game.snapshot.period),
        [2]
      )
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("should send a burst of slate changes once, when it settles", () =>
    Effect.gen(function* () {
      yield* firstSlateOnTestClock()
      const lines = yield* pastInitialMessages()
      const pushes = [2, 3, 4].map((period) => Delivery.Snapshot({ snapshot: inPeriod(period) }))

      yield* Effect.forEach(pushes, (push) => delivered(push))
      // The live stream reads each slate in turn; it reads the burst before the clock moves on.
      yield* Effect.yieldNow
      yield* TestClock.adjust("250 millis")
      const line = yield* Queue.take(lines)
      const waiting = yield* Queue.size(lines)

      const message = messageOf(line)
      assert.deepStrictEqual(
        message.games.map(({ game }) => game.snapshot.period),
        [4]
      )
      assert.strictEqual(waiting, 0)
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect(
    "should send each listed game as its snapshot and plays, beside its availability, and nothing else the slate remembers",
    () =>
      Effect.gen(function* () {
        yield* firstSlateOnTestClock()

        const { lines } = yield* liveLines()
        const line = yield* Queue.take(lines).pipe(
          Effect.repeat({ until: (line) => line.includes("SlateChanged") })
        )

        const [entry] = JSON.parse(line.slice("data: ".length)).games
        assert.strictEqual(entry.game.snapshot.id, game.id)
        assert.deepStrictEqual(Object.keys(entry), ["game", "availability"])
        assert.deepStrictEqual(Object.keys(entry.game), ["snapshot", "plays"])
        assert.deepStrictEqual(entry.availability, [{ _tag: "NoGuide", source: "YouTube TV" }])
        assert.notMatch(line, /"state"|"updatedAt"|"from"/)
      }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("should give a connection that joins later the latest slate at once", () =>
    Effect.gen(function* () {
      yield* firstSlateOnTestClock()
      yield* pastInitialMessages()
      yield* delivered(Delivery.Snapshot({ snapshot: inPeriod(2) }))
      yield* TestClock.adjust("250 millis")

      const { lines } = yield* liveLines()
      const line = yield* Queue.take(lines)

      const message = messageOf(line)
      assert.deepStrictEqual(
        message.games.map(({ game }) => game.snapshot.period),
        [2]
      )
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("should read the source's availability once, however many connections there are", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0)
      const counted = Source.layerTest(
        () => ({ _tag: "NotCarried", why: "StreamingOnly" }),
        Stream.never.pipe(Stream.onStart(Ref.update(reads, (count) => count + 1)))
      )

      yield* Effect.gen(function* () {
        yield* firstSlateOnTestClock()
        yield* pastInitialMessages()
        yield* pastInitialMessages()

        assert.strictEqual(yield* Ref.get(reads), 1)
      }).pipe(Effect.scoped, Effect.provide(serverUnderTest(counted)))
    })
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
      yield* firstSlateOnTestClock()
      const lines = yield* pastInitialMessages()
      yield* TestClock.adjust("20 seconds")
      yield* nextComment(lines)

      yield* delivered(Delivery.Snapshot({ snapshot: inPeriod(2) }))
      yield* TestClock.adjust("250 millis")
      const change = yield* Queue.take(lines).pipe(
        Effect.repeat({ until: (line) => line.includes("SlateChanged") })
      )

      assert.isTrue(change.startsWith("data: "))
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("should send nothing when the source changes but no game's availability does", () =>
    Effect.gen(function* () {
      yield* firstSlateOnTestClock()
      const lines = yield* pastInitialMessages()

      yield* TestClock.adjust("1250 millis")
      yield* delivered(Delivery.Snapshot({ snapshot: inPeriod(2) }))
      yield* TestClock.adjust("250 millis")
      const line = yield* Queue.take(lines)

      const message = messageOf(line)
      assert.deepStrictEqual(
        message.games.map(({ game }) => game.snapshot.period),
        [2]
      )
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest(changingEverySecond)))
  )

  it.effect(
    "should send a game as carried once a snapshot says it has kicked off, with nothing else changing",
    () =>
      Effect.gen(function* () {
        const scheduled = snapshot({ id: game.id, broadcasts: [broadcast("Prime Video", "streaming")] })
        yield* delivered(Delivery.Listing({ league: "fbs", games: [scheduled] }))
        yield* TestClock.adjust("250 millis")
        const lines = yield* pastInitialMessages()

        yield* delivered(Delivery.Snapshot({ snapshot: snapshot({ ...scheduled, status: "live" }) }))
        yield* TestClock.adjust("250 millis")
        const line = yield* Queue.take(lines)

        const message = messageOf(line)
        assert.deepStrictEqual(
          message.games[0]?.availability.map(({ _tag }) => _tag),
          ["Carried"]
        )
      }).pipe(Effect.scoped, Effect.provide(serverUnderTest(Source.layerTwitch)))
  )

  it.live("should send the slate again when a guide read carries its game", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      yield* firstSlate()
      const lines = yield* pastInitialMessages()
      const now = yield* DateTime.now

      yield* client.guide.read({ payload: { guide: realSizedGuideAiring(now) } })
      const line = yield* Queue.take(lines).pipe(
        Effect.repeat({
          until: (line) => line.includes("SlateChanged") && line.includes('"_tag":"Carried"')
        }),
        Effect.timeout("3 seconds")
      )

      const message = messageOf(line)
      assert.deepStrictEqual(message.games[0]?.availability, [
        {
          _tag: "Carried",
          channel: {
            name: "ESPN",
            source: "YouTube TV",
            locator: {
              _tag: "WebView",
              url: "https://tv.youtube.com/watch/PFuNFGzJDE4?vp=0gEEEgIwAQ%3D%3D"
            }
          }
        }
      ])
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )
})

/** Delivers the fbs listing of `game`, so the Director has its first games to publish. */
function firstSlate() {
  return delivered(Delivery.Listing({ league: "fbs", games: [game] }))
}

/** `firstSlate` on the test clock, moved on 250 ms for it to settle. */
function firstSlateOnTestClock() {
  return firstSlate().pipe(Effect.andThen(TestClock.adjust("250 millis")))
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

/** Opens the live stream and takes its first message, the current slate: the lines after it. */
function pastInitialMessages() {
  return Effect.gen(function* () {
    const { lines } = yield* liveLines()

    yield* Queue.take(lines)

    return lines
  })
}

/** `game` live in `period`. */
function inPeriod(period: number) {
  return snapshot({
    id: game.id,
    status: "live",
    period,
    home: { team: team("MSST"), score: 0 },
    away: { team: team("ALA"), score: 0 },
    broadcasts: [broadcast(espn)]
  })
}

/** The live message a `data: <json>` line carries. */
function messageOf(line: string): LiveMessage {
  return Schema.decodeSync(LiveMessageJson)(line.slice("data: ".length))
}

/** The next line of `lines` that is not data. */
function nextComment(lines: Queue.Queue<string>) {
  return Queue.take(lines).pipe(Effect.repeat({ until: (line) => !line.startsWith("data: ") }))
}

/** A source that says it may have changed every second, though every game is always streaming only. */
const changingEverySecond = Source.layerTest(
  () => ({ _tag: "NotCarried", why: "StreamingOnly" }),
  Stream.tick("1 second")
)

/** Everything behind the API, over a provider the test feeds, against `source`. */
function hubUnderTest(source: Layer.Layer<Source, never, GuideReader>) {
  return directorOver.pipe(
    Layer.provideMerge(source),
    Layer.provideMerge(GuideReader.layerYouTubeTv),
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_VERSION: "1.2.3" }))
  )
}

/** The Hub's routes served on an ephemeral port, with an HTTP client pointed at them; YouTube TV unless `source`. */
function serverUnderTest(source: Layer.Layer<Source, never, GuideReader> = Source.layerYouTubeTv) {
  return HubServer.layer.pipe(
    Layer.provideMerge(hubUnderTest(source)),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
}
