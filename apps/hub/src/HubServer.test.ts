import { assert, describe, it } from "@effect/vitest"
import { GameId, Network } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { broadcast, play, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Queue, Ref, Stream } from "effect"
import { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { Delivery } from "./provider/Provider.ts"
import { Source } from "./source/Source.ts"
import * as TestDirector from "./TestDirector.ts"
import * as TestHubServer from "./TestHubServer.ts"

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
      Effect.gen(function* () {
        const client = yield* TestHubServer.makeClient

        const health = yield* client.host.health()

        assert.strictEqual(health.version, "1.2.3")
        assert.strictEqual(DateTime.toEpochMillis(health.startedAt), 0)
      }).pipe(Effect.provide(TestHubServer.serverUnderTest()))
    )

    it.effect("should refuse a guide it cannot read", () =>
      Effect.gen(function* () {
        const client = yield* TestHubServer.makeClient

        const error = yield* client.guide.read({ payload: { guide: "{}" } }).pipe(Effect.flip)

        assert.strictEqual(error._tag, "GuideUnreadable")
      }).pipe(Effect.provide(TestHubServer.serverUnderTest()))
    )

    it.effect("should not be served: the slate comes only on the live stream", () =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient

        const response = yield* http.get("/api/slate")

        assert.strictEqual(response.status, 404)
      }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
    )
  })

  describe("GET /api/live", () => {
    describe("SSE transport", () => {
      it.effect("should stream the current slate first, as a server-sent event", () =>
        Effect.gen(function* () {
          yield* firstSlateOnTestClock()

          const { response, lines } = yield* TestHubServer.liveLines()
          const line = yield* Queue.take(lines)

          const message = TestHubServer.messageOf(line)
          assert.strictEqual(response.headers["content-type"], "text/event-stream")
          // Each event is one line, `data: <json>`, followed by a blank line.
          assert.isTrue(line.startsWith("data: "))
          assert.strictEqual(message._tag, "SlateChanged")
          assert.deepStrictEqual(
            message.slate.games.map((game) => game.plays),
            [[]]
          )
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )

      it.effect("should stream each change after the current slate", () =>
        Effect.gen(function* () {
          yield* firstSlateOnTestClock()
          const lines = yield* TestHubServer.pastInitialMessages()

          yield* TestDirector.delivered(Delivery.Listing({ league: "fbs", games: [inPeriod(2)] }))
          yield* TestClock.adjust("250 millis")
          const line = yield* Queue.take(lines)

          const message = TestHubServer.messageOf(line)
          assert.isTrue(line.startsWith("data: "))
          assert.deepStrictEqual(
            message.slate.games.map((game) => game.snapshot.period),
            [2]
          )
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )

      it.effect("should give a connection that joins later the latest slate at once", () =>
        Effect.gen(function* () {
          yield* firstSlateOnTestClock()
          yield* TestHubServer.pastInitialMessages()
          yield* TestDirector.delivered(Delivery.Listing({ league: "fbs", games: [inPeriod(2)] }))
          yield* TestClock.adjust("250 millis")

          const { lines } = yield* TestHubServer.liveLines()
          const line = yield* Queue.take(lines)

          const message = TestHubServer.messageOf(line)
          assert.deepStrictEqual(
            message.slate.games.map((game) => game.snapshot.period),
            [2]
          )
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
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
            yield* TestHubServer.pastInitialMessages()
            yield* TestHubServer.pastInitialMessages()

            const read = yield* Ref.get(reads)

            assert.strictEqual(read, 1)
          }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest(counted)))
        })
      )

      it.effect("should send a comment every 20 seconds, so a proxy does not close a quiet stream", () =>
        Effect.gen(function* () {
          yield* firstSlateOnTestClock()
          const lines = yield* TestHubServer.pastInitialMessages()

          yield* TestClock.adjust("20 seconds")
          const comment = yield* nextComment(lines)

          assert.strictEqual(comment, ": keep-alive")
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )

      it.effect("should still send each change as data after a keep-alive comment", () =>
        Effect.gen(function* () {
          yield* firstSlateOnTestClock()
          const lines = yield* TestHubServer.pastInitialMessages()
          yield* TestClock.adjust("20 seconds")
          yield* nextComment(lines)

          yield* TestDirector.delivered(Delivery.Listing({ league: "fbs", games: [inPeriod(2)] }))
          yield* TestClock.adjust("250 millis")
          const change = yield* Queue.take(lines).pipe(
            Effect.repeat({ until: (line) => line.includes("SlateChanged") })
          )

          assert.isTrue(change.startsWith("data: "))
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )
    })

    describe("settling", () => {
      it.effect("should send a burst of slate changes once, when it settles", () =>
        Effect.gen(function* () {
          yield* firstSlateOnTestClock()
          const lines = yield* TestHubServer.pastInitialMessages()
          const pushes = [2, 3, 4].map((period) =>
            Delivery.Listing({ league: "fbs", games: [inPeriod(period)] })
          )

          yield* Effect.forEach(pushes, (push) => TestDirector.delivered(push))
          // The live stream reads each slate in turn; it reads the burst before the clock moves on.
          yield* Effect.yieldNow
          yield* TestClock.adjust("250 millis")
          const line = yield* Queue.take(lines)
          const waiting = yield* Queue.size(lines)

          const message = TestHubServer.messageOf(line)
          assert.deepStrictEqual(
            message.slate.games.map((game) => game.snapshot.period),
            [4]
          )
          assert.strictEqual(waiting, 0)
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )

      it.effect("should send nothing when the source changes but no game's availability does", () =>
        Effect.gen(function* () {
          yield* firstSlateOnTestClock()
          const lines = yield* TestHubServer.pastInitialMessages()

          yield* TestClock.adjust("1250 millis")
          yield* TestDirector.delivered(Delivery.Listing({ league: "fbs", games: [inPeriod(2)] }))
          yield* TestClock.adjust("250 millis")
          const line = yield* Queue.take(lines)

          const message = TestHubServer.messageOf(line)
          assert.deepStrictEqual(
            message.slate.games.map((game) => game.snapshot.period),
            [2]
          )
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest(changingEverySecond)))
      )
    })

    describe("projection", () => {
      it.effect(
        "should send the slate's games as their snapshots and plays, and each one's availability by its id, and nothing else the slate remembers",
        () =>
          Effect.gen(function* () {
            yield* firstSlateOnTestClock()

            const { lines } = yield* TestHubServer.liveLines()
            const line = yield* Queue.take(lines).pipe(
              Effect.repeat({ until: (line) => line.includes("SlateChanged") })
            )

            const message = JSON.parse(line.slice("data: ".length))
            const [entry] = message.slate.games
            assert.strictEqual(entry.snapshot.id, game.id)
            assert.deepStrictEqual(Object.keys(message), ["_tag", "slate", "availability"])
            assert.deepStrictEqual(Object.keys(entry), ["snapshot", "plays"])
            assert.deepStrictEqual(message.availability[game.id], [{ _tag: "NoGuide", source: "YouTube TV" }])
            assert.notMatch(line, /"state"|"updatedAt"|"from"/)
          }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )

      it.effect("should publish the listing order with leagues in their order", () =>
        Effect.gen(function* () {
          const fbs = ["3", "1", "2"].map((id) =>
            snapshot({ id: GameId.make(id), league: "fbs", status: "live", period: 1, clock: "10:00" })
          )
          const nfl = snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })

          const message = yield* TestHubServer.publishedAfter([
            Delivery.Listing({ league: "fbs", games: fbs }),
            Delivery.Listing({ league: "nfl", games: [nfl] })
          ])

          assert.deepStrictEqual(
            message.slate.games.map((game) => game.snapshot.id),
            ["9", "3", "1", "2"]
          )
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )

      it.effect("should publish the accepted snapshot rather than the original listing", () =>
        Effect.gen(function* () {
          const first = snapshot({ id: GameId.make("1"), status: "live", period: 1, clock: "10:00" })
          const next = snapshot({ ...first, period: 2 })

          const message = yield* TestHubServer.publishedAfter([
            Delivery.Listing({ league: "fbs", games: [first] }),
            Delivery.Listing({ league: "fbs", games: [next] })
          ])

          assert.strictEqual(message.slate.games[0]?.snapshot.period, 2)
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )

      it.effect("should publish each listed game's plays", () =>
        Effect.gen(function* () {
          const listed = snapshot({ id: GameId.make("1"), status: "live" })
          const recordedPlay = play({ id: PlayId.make("p1"), sequence: 1 })

          const message = yield* TestHubServer.publishedAfter([
            Delivery.Listing({ league: "fbs", games: [listed] }),
            Delivery.Plays({ game: listed.id, plays: [recordedPlay] })
          ])

          assert.deepStrictEqual(message.slate.games[0]?.plays, [recordedPlay])
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )

      it.effect("should publish only the last ten plays in sequence order", () =>
        Effect.gen(function* () {
          const listed = snapshot({ id: GameId.make("1"), status: "live" })
          const plays = Array.from({ length: 12 }, (_, index) =>
            play({ id: PlayId.make(`p${index + 1}`), sequence: index + 1 })
          ).toReversed()

          const message = yield* TestHubServer.publishedAfter([
            Delivery.Listing({ league: "fbs", games: [listed] }),
            Delivery.Plays({ game: listed.id, plays })
          ])

          assert.deepStrictEqual(
            message.slate.games[0]?.plays.map(({ sequence }) => sequence),
            [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
          )
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )

      it.effect("should publish a listed final game", () =>
        Effect.gen(function* () {
          const final = snapshot({ id: GameId.make("1"), status: "final" })

          const message = yield* TestHubServer.publishedAfter([
            Delivery.Listing({ league: "fbs", games: [final] })
          ])

          assert.deepStrictEqual(
            message.slate.games.map((game) => game.snapshot),
            [final]
          )
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )

      it.effect("should publish every source's availability for each game, by its id", () =>
        Effect.gen(function* () {
          const listed = snapshot({ id: GameId.make("1"), status: "live" })

          const message = yield* TestHubServer.publishedAfter([
            Delivery.Listing({ league: "fbs", games: [listed] })
          ])

          assert.deepStrictEqual(message.availability[GameId.make("1")], [
            { _tag: "NotCarried", why: "StreamingOnly" },
            { _tag: "NoGuide", source: "Twitch" }
          ])
        }).pipe(
          Effect.scoped,
          Effect.provide(
            TestHubServer.serverUnderTest(
              Source.layerAll([
                Source.layerTest(() => ({ _tag: "NotCarried", why: "StreamingOnly" })),
                Source.layerTest(() => ({ _tag: "NoGuide", source: "Twitch" }))
              ])
            )
          )
        )
      )
    })

    describe("guide integration", () => {
      it.effect(
        "should send a game as carried once a snapshot says it has kicked off, with nothing else changing",
        () =>
          Effect.gen(function* () {
            const scheduled = snapshot({ id: game.id, broadcasts: [broadcast("Prime Video", "streaming")] })
            yield* TestDirector.delivered(Delivery.Listing({ league: "fbs", games: [scheduled] }))
            yield* TestClock.adjust("250 millis")
            const lines = yield* TestHubServer.pastInitialMessages()

            yield* TestDirector.delivered(
              Delivery.Listing({ league: "fbs", games: [snapshot({ ...scheduled, status: "live" })] })
            )
            yield* TestClock.adjust("250 millis")
            const line = yield* Queue.take(lines)

            const message = TestHubServer.messageOf(line)
            assert.deepStrictEqual(
              message.availability[game.id]?.map(({ _tag }) => _tag),
              ["Carried"]
            )
          }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest(Source.layerTwitch)))
      )

      it.live("should send the slate again when a guide read carries its game", () =>
        Effect.gen(function* () {
          const client = yield* TestHubServer.makeClient
          yield* firstSlate()
          const lines = yield* TestHubServer.pastInitialMessages()
          const now = yield* DateTime.now

          yield* client.guide.read({ payload: { guide: realSizedGuideAiring(now) } })
          const line = yield* Queue.take(lines).pipe(
            Effect.repeat({
              until: (line) => line.includes("SlateChanged") && line.includes('"_tag":"Carried"')
            }),
            Effect.timeout("3 seconds")
          )

          const message = TestHubServer.messageOf(line)
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
        }).pipe(Effect.scoped, Effect.provide(TestHubServer.serverUnderTest()))
      )
    })
  })
})

/** `firstSlate` on the test clock, moved on 250 ms for it to settle. */
function firstSlateOnTestClock() {
  return firstSlate().pipe(Effect.andThen(TestClock.adjust("250 millis")))
}

/** Delivers the fbs listing of `game`, so the Director has its first games to publish. */
function firstSlate() {
  return TestDirector.delivered(Delivery.Listing({ league: "fbs", games: [game] }))
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

/** The next line of `lines` that is not data. */
function nextComment(lines: Queue.Queue<string>) {
  return Queue.take(lines).pipe(Effect.repeat({ until: (line) => !line.startsWith("data: ") }))
}

/** A source that says it may have changed every second, though every game is always streaming only. */
const changingEverySecond = Source.layerTest(
  () => ({ _tag: "NotCarried", why: "StreamingOnly" }),
  Stream.tick("1 second")
)

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
