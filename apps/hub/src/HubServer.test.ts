import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { GameId, Network } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { broadcast, play, snapshot, team } from "@sportal/domain/TestGame"
import { type Cause, DateTime, Effect, Layer, Queue, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Director } from "./Director.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubServer from "./HubServer.ts"
import { Delivery, Provider } from "./provider/Provider.ts"
import { Source } from "./source/Source.ts"

const espn = Network.make("ESPN")
const game = snapshot({
  id: GameId.make("401856707"),
  status: "live",
  home: { team: team("MSST"), score: 0 },
  away: { team: team("ALA"), score: 0 },
  broadcasts: [broadcast(espn)]
})

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
            yield* firstSlateOnTestClock(frames)

            const { response, lines } = yield* liveLines()
            const line = yield* Queue.take(lines)

            const message = messageOf(line)
            assert.strictEqual(response.headers["content-type"], "text/event-stream")
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
            yield* firstSlateOnTestClock(frames)
            const lines = yield* pastInitialMessages()

            yield* delivered(frames, Delivery.Listing({ league: "fbs", games: [inPeriod(2)] }))
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
            yield* firstSlateOnTestClock(frames)
            yield* pastInitialMessages()
            yield* delivered(frames, Delivery.Listing({ league: "fbs", games: [inPeriod(2)] }))
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

      it.effect("should not read the source's availability again for a connection that joins", () =>
        Effect.gen(function* () {
          let reads = 0
          const counted = Source.layerTest(() => {
            reads += 1
            return { _tag: "NotCarried", why: "StreamingOnly" }
          })

          yield* served(
            (frames) =>
              Effect.gen(function* () {
                yield* firstSlateOnTestClock(frames)
                yield* pastInitialMessages()
                const readForOne = reads

                yield* pastInitialMessages()

                assert.strictEqual(reads, readForOne)
              }),
            counted
          )
        })
      )

      it.effect("should send a comment every 20 seconds, so a proxy does not close a quiet stream", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* firstSlateOnTestClock(frames)
            const lines = yield* pastInitialMessages()

            yield* TestClock.adjust("20 seconds")
            const comment = yield* nextComment(lines)

            assert.strictEqual(comment, ": keep-alive")
          })
        )
      )

      it.effect("should still send each change as data after a keep-alive comment", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* firstSlateOnTestClock(frames)
            const lines = yield* pastInitialMessages()
            yield* TestClock.adjust("20 seconds")
            yield* nextComment(lines)

            yield* delivered(frames, Delivery.Listing({ league: "fbs", games: [inPeriod(2)] }))
            yield* TestClock.adjust("250 millis")
            const change = yield* Queue.take(lines).pipe(
              Effect.repeat({ until: (line) => line.includes("SlateChanged") })
            )

            assert.isTrue(change.startsWith("data: "))
          })
        )
      )
    })

    describe("settling", () => {
      it.effect("should send a burst of slate changes once, when it settles", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* firstSlateOnTestClock(frames)
            const lines = yield* pastInitialMessages()
            const pushes = [2, 3, 4].map((period) =>
              Delivery.Listing({ league: "fbs", games: [inPeriod(period)] })
            )

            yield* Effect.forEach(pushes, (push) => delivered(frames, push))
            // The live stream reads each slate in turn; it reads the burst before the clock moves on.
            yield* Effect.yieldNow
            yield* TestClock.adjust("250 millis")
            const line = yield* Queue.take(lines)
            const waiting = yield* Queue.size(lines)

            const message = messageOf(line)
            assert.deepStrictEqual(
              message.slate.games.map((game) => game.snapshot.period),
              [4]
            )
            assert.strictEqual(waiting, 0)
          })
        )
      )

      it.effect("should send nothing when the 30-second recheck finds no game's availability changed", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* firstSlateOnTestClock(frames)
            const lines = yield* pastInitialMessages()

            yield* TestClock.adjust("30 seconds")
            yield* delivered(frames, Delivery.Listing({ league: "fbs", games: [inPeriod(2)] }))
            yield* TestClock.adjust("250 millis")
            const line = yield* nextData(lines)

            const message = messageOf(line)
            assert.deepStrictEqual(
              message.slate.games.map((game) => game.snapshot.period),
              [2]
            )
          })
        )
      )
    })

    describe("projection", () => {
      it.effect(
        "should send the slate's games as their snapshots and plays, and each one's availability by its id, and nothing else the slate remembers",
        () =>
          served((frames) =>
            Effect.gen(function* () {
              yield* firstSlateOnTestClock(frames)

              const { lines } = yield* liveLines()
              const line = yield* Queue.take(lines).pipe(
                Effect.repeat({ until: (line) => line.includes("SlateChanged") })
              )

              const message = JSON.parse(line.slice("data: ".length))
              const [entry] = message.slate.games
              assert.strictEqual(entry.snapshot.id, game.id)
              assert.deepStrictEqual(Object.keys(message), ["_tag", "slate", "availability"])
              assert.deepStrictEqual(Object.keys(entry), ["snapshot", "plays"])
              assert.deepStrictEqual(message.availability[game.id], [
                { _tag: "NoGuide", source: "YouTube TV" }
              ])
              assert.notMatch(line, /"state"|"updatedAt"|"from"/)
            })
          )
      )

      it.effect("should publish the listing order with leagues in their order", () =>
        served((frames) =>
          Effect.gen(function* () {
            const fbs = ["3", "1", "2"].map((id) =>
              snapshot({ id: GameId.make(id), league: "fbs", status: "live", period: 1, clock: "10:00" })
            )
            const nfl = snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })

            const message = yield* publishedAfter(frames, [
              Delivery.Listing({ league: "fbs", games: fbs }),
              Delivery.Listing({ league: "nfl", games: [nfl] })
            ])

            assert.deepStrictEqual(
              message.slate.games.map((game) => game.snapshot.id),
              ["9", "3", "1", "2"]
            )
          })
        )
      )

      it.effect("should publish the accepted snapshot rather than the original listing", () =>
        served((frames) =>
          Effect.gen(function* () {
            const first = snapshot({ id: GameId.make("1"), status: "live", period: 1, clock: "10:00" })
            const next = snapshot({ ...first, period: 2 })

            const message = yield* publishedAfter(frames, [
              Delivery.Listing({ league: "fbs", games: [first] }),
              Delivery.Listing({ league: "fbs", games: [next] })
            ])

            assert.strictEqual(message.slate.games[0]?.snapshot.period, 2)
          })
        )
      )

      it.effect("should publish each listed game's plays", () =>
        served((frames) =>
          Effect.gen(function* () {
            const listed = snapshot({ id: GameId.make("1"), status: "live" })
            const recordedPlay = play({ id: PlayId.make("p1"), sequence: 1 })

            const message = yield* publishedAfter(frames, [
              Delivery.Listing({ league: "fbs", games: [listed] }),
              Delivery.Plays({ game: listed.id, plays: [recordedPlay] })
            ])

            assert.deepStrictEqual(message.slate.games[0]?.plays, [recordedPlay])
          })
        )
      )

      it.effect("should publish only the last ten plays in sequence order", () =>
        served((frames) =>
          Effect.gen(function* () {
            const listed = snapshot({ id: GameId.make("1"), status: "live" })
            const plays = Array.from({ length: 12 }, (_, index) =>
              play({ id: PlayId.make(`p${index + 1}`), sequence: index + 1 })
            ).toReversed()

            const message = yield* publishedAfter(frames, [
              Delivery.Listing({ league: "fbs", games: [listed] }),
              Delivery.Plays({ game: listed.id, plays })
            ])

            assert.deepStrictEqual(
              message.slate.games[0]?.plays.map(({ sequence }) => sequence),
              [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
            )
          })
        )
      )

      it.effect("should publish a listed final game", () =>
        served((frames) =>
          Effect.gen(function* () {
            const final = snapshot({ id: GameId.make("1"), status: "final" })

            const message = yield* publishedAfter(frames, [
              Delivery.Listing({ league: "fbs", games: [final] })
            ])

            assert.deepStrictEqual(
              message.slate.games.map((game) => game.snapshot),
              [final]
            )
          })
        )
      )

      it.effect("should publish every source's availability for each game, by its id", () =>
        served(
          (frames) =>
            Effect.gen(function* () {
              const listed = snapshot({ id: GameId.make("1"), status: "live" })

              const message = yield* publishedAfter(frames, [
                Delivery.Listing({ league: "fbs", games: [listed] })
              ])

              assert.deepStrictEqual(message.availability[GameId.make("1")], [
                { _tag: "NotCarried", why: "StreamingOnly" },
                { _tag: "NoGuide", source: "Twitch" }
              ])
            }),
          Source.layerAll([
            Source.layerTest(() => ({ _tag: "NotCarried", why: "StreamingOnly" })),
            Source.layerTest(() => ({ _tag: "NoGuide", source: "Twitch" }))
          ])
        )
      )
    })

    describe("guide integration", () => {
      it.effect(
        "should send a game as carried once a snapshot says it has kicked off, with nothing else changing",
        () =>
          served(
            (frames) =>
              Effect.gen(function* () {
                const scheduled = snapshot({
                  id: game.id,
                  broadcasts: [broadcast("Prime Video", "streaming")]
                })
                yield* delivered(frames, Delivery.Listing({ league: "fbs", games: [scheduled] }))
                yield* TestClock.adjust("250 millis")
                const lines = yield* pastInitialMessages()

                yield* delivered(
                  frames,
                  Delivery.Listing({ league: "fbs", games: [snapshot({ ...scheduled, status: "live" })] })
                )
                yield* TestClock.adjust("250 millis")
                const line = yield* Queue.take(lines)

                const message = messageOf(line)
                assert.deepStrictEqual(
                  message.availability[game.id]?.map(({ _tag }) => _tag),
                  ["Carried"]
                )
              }),
            Source.layerTwitch
          )
      )

      it.effect("should send the slate again within 30 seconds when a guide read carries its game", () =>
        served((frames) =>
          Effect.gen(function* () {
            const client = yield* makeClient
            yield* TestClock.setTime(DateTime.toEpochMillis(game.kickoff))
            yield* firstSlateOnTestClock(frames)
            const lines = yield* pastInitialMessages()
            const now = yield* DateTime.now

            yield* client.guide.read({ payload: { guide: realSizedGuideAiring(now) } })
            yield* TestClock.adjust("30 seconds")
            const line = yield* nextData(lines)

            const message = messageOf(line)
            assert.deepStrictEqual(message.availability[game.id], [
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

/**
 * Runs `test`, scoped, against the Hub's routes served on an ephemeral port, with an HTTP client pointed at them, over
 * a provider whose frames are what the test offers `frames`, against `source` (YouTube TV unless given).
 */
function served<A, E, R>(
  test: (frames: Frames) => Effect.Effect<A, E, R>,
  source: Layer.Layer<Source> = Source.layerYouTubeTv
) {
  return Effect.gen(function* () {
    const frames = yield* Queue.bounded<ReadonlyArray<Delivery>, Cause.Done>(1)

    return yield* test(frames).pipe(Effect.scoped, Effect.provide(serverUnderTest(frames, source)))
  })
}

type Frames = Queue.Queue<ReadonlyArray<Delivery>, Cause.Done>

function serverUnderTest(frames: Frames, source: Layer.Layer<Source>) {
  const hub = Director.layer.pipe(
    Layer.provide(Provider.layerTest(frames)),
    Layer.provideMerge(source),
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_VERSION: "1.2.3" }))
  )
  return HubServer.layer.pipe(Layer.provideMerge(hub), Layer.provideMerge(NodeHttpServer.layerTest))
}

/** A client of the Hub's API, pointed at the server under test. */
const makeClient = HttpApiClient.make(SportalApi)

/**
 * Delivers one frame that says only `delivery`, returning once the Director has taken it: the second empty frame is
 * accepted only once the Director has pulled the first, which it does only after taking `delivery`.
 */
const delivered = Effect.fnUntraced(function* (frames: Frames, delivery: Delivery) {
  yield* Queue.offer(frames, [delivery])
  yield* Queue.offer(frames, [])
  yield* Queue.offer(frames, [])
})

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

/** The live message first sent after `deliveries`, with no connection open before them. */
const publishedAfter = Effect.fnUntraced(function* (frames: Frames, deliveries: ReadonlyArray<Delivery>) {
  yield* Effect.forEach(deliveries, (delivery) => delivered(frames, delivery), { discard: true })
  yield* TestClock.adjust("250 millis")
  const { lines } = yield* liveLines()
  const line = yield* Queue.take(lines)
  return messageOf(line)
})

/** `firstSlate` on the test clock, moved on 250 ms for it to settle. */
function firstSlateOnTestClock(frames: Frames) {
  return firstSlate(frames).pipe(Effect.andThen(TestClock.adjust("250 millis")))
}

/** Delivers the fbs listing of `game`, so the Director has its first games to publish. */
function firstSlate(frames: Frames) {
  return delivered(frames, Delivery.Listing({ league: "fbs", games: [game] }))
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

/** The next line of `lines` that is data. */
function nextData(lines: Queue.Queue<string>) {
  return Queue.take(lines).pipe(Effect.repeat({ until: (line) => line.startsWith("data: ") }))
}

/** The next line of `lines` that is not data. */
function nextComment(lines: Queue.Queue<string>) {
  return Queue.take(lines).pipe(Effect.repeat({ until: (line) => !line.startsWith("data: ") }))
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
