import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DisplayId } from "@sportal/api/DisplayId"
import { type GameList, GameListJson } from "@sportal/api/GamesQuery"
import { type RemoteMessage, RemoteMessageJson } from "@sportal/api/RemoteMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { GameId, PlaysChange } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Cause, DateTime, Effect, Exit, Layer, Queue, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { afterEach, vi } from "vitest"
import { Director } from "./Director.ts"
import { Displays } from "./Displays.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubServer from "./HubServer.ts"
import { Delivery, Provider } from "./provider/Provider.ts"
import { Schedule } from "./Schedule.ts"
import { isStopping } from "./Shutdown.ts"
import { Source } from "./source/Source.ts"
import * as TestHub from "./TestHub.ts"

type Interfaces = Record<
  string,
  ReadonlyArray<{ address: string; family: string; internal: boolean }> | undefined
>

const network = vi.hoisted((): { interfaces: Interfaces | undefined } => ({ interfaces: undefined }))
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, networkInterfaces: () => network.interfaces ?? actual.networkInterfaces() }
})

afterEach(() => {
  network.interfaces = undefined
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
  })

  describe("GET /api/games", () => {
    it.effect("should answer today's games as JSON", () =>
      served((frames) =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          yield* TestHub.alaAtMsstListed(frames)

          const response = yield* http.get("/api/games")
          const body = yield* response.text
          const answer = yield* Schema.decodeEffect(GameListJson)(body)

          assert.include(response.headers["content-type"], "application/json")
          assert.strictEqual(answer.date, "2026-10-03")
          assert.deepStrictEqual(
            answer.games.map(({ snapshot }) => snapshot.id),
            [TestHub.alaAtMsst.id]
          )
        })
      )
    )

    it.effect("should read leagues from a comma list", () =>
      served((frames) =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient
          const nfl = snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          yield* TestHub.offered(frames, Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsst] }))
          yield* TestHub.offered(frames, Delivery.Listing({ league: "nfl", games: [nfl] }))

          const response = yield* http.get("/api/games?league=mlb,nfl")
          const body = yield* response.text
          const answer = yield* Schema.decodeEffect(GameListJson)(body)

          assert.deepStrictEqual(
            answer.games.map(({ snapshot }) => snapshot.id),
            [nfl.id]
          )
        })
      )
    )

    it.effect("should refuse a malformed date with 400", () =>
      served(() =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient

          const response = yield* http.get("/api/games?date=tomorrow")

          assert.strictEqual(response.status, 400)
        })
      )
    )

    it.effect("should answer 503 when the provider cannot list the day", () =>
      served(() =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)

          const response = yield* http.get("/api/games?date=2026-10-04")

          assert.strictEqual(response.status, 503)
        })
      )
    )
  })

  describe("GET /api/games/live", () => {
    it.effect("should send the current answer first, as a server-sent event", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          yield* TestHub.alaAtMsstListed(frames)

          const { response, lines } = yield* sseLines("/api/games/live")
          const line = yield* Queue.take(lines)

          assert.strictEqual(response.headers["content-type"], "text/event-stream")
          assert.strictEqual(response.headers["cache-control"], "no-cache")
          // Each event is one line, `data: <json>`, followed by a blank line.
          assert.isTrue(line.startsWith("data: "))
          assert.deepStrictEqual(
            gameListOf(line).games.map(({ snapshot }) => snapshot.id),
            [TestHub.alaAtMsst.id]
          )
        })
      )
    )

    it.effect("should send the answer again when a listing changes it", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          yield* TestHub.alaAtMsstListed(frames)
          const { lines } = yield* sseLines("/api/games/live")
          yield* Queue.take(lines)

          yield* TestHub.offered(
            frames,
            Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
          )
          yield* TestClock.adjust("250 millis")
          const line = yield* nextData(lines)

          assert.deepStrictEqual(
            gameListOf(line).games.map(({ snapshot }) => snapshot.period),
            [2]
          )
        })
      )
    )

    it.effect("should give a connection that joins later the latest answer at once", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          yield* TestHub.alaAtMsstListed(frames)
          yield* pastInitialMessages()
          yield* TestHub.offered(
            frames,
            Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
          )
          yield* TestClock.adjust("250 millis")

          const { lines } = yield* sseLines("/api/games/live")
          const line = yield* Queue.take(lines)

          assert.deepStrictEqual(
            gameListOf(line).games.map(({ snapshot }) => snapshot.period),
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
            yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
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
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          yield* TestHub.alaAtMsstListed(frames)
          const lines = yield* pastInitialMessages()
          yield* TestClock.adjust("20 seconds")
          yield* nextKeepAlive(lines)

          yield* TestHub.offered(
            frames,
            Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
          )
          yield* TestClock.adjust("250 millis")
          const change = yield* nextData(lines)

          assert.deepStrictEqual(
            gameListOf(change).games.map(({ snapshot }) => snapshot.period),
            [2]
          )
        })
      )
    )

    it.effect("should send each game as its snapshot and its availability, and nothing else", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          yield* TestHub.alaAtMsstListed(frames)

          const { lines } = yield* sseLines("/api/games/live")
          const line = yield* nextData(lines)

          const message = JSON.parse(line.slice("data: ".length))
          const [entry] = message.games
          assert.strictEqual(entry.snapshot.id, TestHub.alaAtMsst.id)
          assert.deepStrictEqual(Object.keys(message), ["date", "games"])
          assert.deepStrictEqual(Object.keys(entry), ["snapshot", "availability"])
          assert.deepStrictEqual(entry.availability, [{ _tag: "NoGuide", source: "YouTube TV" }])
          assert.notMatch(line, /"state"|"updatedAt"|"from"|"plays"/)
        })
      )
    )

    it.effect(
      "should send the answer again at the next 30-second recheck when a guide read carries its game",
      () =>
        served((frames) =>
          Effect.gen(function* () {
            const client = yield* makeClient
            yield* TestClock.setTime(DateTime.toEpochMillis(TestHub.alaAtMsst.startsAt))
            yield* TestHub.alaAtMsstListed(frames)
            const lines = yield* pastInitialMessages()
            const now = yield* DateTime.now

            yield* client.guide.read({ payload: { guide: realSizedGuideAiring(now) } })
            yield* TestClock.adjust("30 seconds")
            yield* TestClock.adjust("250 millis")
            const line = yield* nextData(lines)

            assert.deepStrictEqual(
              gameListOf(line).games.map(({ availability }) => availability),
              [
                [
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
                ]
              ]
            )
          })
        )
    )

    it.effect("should not route to the game endpoint", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          yield* TestHub.alaAtMsstListed(frames)

          const { response, lines } = yield* sseLines("/api/games/live")
          const line = yield* Queue.take(lines)

          assert.strictEqual(response.status, 200)
          assert.strictEqual(gameListOf(line).date, "2026-10-03")
        })
      )
    )
  })

  describe("GET /api/games/:id", () => {
    it.effect("should answer 404 for a game no day lists", () =>
      served(() =>
        Effect.gen(function* () {
          const client = yield* makeClient

          const error = yield* client.games.game({ params: { id: GameId.make("nope") } }).pipe(Effect.flip)

          assert.strictEqual(error._tag, "GameNotFound")
        })
      )
    )
  })

  describe("GET /api/games/:id/plays", () => {
    it.effect("should page plays before a sequence", () =>
      served((frames) =>
        Effect.gen(function* () {
          const client = yield* makeClient
          yield* TestHub.alaAtMsstListed(frames)
          yield* TestHub.offered(
            frames,
            Delivery.Plays({ game: TestHub.alaAtMsst.id, plays: TestHub.playsUpTo(3) })
          )

          const page = yield* client.games.plays({
            params: { id: TestHub.alaAtMsst.id },
            query: { before: 3 }
          })

          assert.deepStrictEqual(
            page.plays.map(({ sequence }) => sequence),
            [2, 1]
          )
          assert.isFalse(page.more)
        })
      )
    )
  })

  describe("GET /api/games/:id/plays/live", () => {
    it.effect("should start with a reset to the latest page", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestHub.alaAtMsstListed(frames)
          yield* TestHub.offered(
            frames,
            Delivery.Plays({ game: TestHub.alaAtMsst.id, plays: TestHub.playsUpTo(2) })
          )

          const { lines } = yield* sseLines(`/api/games/${TestHub.alaAtMsst.id}/plays/live`)
          const line = yield* nextData(lines)

          assert.deepStrictEqual(playsChangeOf(line), {
            _tag: "Reset",
            plays: TestHub.playsUpTo(2).toReversed()
          })
        })
      )
    )
  })

  describe("HubServer.lanAddresses", () => {
    it.effect("should list external IPv4 addresses, home ranges first, then any other such as a VPN", () =>
      served(() =>
        Effect.gen(function* () {
          network.interfaces = {
            lo: [v4("127.0.0.1", true), v6("::1", true)],
            tailscale0: [v4("100.64.0.9")],
            eth0: [v4("10.0.0.7")],
            wlo1: [v4("192.168.0.54"), v6("fe80::1")]
          }
          const client = yield* makeClient

          const addresses = yield* client.host.addresses()

          assert.deepStrictEqual(addresses, ["192.168.0.54", "10.0.0.7", "100.64.0.9"])
        })
      )
    )

    it.effect("should leave out container and VM bridges", () =>
      served(() =>
        Effect.gen(function* () {
          network.interfaces = {
            docker0: [v4("172.17.0.1")],
            "br-3f2a": [v4("172.18.0.1")],
            virbr0: [v4("192.168.122.1")],
            veth12: [v4("169.254.1.1")],
            enp3s0: [v4("172.20.1.5")]
          }
          const client = yield* makeClient

          const addresses = yield* client.host.addresses()

          assert.deepStrictEqual(addresses, ["172.20.1.5"])
        })
      )
    )

    it.effect("should be empty with no network", () =>
      served(() =>
        Effect.gen(function* () {
          network.interfaces = { lo: [v4("127.0.0.1", true)], down: undefined }
          const client = yield* makeClient

          const addresses = yield* client.host.addresses()

          assert.deepStrictEqual(addresses, [])
        })
      )
    )
  })

  describe("the displays routes", () => {
    it.effect("should stream an input a Remote posts to the Display it names", () =>
      served(() =>
        Effect.gen(function* () {
          const client = yield* makeClient
          const { lines } = yield* sseLines("/api/displays/desk/inputs")

          yield* client.displays.send({ params: { id: desk }, payload: { _tag: "Pressed" } })
          const line = yield* nextData(lines)

          assert.deepStrictEqual(JSON.parse(line.slice("data: ".length)), { _tag: "Pressed" })
        })
      )
    )

    it.effect("should answer 404 DisplayOffline to an input for a Display that is not connected", () =>
      served(() =>
        Effect.gen(function* () {
          const client = yield* makeClient

          const error = yield* client.displays
            .send({ params: { id: desk }, payload: { _tag: "Pressed" } })
            .pipe(Effect.flip)

          assert.strictEqual(error._tag, "DisplayOffline")
        })
      )
    )

    it.effect("should stream a Display's report to a Remote following it", () =>
      served(() =>
        Effect.gen(function* () {
          const client = yield* makeClient
          yield* sseLines("/api/displays/desk/inputs")
          yield* client.displays.report({ params: { id: desk }, payload: { screen: 1 } })

          const { lines } = yield* sseLines("/api/displays/desk")
          const line = yield* nextData(lines)

          assert.deepStrictEqual(remoteMessageOf(line), {
            _tag: "Reported",
            report: { screen: 1 }
          })
        })
      )
    )

    it.effect("should tell a Remote following a Display that is not connected that it is offline", () =>
      served(() =>
        Effect.gen(function* () {
          const { lines } = yield* sseLines("/api/displays/desk")

          const line = yield* nextData(lines)

          assert.deepStrictEqual(remoteMessageOf(line), {
            _tag: "Offline"
          })
        })
      )
    )
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

function served<A, E, R>(test: (frames: TestHub.Frames) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const frames = yield* Queue.bounded<ReadonlyArray<Delivery>, Cause.Done>(1)

    return yield* test(frames).pipe(Effect.scoped, Effect.provide(serverUnderTest(frames)))
  })
}

function serverUnderTest(frames: TestHub.Frames) {
  const hub = Schedule.layer.pipe(
    Layer.provide(Director.layer),
    Layer.provide(Provider.layerTest(frames)),
    Layer.provideMerge(Source.layerYouTubeTv),
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_VERSION: "1.2.3" }))
  )
  return HubServer.layer.pipe(
    Layer.provideMerge(hub),
    Layer.provideMerge(Displays.layer),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
}

/** A client of the Hub's API, pointed at the server under test. */
const makeClient = HttpApiClient.make(SportalApi)

/** Opens the server-sent event stream at `path`: its response, and a queue of its lines that are not blank, as they arrive. */
const sseLines = Effect.fn("HubServer.test.sseLines")(function* (path: string) {
  const http = yield* HttpClient.HttpClient
  const lines = yield* Queue.unbounded<string>()

  const response = yield* http.get(path)
  yield* response.stream.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line !== ""),
    Stream.runForEach((line) => Queue.offer(lines, line)),
    Effect.forkScoped
  )

  return { response, lines }
})

/** Opens today's live list and takes its first message, the current answer: the lines after it. */
const pastInitialMessages = Effect.fn("HubServer.test.pastInitialMessages")(function* () {
  const { lines } = yield* sseLines("/api/games/live")

  yield* Queue.take(lines)

  return lines
})

/** The game list a `data: <json>` line carries. */
function gameListOf(line: string): GameList {
  return Schema.decodeSync(GameListJson)(line.slice("data: ".length))
}

/** The plays change a `data: <json>` line carries. */
function playsChangeOf(line: string): PlaysChange {
  return Schema.decodeSync(Schema.fromJsonString(PlaysChange))(line.slice("data: ".length))
}

/** The Remote message a `data: <json>` line carries. */
function remoteMessageOf(line: string): RemoteMessage {
  return Schema.decodeSync(RemoteMessageJson)(line.slice("data: ".length))
}

/** The next line of `lines` that carries a message, past any keep-alive event. */
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

const desk = DisplayId.make("desk")

function v4(address: string, internal = false) {
  return { address, family: "IPv4", internal }
}

function v6(address: string, internal = false) {
  return { address, family: "IPv6", internal }
}
