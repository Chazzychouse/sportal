import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { GameId, Network } from "@sportal/domain/Game"
import type { Tile } from "@sportal/domain/Screen"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Option, Queue, Result, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { afterEach, vi } from "vitest"
import { Director } from "./Director.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubServer from "./HubServer.ts"
import { Delivery } from "./slate/Delivery.ts"
import { GuideReader } from "./source/GuideReader.ts"
import { Source } from "./source/Source.ts"
import { delivered, directorOver } from "./TestDirector.ts"

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

      const screen = yield* client.screen.dispatch({
        payload: { command: { _tag: "Assign", tile: 0, game: game.id } }
      })

      assert.deepStrictEqual(screen.tiles[0], noGuide)
    }).pipe(Effect.provide(serverUnderTest()))
  )

  it.effect("should reject a command for a missing tile", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      yield* firstSlateOnTestClock()

      const rejected = yield* client.screen
        .dispatch({ payload: { command: { _tag: "Clear", tile: 9 } } })
        .pipe(Effect.flip)

      assert.strictEqual(rejected._tag, "ScreenRejection")
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
      yield* client.screen.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })
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

describe("HubServer.lanAddresses", () => {
  it.effect("should list external IPv4 addresses, home ranges first, then any other such as a VPN", () =>
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
    }).pipe(Effect.provide(serverUnderTest()))
  )

  it.effect("should leave out container and VM bridges", () =>
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
    }).pipe(Effect.provide(serverUnderTest()))
  )

  it.effect("should be empty with no network", () =>
    Effect.gen(function* () {
      network.interfaces = { lo: [v4("127.0.0.1", true)], down: undefined }
      const client = yield* makeClient

      const addresses = yield* client.host.addresses()

      assert.deepStrictEqual(addresses, [])
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
  it.effect("should stream the current slate and screen first, as server-sent events", () =>
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
      assert.sameMembers([first._tag, second._tag], ["SlateChanged", "ScreenChanged"])
      assert.deepStrictEqual(
        [first, second].flatMap((message) =>
          LiveMessage.guards.SlateChanged(message) ? message.games.map(({ plays }) => plays) : []
        ),
        [[]]
      )
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("should stream each change after the current slate and screen", () =>
    Effect.gen(function* () {
      const api = yield* makeClient
      yield* firstSlateOnTestClock()
      const lines = yield* pastInitialMessages()

      yield* api.screen.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })
      const thirdLine = yield* Queue.take(lines)

      const third = messageOf(thirdLine)
      assert.isTrue(thirdLine.startsWith("data: "))
      assert.deepStrictEqual(LiveMessage.guards.ScreenChanged(third) ? third.screen.tiles[0] : third, noGuide)
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect("should send a burst of slate changes once, when it settles", () =>
    Effect.gen(function* () {
      yield* firstSlateOnTestClock()
      const lines = yield* pastInitialMessages()
      const pushes = [2, 3, 4].map((period) => Delivery.cases.Snapshot.make({ snapshot: inPeriod(period) }))

      yield* Effect.forEach(pushes, (push) => delivered(push))
      yield* TestClock.adjust("250 millis")
      const line = yield* Queue.take(lines)
      const waiting = yield* Queue.size(lines)

      const message = messageOf(line)
      assert.deepStrictEqual(
        LiveMessage.guards.SlateChanged(message)
          ? message.games.map(({ snapshot }) => snapshot.period)
          : message,
        [4]
      )
      assert.strictEqual(waiting, 0)
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )

  it.effect(
    "should send each listed game as its snapshot and plays, and nothing else the slate remembers",
    () =>
      Effect.gen(function* () {
        yield* firstSlateOnTestClock()

        const { lines } = yield* liveLines()
        const line = yield* Queue.take(lines).pipe(
          Effect.repeat({ until: (line) => line.includes("SlateChanged") })
        )

        const [entry] = JSON.parse(line.slice("data: ".length)).games
        assert.strictEqual(entry.snapshot.id, game.id)
        assert.deepStrictEqual(Object.keys(entry), ["snapshot", "plays"])
        assert.notMatch(line, /"state"|"updatedAt"|"from"/)
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

      yield* api.screen.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })
      const change = yield* Queue.take(lines).pipe(
        Effect.repeat({ until: (line) => line.includes("ScreenChanged") })
      )

      assert.isTrue(change.startsWith("data: "))
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )
})

/** Delivers the fbs listing of `game`, so the Director has its first games to publish. */
function firstSlate() {
  return delivered(Delivery.cases.Listing.make({ league: "fbs", games: [game] }))
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

/** The first tile 0 the Screen shows that has the given kind; the current Screen is replayed, so this may not wait. */
function tileOnceItIs(tag: Tile["_tag"]) {
  return Effect.gen(function* () {
    const director = yield* Director

    return yield* director.screenChanges.pipe(
      Stream.filterMap((screen) => {
        const tile = screen.tiles[0]
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

/** Opens the live stream and takes its first two messages, the current slate and screen: the lines after them. */
function pastInitialMessages() {
  return Effect.gen(function* () {
    const { lines } = yield* liveLines()

    yield* Queue.take(lines)
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

/** Everything behind the API, over a provider the test feeds. */
function hubUnderTest() {
  return directorOver.pipe(
    Layer.provideMerge(Source.layerYouTubeTv),
    Layer.provideMerge(GuideReader.layerYouTubeTv),
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_VERSION: "1.2.3" }))
  )
}

/** The Hub's routes served on an ephemeral port, with an HTTP client pointed at them. */
function serverUnderTest() {
  return HubServer.layer.pipe(
    Layer.provideMerge(hubUnderTest()),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
}

function v4(address: string, internal = false) {
  return { address, family: "IPv4", internal }
}

function v6(address: string, internal = false) {
  return { address, family: "IPv6", internal }
}
