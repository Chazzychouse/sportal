import { NodeHttpServer, NodeSocket } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DisplayId } from "@sportal/api/DisplayId"
import type { DisplayMessage } from "@sportal/api/DisplayMessage"
import { CalendarDate, GameList } from "@sportal/api/GamesQuery"
import { HubApi } from "@sportal/api/HubApi"
import { GameId } from "@sportal/domain/Game"
import { GameStats } from "@sportal/domain/GameStats"
import { PlayId } from "@sportal/domain/Play"
import { snapshot } from "@sportal/domain/TestGame"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Queue, Schema, Stream } from "effect"
import { HttpServer } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { TestClock } from "effect/testing"
import { afterEach, vi } from "vitest"
import { Director } from "./Director.ts"
import { Displays } from "./Displays.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubServer from "./HubServer.ts"
import { Delivery, Provider } from "./provider/Provider.ts"
import { Schedule } from "./Schedule.ts"
import { isStopping } from "./Shutdown.ts"
import { Stats } from "./Stats.ts"
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
  describe("health and the guide", () => {
    it.effect("should say it is up, with its version and when it started", () =>
      served(() =>
        Effect.gen(function* () {
          const socket = yield* socketClient

          const health = yield* socket.health()

          assert.strictEqual(health.version, "1.2.3")
          assert.strictEqual(DateTime.toEpochMillis(health.startedAt), 0)
        })
      )
    )

    it.effect("should answer the lineup of a guide read", () =>
      served(() =>
        Effect.gen(function* () {
          yield* TestClock.setTime(TestHub.recordedAt)
          const socket = yield* socketClient
          yield* socket.readGuide({ guide: TestHub.recordedGuide })

          const lineup = yield* socket.lineup()

          assert.include(
            lineup.map(({ channel }) => channel.name),
            "ESPN"
          )
        })
      )
    )

    it.effect("should refuse a guide it cannot read", () =>
      served(() =>
        Effect.gen(function* () {
          const socket = yield* socketClient

          const error = yield* socket.readGuide({ guide: "{}" }).pipe(Effect.flip)

          assert.strictEqual(error._tag, "GuideUnreadable")
        })
      )
    )
  })

  describe("list", () => {
    it.effect("should answer today's games", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          yield* TestHub.alaAtMsstListed(frames)
          const socket = yield* socketClient

          const answer = yield* socket.list({})

          assert.strictEqual(answer.date, "2026-10-03")
          assert.deepStrictEqual(
            answer.games.map(({ snapshot }) => snapshot.id),
            [TestHub.alaAtMsst.id]
          )
        })
      )
    )

    it.effect("should keep only the leagues asked for", () =>
      served((frames) =>
        Effect.gen(function* () {
          const nfl = snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          yield* TestHub.offered(frames, Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsst] }))
          yield* TestHub.offered(frames, Delivery.Listing({ league: "nfl", games: [nfl] }))
          const socket = yield* socketClient

          const answer = yield* socket.list({ league: ["mlb", "nfl"] })

          assert.deepStrictEqual(
            answer.games.map(({ snapshot }) => snapshot.id),
            [nfl.id]
          )
        })
      )
    )

    it.effect("should fail as unavailable when the provider cannot list the day", () =>
      served(() =>
        Effect.gen(function* () {
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          const socket = yield* socketClient

          const error = yield* socket.list({ date: CalendarDate.make("2026-10-04") }).pipe(Effect.flip)

          assert.strictEqual(error._tag, "ScheduleUnavailable")
        })
      )
    )

    it.effect("should send each game as its snapshot and its availability, and nothing else", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
          yield* TestHub.alaAtMsstListed(frames)
          const socket = yield* socketClient

          const answer = yield* socket.list({})

          const wire = encodeGameList(answer)
          const [entry] = wire.games
          assert.strictEqual(entry?.snapshot.id, TestHub.alaAtMsst.id)
          assert.deepStrictEqual(Object.keys(wire), ["date", "games"])
          assert.deepStrictEqual(Object.keys(entry ?? {}), ["snapshot", "availability"])
          assert.deepStrictEqual(entry?.availability, [{ _tag: "NoGuide", source: "YouTube TV" }])
          assert.notMatch(JSON.stringify(wire), /"state"|"updatedAt"|"from"|"plays"/)
        })
      )
    )

    it.effect("should carry a game once a guide read airs it", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(TestHub.alaAtMsst.startsAt))
          yield* TestHub.alaAtMsstListed(frames)
          const socket = yield* socketClient
          const now = yield* DateTime.now
          yield* socket.readGuide({ guide: realSizedGuideAiring(now) })

          const answer = yield* socket.list({})

          assert.deepStrictEqual(
            answer.games.map(({ availability }) => availability),
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
  })

  describe("game", () => {
    it.effect("should fail as not found for a game no day lists", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestHub.alaAtMsstListed(frames)
          const socket = yield* socketClient

          const error = yield* socket.game({ id: GameId.make("nope") }).pipe(Effect.flip)

          assert.strictEqual(error._tag, "GameNotFound")
        })
      )
    )
  })

  describe("plays", () => {
    it.effect("should page plays before a sequence", () =>
      served((frames) =>
        Effect.gen(function* () {
          const socket = yield* socketClient
          yield* TestHub.alaAtMsstListed(frames)
          yield* TestHub.offered(
            frames,
            Delivery.Plays({ game: TestHub.alaAtMsst.id, plays: TestHub.playsUpTo(3) })
          )

          const page = yield* socket.plays({ id: TestHub.alaAtMsst.id, before: 3 })

          assert.deepStrictEqual(
            page.plays.map(({ sequence }) => sequence),
            [2, 1]
          )
          assert.isFalse(page.more)
        })
      )
    )
  })

  describe("stats", () => {
    it.effect("should answer a live game's stats", () =>
      served(
        (frames) =>
          Effect.gen(function* () {
            const socket = yield* socketClient
            yield* TestHub.alaAtMsstListed(frames)

            const stats = yield* socket.stats({ id: TestHub.alaAtMsst.id })

            assert.deepStrictEqual(stats.scoringPlays, [PlayId.make("p1")])
          }),
        {
          stats: (_, game) =>
            Effect.succeed(new GameStats({ ...GameStats.empty(game), scoringPlays: [PlayId.make("p1")] }))
        }
      )
    )

    it.effect("should fail as not found for a game no day lists", () =>
      served((frames) =>
        Effect.gen(function* () {
          yield* TestHub.alaAtMsstListed(frames)
          const socket = yield* socketClient

          const error = yield* socket.stats({ id: GameId.make("nope") }).pipe(Effect.flip)

          assert.strictEqual(error._tag, "GameNotFound")
        })
      )
    )
  })

  describe("the live socket", () => {
    describe("listLive", () => {
      it.effect("should send the current answer first", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
            yield* TestHub.alaAtMsstListed(frames)
            const socket = yield* socketClient

            const answers = yield* collected(socket.listLive({}))
            const first = yield* Queue.take(answers)

            assert.deepStrictEqual(
              first.games.map(({ snapshot }) => snapshot.id),
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
            const socket = yield* socketClient
            const answers = yield* collected(socket.listLive({}))
            yield* Queue.take(answers)

            yield* TestHub.offered(
              frames,
              Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
            )
            yield* TestClock.adjust("250 millis")
            const next = yield* Queue.take(answers)

            assert.deepStrictEqual(
              next.games.map(({ snapshot }) => snapshot.period),
              [2]
            )
          })
        )
      )

      it.effect("should give a query asked later the latest answer at once", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
            yield* TestHub.alaAtMsstListed(frames)
            const socket = yield* socketClient
            const earlier = yield* collected(socket.listLive({}))
            yield* Queue.take(earlier)
            yield* TestHub.offered(
              frames,
              Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
            )
            yield* TestClock.adjust("250 millis")
            yield* Queue.take(earlier)

            const later = yield* collected(socket.listLive({}))
            const first = yield* Queue.take(later)

            assert.deepStrictEqual(
              first.games.map(({ snapshot }) => snapshot.period),
              [2]
            )
          })
        )
      )
    })

    describe("gameLive", () => {
      it.effect("should send the game with its availability first", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* TestClock.setTime(TestHub.onAlaAtMsstDay)
            yield* TestHub.alaAtMsstListed(frames)
            const socket = yield* socketClient

            const answers = yield* collected(socket.gameLive({ id: TestHub.alaAtMsst.id }))
            const first = yield* Queue.take(answers)

            assert.strictEqual(first.snapshot.id, TestHub.alaAtMsst.id)
            assert.deepStrictEqual(first.availability, [{ _tag: "NoGuide", source: "YouTube TV" }])
          })
        )
      )
    })

    describe("playsLive", () => {
      it.effect("should start with a reset to the latest page", () =>
        served((frames) =>
          Effect.gen(function* () {
            yield* TestHub.alaAtMsstListed(frames)
            yield* TestHub.offered(
              frames,
              Delivery.Plays({ game: TestHub.alaAtMsst.id, plays: TestHub.playsUpTo(2) })
            )
            const socket = yield* socketClient

            const changes = yield* collected(socket.playsLive({ id: TestHub.alaAtMsst.id }))
            const first = yield* Queue.take(changes)

            assert.deepStrictEqual(first, { _tag: "Reset", plays: TestHub.playsUpTo(2).toReversed() })
          })
        )
      )
    })
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
          const socket = yield* socketClient

          const addresses = yield* socket.addresses()

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
          const socket = yield* socketClient

          const addresses = yield* socket.addresses()

          assert.deepStrictEqual(addresses, ["172.20.1.5"])
        })
      )
    )

    it.effect("should be empty with no network", () =>
      served(() =>
        Effect.gen(function* () {
          network.interfaces = { lo: [v4("127.0.0.1", true)], down: undefined }
          const socket = yield* socketClient

          const addresses = yield* socket.addresses()

          assert.deepStrictEqual(addresses, [])
        })
      )
    )
  })

  describe("the displays", () => {
    describe("inputs", () => {
      it.effect("should tell a Display the Hub has registered it first", () =>
        served(() =>
          Effect.gen(function* () {
            const socket = yield* socketClient

            const messages = yield* collected(socket.inputs({ display: desk }))
            const first = yield* Queue.take(messages)

            assert.deepStrictEqual(first, { _tag: "Registered" })
          })
        )
      )

      it.effect("should send an input a Remote posts to the Display it names", () =>
        served(() =>
          Effect.gen(function* () {
            const socket = yield* socketClient
            const messages = yield* collected(socket.inputs({ display: desk }))
            yield* Queue.take(messages)

            yield* socket.send({ display: desk, input: { _tag: "Pressed" } })
            const sent = yield* Queue.take(messages)

            assert.deepStrictEqual(sent, { _tag: "Sent", input: { _tag: "Pressed" } })
          })
        )
      )

      it.effect("should forget a Display once its client stops reading them", () =>
        served(() =>
          Effect.gen(function* () {
            const socket = yield* socketClient
            const messages = yield* Queue.unbounded<DisplayMessage>()
            const reading = yield* socket.inputs({ display: desk }).pipe(
              Stream.runForEach((message) => Queue.offer(messages, message)),
              Effect.forkScoped
            )
            yield* Queue.take(messages)

            yield* Fiber.interrupt(reading)
            // The Hub ends the stream when the interrupt reaches it, a moment after the client's.
            const error = yield* socket
              .send({ display: desk, input: { _tag: "Pressed" } })
              .pipe(Effect.flip, Effect.eventually)

            assert.strictEqual(error._tag, "DisplayOffline")
          })
        )
      )
    })

    describe("send", () => {
      it.effect("should refuse with DisplayOffline an input for a Display that is not connected", () =>
        served(() =>
          Effect.gen(function* () {
            const socket = yield* socketClient

            const error = yield* socket.send({ display: desk, input: { _tag: "Pressed" } }).pipe(Effect.flip)

            assert.strictEqual(error._tag, "DisplayOffline")
          })
        )
      )
    })

    describe("follow", () => {
      it.effect("should send a Display's report to a Remote following it", () =>
        served(() =>
          Effect.gen(function* () {
            const socket = yield* socketClient
            const inputs = yield* collected(socket.inputs({ display: desk }))
            yield* Queue.take(inputs)
            yield* socket.report({ display: desk, report: { screen: 1 } })

            const follows = yield* collected(socket.follow({ display: desk }))
            const message = yield* Queue.take(follows)

            assert.deepStrictEqual(message, { _tag: "Reported", report: { screen: 1 } })
          })
        )
      )

      it.effect("should tell a Remote following a Display that is not connected that it is offline", () =>
        served(() =>
          Effect.gen(function* () {
            const socket = yield* socketClient

            const follows = yield* collected(socket.follow({ display: desk }))
            const message = yield* Queue.take(follows)

            assert.deepStrictEqual(message, { _tag: "Offline" })
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
  answers: Partial<Pick<Provider["Service"], "listing" | "plays" | "stats">> = {}
) {
  return Effect.gen(function* () {
    const frames = yield* Queue.bounded<ReadonlyArray<Delivery>, Cause.Done>(1)

    return yield* test(frames).pipe(Effect.scoped, Effect.provide(serverUnderTest(frames, answers)))
  })
}

function serverUnderTest(
  frames: TestHub.Frames,
  answers: Partial<Pick<Provider["Service"], "listing" | "plays" | "stats">>
) {
  const hub = Stats.layer.pipe(
    Layer.provideMerge(Schedule.layer),
    Layer.provide(Director.layer),
    Layer.provide(Provider.layerTest(frames, answers)),
    Layer.provideMerge(Source.layerYouTubeTv),
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_VERSION: "1.2.3" }))
  )
  return HubServer.layer.pipe(
    Layer.provideMerge(hub),
    Layer.provideMerge(Displays.layer),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
}

/**
 * A client of the Hub's API over a WebSocket to the server under test. A test builds it after it sets the
 * clock: the client pings every 5 s of the test's time, and a jump with no pong would drop its socket.
 */
const socketClient = Effect.gen(function* () {
  const { address } = yield* HttpServer.HttpServer
  if (!("port" in address)) return yield* Effect.die("The server under test listens on a Unix socket")
  const url = `ws://127.0.0.1:${address.port}/api/socket`
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide([NodeSocket.layerWebSocket(url), RpcSerialization.layerJson])
  )
  const context = yield* Layer.build(protocol)

  return yield* RpcClient.make(HubApi).pipe(Effect.provideContext(context))
})

/** Each element of `stream`, in a queue as it arrives, while the test's scope lives. */
const collected = Effect.fnUntraced(function* <A, E>(stream: Stream.Stream<A, E>) {
  const queue = yield* Queue.unbounded<A>()

  yield* stream.pipe(
    Stream.runForEach((each) => Queue.offer(queue, each)),
    Effect.forkScoped
  )
  return queue
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

const encodeGameList = Schema.encodeSync(GameList)
