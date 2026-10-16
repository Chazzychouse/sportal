import { assert, describe, it } from "@effect/vitest"
import { CalendarDate } from "@sportal/api/GamesQuery"
import { GameId } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  Cause,
  Clock,
  DateTime,
  type Duration,
  Effect,
  Fiber,
  HashMap,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream
} from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import * as TestHub from "../../TestHub.ts"
import { Delivery, Provider, ProviderUnavailable } from "../Provider.ts"
import { EspnLeague } from "./EspnLeague.ts"
import * as EspnProvider from "./EspnProvider.ts"
import { FastCast, Frame, Topic, type Wanted } from "./FastCast.ts"
import * as FastCastMessage from "./FastCastMessage.ts"

// Real payloads recorded from ESPN. A payload that breaks decoding gets added here before the fix.
const fbsLive = TestHub.recordedScoreboard("fbs-scoreboard-live")
const nflPregame = TestHub.recordedScoreboard("nfl-scoreboard-pregame")
const nflLive = TestHub.recordedScoreboard("nfl-scoreboard-2026-10-04T1800Z")

describe("EspnProvider", () => {
  describe("polling", () => {
    it.effect("should take a poll answered with a non-2xx as a failed poll", () =>
      Effect.gen(function* () {
        const said = yield* polledOnce(
          answering(() => Effect.succeed(new Response(fbsLive, { status: 503 }))),
          { leagues: ["fbs"] }
        )

        assert.deepStrictEqual(said, [])
      })
    )

    it.effect("should take a poll whose scoreboard does not decode as a failed poll", () =>
      Effect.gen(function* () {
        const said = yield* polledOnce(
          answering(() => Effect.succeed(new Response("not json"))),
          { leagues: ["fbs"] }
        )

        assert.deepStrictEqual(said, [])
      })
    )

    it.effect("should poll every 10 seconds while a game is live", () =>
      Effect.gen(function* () {
        const live = scoreboardOf([{ state: "in", period: 2 }])

        const polled = yield* polledOver("10 seconds", { fbs: live })

        assert.deepStrictEqual(polled.fbs, [0, 10_000])
      })
    )

    it.effect("should poll every 10 seconds while the only game is delayed in the second quarter", () =>
      Effect.gen(function* () {
        const delayed = scoreboardOf([{ state: "in", name: "STATUS_DELAYED", period: 2 }])

        const polled = yield* polledOver("10 seconds", { fbs: delayed })

        assert.deepStrictEqual(polled.fbs, [0, 10_000])
      })
    )

    it.effect("should poll every minute within 30 minutes of a start", () =>
      Effect.gen(function* () {
        const soon = scoreboardOf([{ state: "pre", period: 0, startsAt: "2026-10-03T12:20Z" }])

        const polled = yield* polledOver("1 minute", { fbs: soon })

        assert.deepStrictEqual(polled.fbs, [0, 60_000])
      })
    )

    it.effect("should poll every minute when a game delayed before its start is within 30 minutes", () =>
      Effect.gen(function* () {
        const delayed = scoreboardOf([
          { state: "pre", name: "STATUS_DELAYED", period: 0, startsAt: "2026-10-03T12:20Z" }
        ])

        const polled = yield* polledOver("1 minute", { fbs: delayed })

        assert.deepStrictEqual(polled.fbs, [0, 60_000])
      })
    )

    it.effect("should poll every 15 minutes otherwise", () =>
      Effect.gen(function* () {
        const later = scoreboardOf([{ state: "pre", period: 0, startsAt: "2026-10-03T13:00Z" }])

        const polled = yield* polledOver("15 minutes", { fbs: later })

        assert.deepStrictEqual(polled.fbs, [0, 900_000])
      })
    )

    it.effect(
      "should poll every 15 minutes when a game delayed before its start is more than 30 minutes away",
      () =>
        Effect.gen(function* () {
          const delayed = scoreboardOf([
            { state: "pre", name: "STATUS_DELAYED", period: 0, startsAt: "2026-10-03T13:00Z" }
          ])

          const polled = yield* polledOver("15 minutes", { fbs: delayed })

          assert.deepStrictEqual(polled.fbs, [0, 900_000])
        })
    )

    it.effect("should poll again within 30 seconds after a league fails", () =>
      Effect.gen(function* () {
        const polled = yield* polledOver("30 seconds", { fbs: down })

        assert.deepStrictEqual(polled.fbs, [0, 30_000])
      })
    )

    it.effect("should poll a league with a live game every 10 seconds while the other league fails", () =>
      Effect.gen(function* () {
        const live = scoreboardOf([{ state: "in", period: 2 }])

        const polled = yield* polledOver(["10 seconds", "10 seconds", "10 seconds"], { nfl: live, fbs: down })

        assert.deepStrictEqual(polled.nfl, [0, 10_000, 20_000, 30_000])
      })
    )

    it.effect("should poll a failing league again within 30 seconds while the other has a live game", () =>
      Effect.gen(function* () {
        const live = scoreboardOf([{ state: "in", period: 2 }])

        const polled = yield* polledOver(["10 seconds", "10 seconds", "10 seconds"], { nfl: live, fbs: down })

        assert.deepStrictEqual(polled.fbs, [0, 30_000])
      })
    )

    it.effect(
      "should poll a league with no live game every 15 minutes while the other league's game is live",
      () =>
        Effect.gen(function* () {
          const live = scoreboardOf([{ state: "in", period: 2 }])
          const later = scoreboardOf([{ state: "pre", period: 0, startsAt: "2026-10-03T20:00Z" }])

          const polled = yield* polledOver(["10 seconds", "15 minutes"], { nfl: live, fbs: later })

          assert.deepStrictEqual(polled.fbs, [0, 900_000])
        })
    )

    it.effect("should poll every 10 seconds after a league fails during its own live game", () =>
      Effect.gen(function* () {
        const live = scoreboardOf([{ state: "in", period: 2 }])

        const polled = yield* polledOver(["10 seconds", "10 seconds"], { fbs: [live, down] })

        assert.deepStrictEqual(polled.fbs, [0, 10_000, 20_000])
      })
    )

    it.effect("should poll every 10 seconds after its own live game's scoreboard does not decode", () =>
      Effect.gen(function* () {
        const live = scoreboardOf([{ state: "in", period: 2 }])

        const polled = yield* polledOver(["10 seconds", "10 seconds"], { fbs: [live, "not json"] })

        assert.deepStrictEqual(polled.fbs, [0, 10_000, 20_000])
      })
    )

    it.effect("should poll again within 30 seconds after a scoreboard that does not decode", () =>
      Effect.gen(function* () {
        const polled = yield* polledOver("30 seconds", { fbs: "not json" })

        assert.deepStrictEqual(polled.fbs, [0, 30_000])
      })
    )

    it.effect("should poll every 15 minutes once a failed league lists no games", () =>
      Effect.gen(function* () {
        const noGames = JSON.stringify({ events: [] })

        const polled = yield* polledOver(["30 seconds", "15 minutes"], { fbs: [down, noGames] })

        assert.deepStrictEqual(polled.fbs, [0, 30_000, 930_000])
      })
    )

    it.effect("should deliver no deliveries for a league that fails", () =>
      Effect.gen(function* () {
        const nflDown = HttpClient.make((request) =>
          request.url.includes("/nfl/")
            ? transportFailure(request)
            : Effect.succeed(answered(request, fbsLive))
        )

        const said = yield* polledOnce(nflDown)

        assert.deepStrictEqual(
          said.map((one) => (Delivery.$is("Listing")(one) ? one.league : one._tag)),
          ["fbs"]
        )
      })
    )

    it.effect.each(["request", "body"] as const)(
      "should retry a poll after its %s stalls without stopping the other league",
      (phase) =>
        Effect.gen(function* () {
          const nflRequests = yield* Ref.make<ReadonlyArray<number>>([])
          const fbsRequests = yield* Ref.make(0)
          const client = HttpClient.make((request) =>
            Effect.gen(function* () {
              if (!request.url.includes("/nfl/")) {
                yield* Ref.update(fbsRequests, (count) => count + 1)
                return answered(request, fbsLive)
              }
              const at = yield* Clock.currentTimeMillis
              yield* Ref.update(nflRequests, (all) => [...all, at])
              if (phase === "request") return yield* Effect.never
              return HttpClientResponse.fromWeb(request, new Response(new ReadableStream<Uint8Array>()))
            })
          )

          yield* Effect.gen(function* () {
            const provider = yield* Provider
            yield* provider.deliveries.pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
            yield* TestClock.adjust(0)
            yield* settled
            yield* TestClock.adjust("20 seconds")
            yield* settled
            yield* TestClock.adjust("30 seconds")
            yield* settled
          }).pipe(Effect.provide(espnOver(client)), Effect.scoped)

          const nfl = yield* Ref.get(nflRequests)
          const fbs = yield* Ref.get(fbsRequests)
          assert.deepStrictEqual(nfl, [0, 50_000])
          assert.isAtLeast(fbs, 2)
        })
    )
  })

  describe("merged deliveries", () => {
    it.effect("should give each run of its deliveries every frame", () =>
      Effect.gen(function* () {
        const first = yield* TestHub.listedBy("nfl")
        const second = yield* TestHub.listedBy("nfl")

        assert.strictEqual(first.length, 16)
        assert.strictEqual(second.length, 16)
      }).pipe(Effect.provide(recordedEspn(fbsLive)))
    )

    it.effect("should deliver FastCast's frames beside its polls", () =>
      Effect.gen(function* () {
        const pushed = checkpointFrame(new Topic({ league: "nfl", game: GameId.make("401872971") }))
        const espn = espnOver(recordedHttp(fbsLive), { leagues: ["fbs"], pushing: Stream.make(pushed) })

        const said = yield* Provider.use((provider) =>
          provider.deliveries.pipe(Stream.take(2), Stream.runCollect)
        ).pipe(Effect.provide(espn))

        assert.deepStrictEqual(said.map(({ _tag }) => _tag).toSorted(), ["Listing", "Plays"])
      })
    )

    it.effect("should deliver a push that arrives during a slow poll before the poll's frame", () =>
      Effect.gen(function* () {
        const slow = HttpClient.make((request) =>
          Effect.sleep("5 seconds").pipe(Effect.as(answered(request, nflPregame)))
        )
        const checkpoint = checkpointFrame(new Topic({ league: "nfl", game: GameId.make("401872971") }))
        const pushing = Stream.fromEffect(Effect.as(Effect.sleep("1 second"), checkpoint))

        const said = yield* Effect.gen(function* () {
          const provider = yield* Provider
          const taken = yield* provider.deliveries.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
          yield* settled
          yield* TestClock.adjust("5 seconds")
          return yield* Fiber.join(taken)
        }).pipe(Effect.provide(espnOver(slow, { leagues: ["nfl"], pushing })), Effect.scoped)

        assert.deepStrictEqual(
          said.map(({ _tag }) => _tag),
          ["Plays", "Listing"]
        )
      })
    )

    it.effect("should deliver a push taken between two leagues' polls after the first league's listing", () =>
      Effect.gen(function* () {
        const live = scoreboardOf([{ state: "in", period: 2 }])
        const checkpoint = checkpointFrame(new Topic({ league: "nfl", game: GameId.make("401872971") }))
        const fbsSlow = HttpClient.make((request) =>
          request.url.includes("/nfl/")
            ? Effect.succeed(answered(request, live))
            : Effect.sleep("10 seconds").pipe(Effect.as(answered(request, fbsLive)))
        )
        const pushedAt5s = Stream.fromEffect(Effect.sleep("5 seconds")).pipe(Stream.as(checkpoint))
        const espn = espnOver(fbsSlow, { pushing: pushedAt5s })

        const said = yield* Effect.gen(function* () {
          const provider = yield* Provider
          const delivered = yield* Queue.unbounded<Delivery>()
          yield* provider.deliveries.pipe(
            Stream.runForEach((one) => Queue.offer(delivered, one)),
            Effect.forkScoped({ startImmediately: true })
          )
          yield* settled
          yield* TestClock.adjust("10 seconds")
          return yield* Queue.takeBetween(delivered, 3, 3)
        }).pipe(Effect.provide(espn), Effect.scoped)

        assert.deepStrictEqual(
          said.map((one) => (Delivery.$is("Listing")(one) ? `Listing ${one.league}` : one._tag)),
          ["Listing nfl", "Plays", "Listing fbs"]
        )
      })
    )
  })

  describe("wanted topics", () => {
    it.effect("should tell FastCast to follow no topic before any game is listed", () =>
      Effect.gen(function* () {
        const unanswered = HttpClient.make(() => Effect.never)

        const told = yield* toldOver(unanswered, ["fbs"], [])

        const [first] = told
        assert.deepStrictEqual(first === undefined ? [] : [...HashMap.entries(first)], [])
      })
    )

    it.effect("should want a game's topic once its start is 30 minutes away, with no frame", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.makeUnsafe("2026-10-03T12:00:00Z").epochMilliseconds)
        const later = scoreboardOf([{ state: "pre", period: 0, startsAt: "2026-10-03T12:31Z" }])
        const [event] = decodeEventIds(later).events
        const game = new Topic({ league: "fbs", game: event.id })
        const answering = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(later)))
        )

        const told = yield* toldOver(answering, ["fbs"], ["1 minute"])

        assert.isFalse(
          told.slice(0, -1).some((one) => HashMap.has(one, game)),
          "31 minutes out, it is not followed"
        )
        assert.isTrue(Option.exists(Arr.last(told), (one) => HashMap.has(one, game)))
      })
    )

    it.effect("should want a listed game's topic while it is live", () =>
      Effect.gen(function* () {
        const told = yield* toldOver(recordedNfl, ["nfl"], [])

        assert.isTrue(Option.exists(Arr.last(told), (one) => HashMap.has(one, neAtBuf)))
      })
    )

    it.effect("should want a listed game's topic from 30 minutes before its start", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.makeUnsafe("2026-10-04T19:35:00Z").epochMilliseconds)

        const told = yield* toldOver(recordedNfl, ["nfl"], [])

        assert.isTrue(Option.exists(Arr.last(told), (one) => HashMap.has(one, gameTopic("401872974"))))
      })
    )

    it.effect("should not want a listed game's topic a second before 30 minutes before its start", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.makeUnsafe("2026-10-04T19:34:59Z").epochMilliseconds)

        const told = yield* toldOver(recordedNfl, ["nfl"], [])

        assert.isFalse(told.some((one) => HashMap.has(one, gameTopic("401872974"))))
      })
    )

    it.effect("should not want a listed game's topic once it is final", () =>
      Effect.gen(function* () {
        const live = scoreboardOf([{ state: "in", period: 2 }])
        const final = scoreboardOf([{ state: "post", period: 4 }])
        const topic = firstTopicOf(live)
        const polls = Ref.makeUnsafe(0)
        const client = HttpClient.make((request) =>
          Effect.map(
            Ref.getAndUpdate(polls, (n) => n + 1),
            (n) => answered(request, n === 0 ? live : final)
          )
        )

        const told = yield* toldOver(client, ["nfl"], ["10 seconds"])

        assert.isTrue(
          told.some((one) => HashMap.has(one, topic)),
          "it was wanted while live"
        )
        assert.isFalse(Option.exists(Arr.last(told), (one) => HashMap.has(one, topic)))
      })
    )

    it.effect("should keep one league's wanted topics when the other league lists", () =>
      Effect.gen(function* () {
        const live = scoreboardOf([{ state: "in", period: 2 }])
        const nfl = firstTopicOf(live)
        const fbs = new Topic({ league: "fbs", game: nfl.game })
        const client = HttpClient.make((request) => Effect.succeed(answered(request, live)))

        const told = yield* toldOver(client, ["nfl", "fbs"], ["10 seconds"])

        const last = Arr.last(told)
        assert.isTrue(Option.exists(last, (one) => HashMap.has(one, nfl)))
        assert.isTrue(Option.exists(last, (one) => HashMap.has(one, fbs)))
      })
    )
  })

  describe("listing", () => {
    it.effect("should ask each league's scoreboard for the day", () =>
      Effect.gen(function* () {
        const urls = yield* Ref.make<ReadonlyArray<string>>([])
        const client = HttpClient.make((request) =>
          Ref.update(urls, (all) => [...all, request.url]).pipe(
            Effect.as(answered(request, request.url.includes("/nfl/") ? nflLive : fbsLive))
          )
        )

        yield* listedOver(client, "2026-10-04")

        const asked = yield* Ref.get(urls)
        assert.deepStrictEqual(
          asked.map((url) => url.replace(/^https?:\/\/[^/]+\/apis\/site\/v2\/sports/, "")),
          [
            "/football/nfl/scoreboard?dates=20261004",
            "/football/college-football/scoreboard?groups=80&limit=300&dates=20261004"
          ]
        )
      })
    )

    it.effect("should list the games of the recorded NFL scoreboard", () =>
      Effect.gen(function* () {
        const games = yield* listedOver(recordedHttp(fbsLive), "2026-10-04", ["nfl"])

        assert.strictEqual(games.length, 16)
      })
    )

    it.effect("should fail as unavailable when a scoreboard is not answered with a 2xx", () =>
      Effect.gen(function* () {
        const failed = yield* listedOver(
          answering(() => Effect.succeed(new Response(nflLive, { status: 503 }))),
          "2026-10-04"
        ).pipe(Effect.flip)

        assert.instanceOf(failed, ProviderUnavailable)
      })
    )
  })

  describe("plays", () => {
    it.effect("should read a game's plays from its summary", () =>
      Effect.gen(function* () {
        const summary = TestHub.recordedSummary("nfl-summary-401872971")
        const client = HttpClient.make((request) =>
          Effect.succeed(answered(request, request.url.includes("/summary?event=401872971") ? summary : "{}"))
        )

        const plays = yield* playsOver(client, "nfl", GameId.make("401872971"))

        assert.strictEqual(plays[0]?.type.text, "Kickoff")
      })
    )

    it.effect("should fail as unavailable for a league ESPN does not serve", () =>
      Effect.gen(function* () {
        const failed = yield* playsOver(recordedHttp(fbsLive), "mlb", GameId.make("1")).pipe(Effect.flip)

        assert.instanceOf(failed, ProviderUnavailable)
      })
    )
  })

  describe("stats", () => {
    it.effect("should read a game's stats from its summary", () =>
      Effect.gen(function* () {
        const summary = TestHub.recordedSummary("nfl-summary-401872971")
        const client = HttpClient.make((request) =>
          Effect.succeed(answered(request, request.url.includes("/summary?event=401872971") ? summary : "{}"))
        )

        const stats = yield* statsOver(client, "nfl", GameId.make("401872971"))

        assert.deepStrictEqual(stats.linescore, { home: [0, 17, 0, 9], away: [7, 7, 7, 8] })
      })
    )

    it.effect("should fail as unavailable for a summary that does not decode", () =>
      Effect.gen(function* () {
        const client = HttpClient.make((request) => Effect.succeed(answered(request, "{}")))

        const failed = yield* statsOver(client, "nfl", GameId.make("401872971")).pipe(Effect.flip)

        assert.instanceOf(failed, ProviderUnavailable)
      })
    )

    it.effect("should fail as unavailable for a league ESPN does not serve", () =>
      Effect.gen(function* () {
        const failed = yield* statsOver(recordedHttp(fbsLive), "mlb", GameId.make("1")).pipe(Effect.flip)

        assert.instanceOf(failed, ProviderUnavailable)
      })
    )
  })

  describe("retention/integration", () => {
    it.effect("should show a synced topic as Synced", () =>
      Effect.gen(function* () {
        const pushing = Stream.fromEffect(Effect.sleep("1 second")).pipe(Stream.as(checkpointFrame(neAtBuf)))

        const told = yield* toldOver(recordedNfl, ["nfl"], ["1 second"], pushing)

        assert.deepStrictEqual(
          Option.flatMap(Arr.last(told), (one) => HashMap.get(one, neAtBuf)),
          Option.some("Synced")
        )
      })
    )

    it.effect("should show a topic that lost its document as waiting for its checkpoint", () =>
      Effect.gen(function* () {
        const pushing = Stream.fromEffect(Effect.sleep("1 second")).pipe(
          Stream.flatMap(() => Stream.make(checkpointFrame(neAtBuf), unapplicablePatch(neAtBuf)))
        )

        const told = yield* toldOver(recordedNfl, ["nfl"], ["1 second"], pushing)

        assert.isTrue(
          told.slice(0, -1).some((one) => Option.contains(HashMap.get(one, neAtBuf), "Synced")),
          "it was synced before it lost its document"
        )
        assert.deepStrictEqual(
          Option.flatMap(Arr.last(told), (one) => HashMap.get(one, neAtBuf)),
          Option.some("AwaitingCheckpoint")
        )
      })
    )

    it.effect("should keep a live game's synced topic across the next listing", () =>
      Effect.gen(function* () {
        const live = scoreboardOf([{ state: "in", period: 2 }])
        const topic = firstTopicOf(live)
        const pushing = Stream.fromEffect(Effect.sleep("1 second")).pipe(Stream.as(checkpointFrame(topic)))
        const client = HttpClient.make((request) => Effect.succeed(answered(request, live)))

        const told = yield* toldOver(client, ["nfl"], ["1 second", "10 seconds"], pushing)

        assert.deepStrictEqual(
          Option.flatMap(Arr.last(told), (one) => HashMap.get(one, topic)),
          Option.some("Synced")
        )
      })
    )

    it.effect("should drop a game's document once a listing no longer wants it", () =>
      Effect.gen(function* () {
        const live = scoreboardOf([{ state: "in", period: 2 }])
        const final = scoreboardOf([{ state: "post", period: 4 }])
        const topic = firstTopicOf(live)
        const pushing = Stream.fromEffect(Effect.sleep("1 second")).pipe(Stream.as(checkpointFrame(topic)))
        const polls = Ref.makeUnsafe(0)
        const client = HttpClient.make((request) =>
          Effect.map(
            Ref.getAndUpdate(polls, (n) => n + 1),
            (n) => answered(request, n === 1 ? final : live)
          )
        )

        const told = yield* toldOver(client, ["nfl"], ["1 second", "10 seconds", "15 minutes"], pushing)

        assert.isTrue(
          told.some((one) => Option.contains(HashMap.get(one, topic), "Synced")),
          "it was synced while live"
        )
        assert.deepStrictEqual(
          Option.flatMap(Arr.last(told), (one) => HashMap.get(one, topic)),
          Option.some("AwaitingCheckpoint")
        )
      })
    )

    // Depends on recorded games 401872974/401872976 being upcoming in the 18:00Z scoreboard and the clock staying at epoch.
    it.effect(
      "should subscribe to a listed live game once, and once more only after a gap in its messages",
      () =>
        Effect.gen(function* () {
          const server = TestHub.fakeServer()
          const delivered = TestHub.watched<Delivery>()
          const subscriptions = () =>
            server.sent.all().filter((sent) => sent.op === "S" && sent.tc === liveTc)

          const counted = yield* Effect.gen(function* () {
            const provider = yield* Provider
            yield* provider.deliveries.pipe(
              Stream.runForEach((one) => Effect.sync(() => delivered.add(one))),
              Effect.forkScoped({ startImmediately: true })
            )
            yield* server.sent.until(TestHub.subscribed(liveTc, 1))
            const listed = subscriptions().length

            yield* Effect.sync(() => server.send(checkpointAt(99)))
            yield* delivered.until(playsDelivered(1))
            yield* markedByTheNextPoll(server, laterGames[0])
            const checkpointed = subscriptions().length

            const gap = JSON.stringify({ ts: 1791132689445, pl: "[]" })
            yield* Effect.sync(() => server.send({ op: "P", tc: liveTc, mid: 101, pl: gap }))
            // A checkpoint after the gap, so the gap has been taken once its plays are delivered.
            yield* Effect.sync(() => server.send(checkpointAt(102)))
            yield* delivered.until(playsDelivered(2))
            yield* markedByTheNextPoll(server, laterGames[1])
            return { listed, checkpointed, afterGap: subscriptions().length }
          }).pipe(Effect.provide(espnOverFastCast(server)), Effect.scoped)

          assert.deepStrictEqual(counted, { listed: 1, checkpointed: 1, afterGap: 2 })
        })
    )
  })
})

/**
 * ESPN's provider over recorded scoreboards: an NFL poll answered with the pregame scoreboard, an FBS poll with `fbs`,
 * each sent at 18:00Z on 2026-10-04 by its Date header.
 */
function recordedEspn(fbs: string) {
  return espnOver(recordedHttp(fbs))
}

/** ESPN's site answering an NFL request with the pregame scoreboard and any other with `fbs`. */
function recordedHttp(fbs: string) {
  return HttpClient.make((request) =>
    Effect.succeed(answered(request, request.url.includes("/nfl/") ? nflPregame : fbs))
  )
}

/** `body`, sent at 18:00Z on 2026-10-04 by its Date header, as the answer to `request`. */
function answered(request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: string) {
  const response = new Response(body, { headers: { date: "Sun, 04 Oct 2026 18:00:00 GMT" } })
  return HttpClientResponse.fromWeb(request, response)
}

/** ESPN's site, every request answered by `respond`, a failure as a transport error. */
function answering(respond: () => Effect.Effect<Response, Cause.UnknownError>) {
  return HttpClient.make((request) =>
    respond().pipe(
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      Effect.mapError(
        (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause })
          })
      )
    )
  )
}

/** `request` failing to connect. */
function transportFailure(request: Parameters<typeof HttpClientResponse.fromWeb>[0]) {
  return Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause: new Cause.UnknownError("ECONNREFUSED") })
    })
  )
}

/**
 * ESPN's provider over `client`, polling `leagues` (every league, unless given), with FastCast pushing `pushing`
 * (nothing, unless given) or, when given `wanting`, the frames it gives for what FastCast is told to follow.
 */
function espnOver(
  client: HttpClient.HttpClient,
  options: {
    readonly leagues?: ReadonlyArray<LeagueId>
    readonly pushing?: Stream.Stream<Frame>
    readonly wanting?: (wanted: Stream.Stream<Wanted>) => Stream.Stream<Frame>
  } = {}
) {
  return EspnProvider.layer(followed(options.leagues ?? LeagueId.literals)).pipe(
    Layer.provide([
      FastCast.layerTest(options.wanting ?? (() => options.pushing ?? Stream.never)),
      Layer.succeed(HttpClient.HttpClient, client)
    ])
  )
}

/** The games ESPN's provider over `client` lists for `date` in `leagues` (every league, unless given). */
function listedOver(
  client: HttpClient.HttpClient,
  date: string,
  leagues: ReadonlyArray<LeagueId> = LeagueId.literals
) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    return yield* provider.listing(CalendarDate.make(date))
  }).pipe(Effect.provide(espnOver(client, { leagues })))
}

/** The plays of game `game` of `league` that ESPN's provider over `client` reads. */
function playsOver(client: HttpClient.HttpClient, league: LeagueId, game: GameId) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    return yield* provider.plays(league, game)
  }).pipe(Effect.provide(espnOver(client)))
}

/** The stats of game `game` of `league` that ESPN's provider over `client` reads. */
function statsOver(client: HttpClient.HttpClient, league: LeagueId, game: GameId) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    return yield* provider.stats(league, game)
  }).pipe(Effect.provide(espnOver(client)))
}

/** What ESPN's provider's first polls over `client` said. */
function polledOnce(
  client: HttpClient.HttpClient,
  options: { readonly leagues?: ReadonlyArray<LeagueId> } = {}
) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    const said = yield* Queue.unbounded<Delivery>()
    yield* provider.deliveries.pipe(
      Stream.runForEach((one) => Queue.offer(said, one)),
      Effect.forkScoped({ startImmediately: true })
    )

    yield* TestClock.adjust(0)
    yield* settled

    return yield* Queue.clear(said)
  }).pipe(Effect.provide(espnOver(client, options)), Effect.scoped)
}

// What a league answers when its every poll cannot connect.
const down = "down"

/**
 * Gives every fiber a hundred turns, so what the test clock last woke has run on to its next sleep: a poll's frame is
 * taken by the fold, and its league's next poll is waiting on the clock. A frame crosses several fibers on its way to
 * the fold, and the clock moves on after one turn.
 */
const settled = Effect.yieldNow.pipe(Effect.repeat({ times: 100 }))

/**
 * The instants, in milliseconds from noon on 2026-10-03, at which each league polls as the test clock moves from then
 * by each of `spans`. Each league of `answers` answers its polls in turn (the last answer again once they run out) with
 * a scoreboard body, or cannot connect when the answer is `down`.
 */
function polledOver(
  spans: Duration.Input | ReadonlyArray<Duration.Input>,
  answers: Partial<Record<LeagueId, string | ReadonlyArray<string>>>,
  pushing: Stream.Stream<Frame> = Stream.never
) {
  return Effect.gen(function* () {
    const start = DateTime.makeUnsafe("2026-10-03T12:00:00Z").epochMilliseconds
    yield* TestClock.setTime(start)
    const requests = yield* Ref.make<ReadonlyArray<{ readonly league: LeagueId; readonly at: number }>>([])
    const answerOf = (league: LeagueId, poll: number) => {
      const answered = Arr.ensure(answers[league] ?? [])
      return answered[Math.min(poll, answered.length - 1)]
    }
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const league: LeagueId = request.url.includes("/nfl/") ? "nfl" : "fbs"
        const earlier = yield* Ref.getAndUpdate(requests, (all) => [...all, { league, at: now - start }])

        const body = answerOf(league, earlier.filter((one) => one.league === league).length)
        return body === undefined || body === down
          ? yield* transportFailure(request)
          : HttpClientResponse.fromWeb(request, new Response(body))
      })
    )
    const leagues = LeagueId.literals.filter((league) => answers[league] !== undefined)

    yield* Effect.gen(function* () {
      const provider = yield* Provider
      yield* provider.deliveries.pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
      yield* TestClock.adjust(0)
      yield* settled
      yield* Effect.forEach(Arr.ensure(spans), (span) => Effect.andThen(TestClock.adjust(span), settled), {
        discard: true
      })
    }).pipe(Effect.provide(espnOver(client, { leagues, pushing })), Effect.scoped)

    const polled = yield* Ref.get(requests)
    const byLeague: Partial<Record<LeagueId, ReadonlyArray<number>>> = Object.fromEntries(
      leagues.map((league) => [
        league,
        Arr.dedupe(polled.filter((one) => one.league === league).map(({ at }) => at))
      ])
    )
    return byLeague
  })
}

/**
 * Each wanted set ESPN's provider over `client`, polling `leagues`, with FastCast pushing `pushing` (nothing, unless
 * given), tells FastCast as the test clock moves by each of `spans`.
 */
function toldOver(
  client: HttpClient.HttpClient,
  leagues: ReadonlyArray<LeagueId>,
  spans: ReadonlyArray<Duration.Input>,
  pushing: Stream.Stream<Frame> = Stream.never
) {
  return Effect.gen(function* () {
    const told = yield* Ref.make<ReadonlyArray<Wanted>>([])
    const espn = espnOver(client, {
      leagues,
      wanting: (wanted) =>
        wanted.pipe(
          Stream.tap((one) => Ref.update(told, (all) => [...all, one])),
          Stream.drain,
          Stream.merge(pushing)
        )
    })

    yield* Effect.gen(function* () {
      const provider = yield* Provider
      yield* provider.deliveries.pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
      yield* TestClock.adjust(0)
      yield* settled
      yield* Effect.forEach(spans, (span) => Effect.andThen(TestClock.adjust(span), settled), {
        discard: true
      })
    }).pipe(Effect.provide(espn), Effect.scoped)

    return yield* Ref.get(told)
  })
}

/**
 * ESPN's provider polling the NFL over the real FastCast on `server`. Its first poll is answered with the recorded
 * scoreboard of 18:00Z on 2026-10-04, in which NE at BUF is live; each poll after it also shows one more of
 * `laterGames` live. Each checkpoint is an empty game document.
 */
function espnOverFastCast(server: ReturnType<typeof TestHub.fakeServer>) {
  const polls = Ref.makeUnsafe(0)
  const http = HttpClient.make((request) => {
    const url = new URL(request.url)
    const answer = url.pathname.endsWith("websockethost")
      ? Effect.succeed(JSON.stringify({ ip: "fastcast.test", securePort: 443, token: "token" }))
      : url.hostname === "checkpoint.test"
        ? Effect.succeed(JSON.stringify({ entities: {} }))
        : Effect.map(
            Ref.getAndUpdate(polls, (n) => n + 1),
            (n) => liveWith(laterGames.slice(0, n))
          )
    return Effect.map(answer, (body) => HttpClientResponse.fromWeb(request, new Response(body)))
  })
  const host = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(Socket.WebSocketConstructor, () => server.socket)
  )
  return EspnProvider.layer(followed(["nfl"])).pipe(Layer.provide(FastCast.layer), Layer.provide(host))
}

/**
 * Moves the test clock to the next poll and waits for `game`'s first S, which that poll makes wanted. FastCast steers by
 * each wanted set in turn, so every S an earlier frame would send has been sent by then.
 */
function markedByTheNextPoll(server: ReturnType<typeof TestHub.fakeServer>, game: string) {
  return TestClock.adjust("10 seconds").pipe(
    Effect.andThen(server.sent.until(TestHub.subscribed(`gp-football-nfl-${game}`, 1)))
  )
}

/** NE at BUF's `H` at `mid`. */
function checkpointAt(mid: number) {
  return { op: "H", tc: liveTc, mid, pl: `https://checkpoint.test/${mid}` }
}

/** Whether at least `count` deliveries of plays have arrived. */
function playsDelivered(count: number) {
  return (all: ReadonlyArray<Delivery>) => all.filter(Delivery.$is("Plays")).length >= count
}

/** The recorded 18:00Z NFL scoreboard with `games`, by id, live as well. */
function liveWith(games: ReadonlyArray<string>) {
  const scoreboard = JSON.parse(nflLive)
  const events = scoreboard.events.map((event: { id: string; status: { type: object } }) =>
    games.includes(event.id)
      ? { ...event, status: { ...event.status, type: { ...event.status.type, state: "in" } } }
      : event
  )
  return JSON.stringify({ ...scoreboard, events })
}

// NE at BUF's game topic, live in the recorded 18:00Z scoreboard, and two games that scoreboard shows upcoming.
const liveTc = "gp-football-nfl-401872971"
const neAtBuf = gameTopic("401872971")
const laterGames = ["401872974", "401872976"] as const

/** ESPN's site answering every request with the recorded 18:00Z NFL scoreboard. */
const recordedNfl = HttpClient.make((request) => Effect.succeed(answered(request, nflLive)))

/** The topic of the first game of the NFL scoreboard `body`. */
function firstTopicOf(body: string) {
  const [event] = decodeEventIds(body).events
  return gameTopic(event.id)
}

/** NFL game `id`'s topic. */
function gameTopic(id: string) {
  return new Topic({ league: "nfl", game: GameId.make(id) })
}

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(FastCastMessage.Envelope))

const decodeEventIds = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ events: Schema.Tuple([Schema.Struct({ id: GameId })]) }))
)

/** A patch at mid 2 on `topic` that will not apply: it has no such play. */
function unapplicablePatch(topic: Topic): Frame {
  const pl = JSON.stringify({
    ts: 1791136341731,
    pl: [{ op: "replace", path: "/entities/plays/no-such-play/text", value: "Corrected" }]
  })
  return Frame.Pushed({
    topic: Option.some(topic),
    mid: Option.some(2),
    envelope: decodeEnvelope(JSON.stringify({ op: "P", tc: topic.tc(), mid: 2, pl }))
  })
}

/** The checkpoint frame FastCast makes of `topic`'s checkpoint, a game with no plays yet, at mid 1. */
function checkpointFrame(topic: Topic): Frame {
  const document = Schema.decodeSync(FastCastMessage.Checkpoint)(JSON.stringify({ entities: {} }))
  return Frame.Checkpoint({ topic, mid: 1, document })
}

/**
 * An ESPN scoreboard of one game per entry, each the pregame scoreboard's second event starting at `startsAt` (the
 * recorded start, unless given), in ESPN's status `state`, named `name` (the recorded name, unless given), in `period`.
 */
function scoreboardOf(
  games: ReadonlyArray<{
    readonly state: "pre" | "in" | "post"
    readonly name?: string
    readonly period: number
    readonly startsAt?: string
  }>
) {
  const scoreboard = JSON.parse(nflPregame)
  const template = scoreboard.events[1]
  const events = games.map(({ state, name, period, startsAt }, index) => ({
    ...template,
    id: `${template.id}${index}`,
    date: startsAt ?? template.date,
    status: {
      ...template.status,
      period,
      type: { ...template.status.type, state, name: name ?? template.status.type.name }
    }
  }))
  return JSON.stringify({ ...scoreboard, events })
}

/** The followed ESPN leagues among `leagues`. */
function followed(leagues: ReadonlyArray<LeagueId>): ReadonlyArray<EspnLeague> {
  return EspnLeague.followed.filter(({ league }) => leagues.includes(league))
}
