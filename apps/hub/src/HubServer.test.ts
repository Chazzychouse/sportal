import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { Cause, DateTime, Effect, Exit, Layer, Queue, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Broadcast } from "./Broadcast.ts"
import { Director } from "./Director.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubServer from "./HubServer.ts"
import { Delivery, Provider } from "./provider/Provider.ts"
import { isStopping } from "./Shutdown.ts"
import { Source } from "./source/Source.ts"
import * as TestHub from "./TestHub.ts"

describe("HubServer", () => {
  describe("HTTP endpoints", () => {
    it.effect("should say it is up, with its version and when it started", () =>
      served(() =>
        Effect.gen(function* () {
          const client = yield* makeClient

          const health = yield* client.host.health()

          assert.strictEqual(health.version, "1.2.3")
          assert.strictEqual(DateTime.toEpochMillis(health.startedAt), 0)
        })
      )
    )

    it.effect("should refuse a guide it cannot read", () =>
      served(() =>
        Effect.gen(function* () {
          const client = yield* makeClient

          const error = yield* client.guide.read({ payload: { guide: "{}" } }).pipe(Effect.flip)

          assert.strictEqual(error._tag, "GuideUnreadable")
        })
      )
    )

    it.effect("should not be served: the slate comes only on the live stream", () =>
      served(() =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient

          const response = yield* http.get("/api/slate")

          assert.strictEqual(response.status, 404)
        })
      )
    )
  })

  describe("GET /api/live", () => {
    describe("SSE transport", () => {
      it.effect("should stream the current slate first, as a server-sent event", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* TestHub.alaAtMsstListed(frames)

            const { response, lines } = yield* liveLines()
            const line = yield* Queue.take(lines)

            const message = messageOf(line)
            assert.strictEqual(response.headers["content-type"], "text/event-stream")
            assert.strictEqual(response.headers["cache-control"], "no-cache")
            // Each event is one line, `data: <json>`, followed by a blank line.
            assert.isTrue(line.startsWith("data: "))
            assert.strictEqual(message._tag, "SlateChanged")
            assert.deepStrictEqual(
              message.slate.games.map((game) => game.plays),
              [[]]
            )
          })
        )
      )

      it.effect("should stream each change after the current slate", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* TestHub.alaAtMsstListed(frames)
            const lines = yield* pastInitialMessages()

            yield* TestHub.offered(
              frames,
              Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
            )
            yield* TestClock.adjust("250 millis")
            const line = yield* Queue.take(lines)

            const message = messageOf(line)
            assert.isTrue(line.startsWith("data: "))
            assert.deepStrictEqual(
              message.slate.games.map((game) => game.snapshot.period),
              [2]
            )
          })
        )
      )

      it.effect("should give a connection that joins later the latest slate at once", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* TestHub.alaAtMsstListed(frames)
            yield* pastInitialMessages()
            yield* TestHub.offered(
              frames,
              Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
            )
            yield* TestClock.adjust("250 millis")

            const { lines } = yield* liveLines()
            const line = yield* Queue.take(lines)

            const message = messageOf(line)
            assert.deepStrictEqual(
              message.slate.games.map((game) => game.snapshot.period),
              [2]
            )
          })
        )
      )

      it.effect(
        "should send a keep-alive event every 20 seconds, so a proxy does not close a quiet stream",
        () =>
          served((frames) =>
            Effect.gen(function* () {
              yield* TestHub.alaAtMsstListed(frames)
              const lines = yield* pastInitialMessages()

              yield* TestClock.adjust("20 seconds")
              const keepAlive = yield* nextKeepAlive(lines)

              assert.deepStrictEqual(keepAlive, ["event: keep-alive", "data: "])
            })
          )
      )

      it.effect("should still send each change as data after a keep-alive event", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* TestHub.alaAtMsstListed(frames)
            const lines = yield* pastInitialMessages()
            yield* TestClock.adjust("20 seconds")
            yield* nextKeepAlive(lines)

            yield* TestHub.offered(
              frames,
              Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
            )
            yield* TestClock.adjust("250 millis")
            const change = yield* Queue.take(lines).pipe(
              Effect.repeat({ until: (line) => line.includes("SlateChanged") })
            )

            assert.isTrue(change.startsWith("data: "))
          })
        )
      )
    })

    describe("encoding", () => {
      it.effect(
        "should send the slate's games as their snapshots and plays, and each one's availability by its id, and nothing else the slate remembers",
        () =>
          served((frames) =>
            Effect.gen(function* () {
              yield* TestHub.alaAtMsstListed(frames)

              const { lines } = yield* liveLines()
              const line = yield* Queue.take(lines).pipe(
                Effect.repeat({ until: (line) => line.includes("SlateChanged") })
              )

              const message = JSON.parse(line.slice("data: ".length))
              const [entry] = message.slate.games
              assert.strictEqual(entry.snapshot.id, TestHub.alaAtMsst.id)
              assert.deepStrictEqual(Object.keys(message), [
                "_tag",
                "slate",
                "availability",
                "classifications"
              ])
              assert.deepStrictEqual(Object.keys(entry), ["snapshot", "plays"])
              assert.deepStrictEqual(message.availability[TestHub.alaAtMsst.id], [
                { _tag: "NoGuide", source: "YouTube TV" }
              ])
              assert.notMatch(line, /"state"|"updatedAt"|"from"/)
            })
          )
      )
    })

    describe("guide integration", () => {
      it.effect("should send the slate again within 30 seconds when a guide read carries its game", () =>
        served((frames) =>
          Effect.gen(function* () {
            const client = yield* makeClient
            yield* TestClock.setTime(DateTime.toEpochMillis(TestHub.alaAtMsst.kickoff))
            yield* TestHub.alaAtMsstListed(frames)
            const lines = yield* pastInitialMessages()
            const now = yield* DateTime.now

            yield* client.guide.read({ payload: { guide: realSizedGuideAiring(now) } })
            yield* TestClock.adjust("30 seconds")
            const line = yield* nextData(lines)

            const message = messageOf(line)
            assert.deepStrictEqual(message.availability[TestHub.alaAtMsst.id], [
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
          })
        )
      )
    })
  })
})

describe("isStopping", () => {
  it.each([
    ["an interrupt", Exit.failCause(Cause.interrupt())],
    ["a stream's end", Exit.failCause(Cause.fail(Cause.Done()))],
    [
      "an interrupt beside a stream's end",
      Exit.failCause(Cause.combine(Cause.interrupt(), Cause.fail(Cause.Done())))
    ]
  ])("should read %s as stopping", (_name, exit) => {
    const stopping = isStopping(exit)

    assert.isTrue(stopping)
  })

  it.each([
    ["a defect", Exit.failCause(Cause.combine(Cause.fail(Cause.Done()), Cause.die("boom")))],
    ["a failure", Exit.failCause(Cause.combine(Cause.fail(Cause.Done()), Cause.fail("refused")))]
  ])("should not read a stream's end beside %s as stopping", (_name, exit) => {
    const stopping = isStopping(exit)

    assert.isFalse(stopping)
  })

  it.each([
    ["a success", Exit.void],
    ["a defect alone", Exit.die("boom")]
  ])("should not read %s as stopping", (_name, exit) => {
    const stopping = isStopping(exit)

    assert.isFalse(stopping)
  })
})

function served<A, E, R>(
  test: (frames: TestHub.Frames) => Effect.Effect<A, E, R>,
  source: Layer.Layer<Source> = Source.layerYouTubeTv
) {
  return Effect.gen(function* () {
    const frames = yield* Queue.bounded<ReadonlyArray<Delivery>, Cause.Done>(1)

    return yield* test(frames).pipe(Effect.scoped, Effect.provide(serverUnderTest(frames, source)))
  })
}

function serverUnderTest(frames: TestHub.Frames, source: Layer.Layer<Source>) {
  const hub = Broadcast.layer.pipe(
    Layer.provide(Director.layer),
    Layer.provide(Provider.layerTest(frames)),
    Layer.provideMerge(source),
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_VERSION: "1.2.3" }))
  )
  return HubServer.layer.pipe(Layer.provideMerge(hub), Layer.provideMerge(NodeHttpServer.layerTest))
}

/** A client of the Hub's API, pointed at the server under test. */
const makeClient = HttpApiClient.make(SportalApi)

/** Opens the live stream: its response, and a queue of its lines that are not blank, as they arrive. */
const liveLines = Effect.fn("HubServer.test.liveLines")(function* () {
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

/** Opens the live stream and takes its first message, the current slate: the lines after it. */
const pastInitialMessages = Effect.fn("HubServer.test.pastInitialMessages")(function* () {
  const { lines } = yield* liveLines()

  yield* Queue.take(lines)

  return lines
})

/** The live message a `data: <json>` line carries. */
function messageOf(line: string): LiveMessage {
  return Schema.decodeSync(LiveMessageJson)(line.slice("data: ".length))
}

/** The next line of `lines` that carries a live message, past any keep-alive event. */
function nextData(lines: Queue.Queue<string>) {
  return Queue.take(lines).pipe(Effect.repeat({ until: (line) => line.startsWith("data: {") }))
}

/** The next keep-alive event on `lines`: its event line and its data line. */
const nextKeepAlive = Effect.fnUntraced(function* (lines: Queue.Queue<string>) {
  const event = yield* Queue.take(lines).pipe(Effect.repeat({ until: (line) => line.startsWith("event: ") }))
  const data = yield* Queue.take(lines)
  return [event, data]
})

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
