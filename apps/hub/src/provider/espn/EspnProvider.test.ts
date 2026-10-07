import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "@sportal/domain/Game"
import { Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { Cause, Context, DateTime, Duration, Effect, Layer, Queue, Ref, Schedule, Stream } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { HubConfig } from "../../HubConfig.ts"
import { Provider, ProviderUnavailable } from "../Provider.ts"
import { listedBy } from "../TestDecoder.ts"
import * as EspnDecoder from "./EspnDecoder.ts"
import * as EspnProvider from "./EspnProvider.ts"
import { FastCast } from "./FastCast.ts"
import { noSocket } from "./TestEspn.ts"

// Real payloads recorded from ESPN. A payload that breaks decoding gets added here before the fix.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
const fbsLive = fixture("fbs-scoreboard-live")
const fbsMidday = fixture("fbs-scoreboard-2026-10-03T2024Z")
const nflPregame = fixture("nfl-scoreboard-pregame")

describe("EspnProvider", () => {
  it.effect("should take a poll as the scoreboard's body untouched, sent when its Date header says", () =>
    Effect.gen(function* () {
      const provider = yield* Provider

      const frame = yield* provider.poll("nfl")

      assert.strictEqual(frame.body, nflPregame)
      assert.deepStrictEqual([frame.feed, frame.channel, frame.kind], ["poll", "nfl", "response"])
      assert.strictEqual(
        frame.sentAt?.epochMilliseconds,
        DateTime.makeUnsafe("2026-10-04T18:00:00Z").epochMilliseconds
      )
    }).pipe(Effect.provide(recordedEspn(fbsLive)))
  )

  it.effect("should decode a live FBS scoreboard into snapshots", () =>
    Effect.gen(function* () {
      const slate = yield* listedBy("fbs")

      const game = slate.find((g) => g.id === "401862787")
      assert.strictEqual(slate.length, 59)
      assert.strictEqual(game?.status, "live")
      assert.strictEqual(game?.away.team.abbreviation, "MEM")
      assert.strictEqual(game?.away.team.id, "fbs:235")
      assert.strictEqual(game?.away.score, 27)
      assert.deepStrictEqual(game?.broadcasts, [{ network: Network.make("ESPN+"), medium: "streaming" }])
    }).pipe(Effect.provide(recordedEspn(fbsLive)))
  )

  it.effect("should keep television and streaming broadcasts and drop radio", () =>
    Effect.gen(function* () {
      const slate = yield* listedBy("fbs")

      const game = slate.find((g) => g.id === "401856710")
      assert.deepStrictEqual(game?.broadcasts, [{ network: Network.make("ESPN"), medium: "tv" }])
    }).pipe(Effect.provide(recordedEspn(fbsLive)))
  )

  it.effect("should keep each team's location and short name", () =>
    Effect.gen(function* () {
      const slate = yield* listedBy("fbs")

      const game = slate.find((g) => g.id === "401862787")
      assert.strictEqual(game?.home.team.location, "Charlotte")
      assert.strictEqual(game?.home.team.shortName, "Charlotte")
      assert.strictEqual(game?.home.team.name, "Charlotte 49ers")
    }).pipe(Effect.provide(recordedEspn(fbsLive)))
  )

  it.effect("should keep each team's colors", () =>
    Effect.gen(function* () {
      const slate = yield* listedBy("fbs")

      const game = slate.find((g) => g.id === "401862787")
      assert.strictEqual(game?.home.team.color, "005035")
      assert.strictEqual(game?.home.team.alternateColor, "a49665")
    }).pipe(Effect.provide(recordedEspn(fbsLive)))
  )

  it.effect("should leave a team without colors with neither", () =>
    Effect.gen(function* () {
      const slate = yield* listedBy("fbs")

      const game = slate.find((g) => g.id === "401862787")
      assert.strictEqual(game?.home.team.color, undefined)
      assert.strictEqual(game?.home.team.alternateColor, undefined)
    }).pipe(Effect.provide(recordedEspn(withoutColors(fbsLive))))
  )

  it.effect("should leave out what ESPN reports with placeholder values", () =>
    Effect.gen(function* () {
      const slate = yield* listedBy("fbs")

      const game = slate.find((g) => g.id === "401862787")
      // ESPN sends rank 99 for an unranked team and down -1 between plays.
      assert.strictEqual(game?.home.ranking, undefined)
      assert.strictEqual(game?.situation?.down, undefined)
    }).pipe(Effect.provide(recordedEspn(fbsLive)))
  )

  it.effect("should decode an NFL scoreboard, namespacing team ids by league", () =>
    Effect.gen(function* () {
      const slate = yield* listedBy("nfl")

      assert.strictEqual(slate.length, 16)
      assert.isTrue(slate.every((game) => game.league === "nfl" && game.home.team.id.startsWith("nfl:")))
      assert.isTrue(slate.some((game) => game.status === "scheduled" && game.situation === undefined))
    }).pipe(Effect.provide(recordedEspn(fbsLive)))
  )

  it.effect(
    "should orient the yard line for the team with the ball: ESPN counts it from the home goal line",
    () =>
      Effect.gen(function* () {
        const slate = yield* listedBy("fbs")

        const yardLine = (id: string) => slate.find((g) => g.id === id)?.situation?.yardLine
        // Away ball, "4th & 1 at NCSU 11": Louisville is 11 yards from the goal.
        assert.strictEqual(yardLine("401858248"), 11)
        // Home ball, "1st & 10 at MIZ 10": Missouri is at its own 10, 90 yards from the goal.
        assert.strictEqual(yardLine("401856708"), 90)
        // Home ball, "1st & 10 at UK 49": South Carolina is 49 yards from the goal.
        assert.strictEqual(yardLine("401856709"), 49)
        // Away ball, "2nd & 7 at MD 33": Maryland is at its own 33.
        assert.strictEqual(yardLine("401858475"), 67)
        // No one has the ball: the yard line cannot be oriented.
        assert.strictEqual(yardLine("401856710"), undefined)
      }).pipe(Effect.provide(recordedEspn(fbsMidday)))
  )

  it.effect("should fail a poll that cannot connect as Unreachable for its league", () =>
    Effect.gen(function* () {
      const provider = yield* Provider

      const unreachable = yield* Effect.flip(provider.poll("nfl"))

      assert.deepStrictEqual([unreachable.reason, unreachable.league], ["Unreachable", "nfl"])
    }).pipe(Effect.provide(answering(() => Effect.fail(new Cause.UnknownError("ECONNREFUSED")))))
  )

  it.effect("should fail a poll answered with a non-2xx as Refused for its league", () =>
    Effect.gen(function* () {
      const provider = yield* Provider

      const refused = yield* Effect.flip(provider.poll("fbs"))

      assert.deepStrictEqual([refused.reason, refused.league], ["Refused", "fbs"])
    }).pipe(Effect.provide(answering(() => Effect.succeed(new Response("busy", { status: 503 })))))
  )
})

describe("EspnProvider polling", () => {
  it.effect("should wait 10 s while a game is live", () =>
    Effect.gen(function* () {
      const slate = [liveSnapshot({ kickoff: at("2026-10-03T11:00:00Z") })]

      const delay = yield* waitAfter(slate, [])

      assert.deepStrictEqual(delay, Duration.seconds(10))
    })
  )

  it.effect("should wait 10 s while the only game is delayed in the second quarter", () =>
    Effect.gen(function* () {
      const slate = [snapshot({ status: "delayed", period: 2, kickoff: at("2026-10-03T11:00:00Z") })]

      const delay = yield* waitAfter(slate, [])

      assert.deepStrictEqual(delay, Duration.seconds(10))
    })
  )

  it.effect("should wait 1 min when a kickoff is within 30 minutes", () =>
    Effect.gen(function* () {
      const slate = [snapshot({ kickoff: at("2026-10-03T12:20:00Z") })]

      const delay = yield* waitAfter(slate, [])

      assert.deepStrictEqual(delay, Duration.minutes(1))
    })
  )

  it.effect("should wait 1 min when a game delayed before kickoff is within 30 minutes", () =>
    Effect.gen(function* () {
      const slate = [snapshot({ status: "delayed", kickoff: at("2026-10-03T12:20:00Z") })]

      const delay = yield* waitAfter(slate, [])

      assert.deepStrictEqual(delay, Duration.minutes(1))
    })
  )

  it.effect("should wait 15 min when the next kickoff is more than 30 minutes away", () =>
    Effect.gen(function* () {
      const slate = [snapshot({ kickoff: at("2026-10-03T13:00:00Z") })]

      const delay = yield* waitAfter(slate, [])

      assert.deepStrictEqual(delay, Duration.minutes(15))
    })
  )

  it.effect("should wait 15 min when a game delayed before kickoff is more than 30 minutes away", () =>
    Effect.gen(function* () {
      const slate = [snapshot({ status: "delayed", kickoff: at("2026-10-03T13:00:00Z") })]

      const delay = yield* waitAfter(slate, [])

      assert.deepStrictEqual(delay, Duration.minutes(15))
    })
  )

  it.effect("should wait 30 s after a failed poll with an empty slate", () =>
    Effect.gen(function* () {
      const delay = yield* waitAfter([], ["fbs"])

      assert.deepStrictEqual(delay, Duration.seconds(30))
    })
  )

  it.effect("should wait 10 s after a failed poll during a live game", () =>
    Effect.gen(function* () {
      const slate = [liveSnapshot({ kickoff: at("2026-10-03T11:00:00Z") })]

      const delay = yield* waitAfter(slate, ["fbs"])

      assert.deepStrictEqual(delay, Duration.seconds(10))
    })
  )
})

// Jitter scales each reconnect delay by 0.8 to 1.2: the first is within 0.8 s to 1.2 s of the close, the second
// 1.6 s to 2.4 s.
describe("EspnProvider reconnect", () => {
  it.effect("should subscribe the push at once", () =>
    Effect.gen(function* () {
      const { subscriptions } = yield* PushCloses

      yield* pushRetried()
      yield* TestClock.adjust(0)

      const subscribed = yield* Ref.get(subscriptions)
      assert.strictEqual(subscribed, 1)
    }).pipe(Effect.provide(closingPush()))
  )

  it.effect("should not subscribe a closed push again within 0.7 s", () =>
    Effect.gen(function* () {
      const { closes, subscriptions } = yield* PushCloses
      yield* pushRetried()
      yield* TestClock.adjust(0)
      yield* Queue.offer(closes, closed)

      yield* TestClock.adjust("700 millis")

      const subscribed = yield* Ref.get(subscriptions)
      assert.strictEqual(subscribed, 1)
    }).pipe(Effect.provide(closingPush()))
  )

  it.effect("should subscribe a closed push again within 1.3 s", () =>
    Effect.gen(function* () {
      const { closes, subscriptions } = yield* PushCloses
      yield* pushRetried()
      yield* TestClock.adjust(0)
      yield* Queue.offer(closes, closed)
      yield* TestClock.adjust("700 millis")

      yield* TestClock.adjust("600 millis")

      const subscribed = yield* Ref.get(subscriptions)
      assert.strictEqual(subscribed, 2)
    }).pipe(Effect.provide(closingPush()))
  )

  it.effect("should not subscribe a push closed a second time again within 1.5 s", () =>
    Effect.gen(function* () {
      const { closes, subscriptions } = yield* PushCloses
      yield* pushRetried()
      yield* TestClock.adjust(0)
      yield* Queue.offer(closes, closed)
      yield* TestClock.adjust("700 millis")
      yield* TestClock.adjust("600 millis")
      yield* Queue.offer(closes, closed)

      yield* TestClock.adjust("1500 millis")

      const subscribed = yield* Ref.get(subscriptions)
      assert.strictEqual(subscribed, 2)
    }).pipe(Effect.provide(closingPush()))
  )

  it.effect("should subscribe a push closed a second time again within 2.5 s", () =>
    Effect.gen(function* () {
      const { closes, subscriptions } = yield* PushCloses
      yield* pushRetried()
      yield* TestClock.adjust(0)
      yield* Queue.offer(closes, closed)
      yield* TestClock.adjust("700 millis")
      yield* TestClock.adjust("600 millis")
      yield* Queue.offer(closes, closed)
      yield* TestClock.adjust("1500 millis")

      yield* TestClock.adjust("1 second")

      const subscribed = yield* Ref.get(subscriptions)
      assert.strictEqual(subscribed, 3)
    }).pipe(Effect.provide(closingPush()))
  )
})

const closed = new ProviderUnavailable({ reason: "Closed", cause: "socket closed" })

/** `body` without any team's colors. */
function withoutColors(body: string) {
  return JSON.stringify(JSON.parse(body), (key, value) =>
    key === "color" || key === "alternateColor" ? undefined : value
  )
}

/**
 * ESPN's provider and decode over recorded scoreboards: an NFL poll answered with the pregame scoreboard, an FBS poll
 * with `fbs`, each sent at 18:00Z on 2026-10-04 by its Date header.
 */
function recordedEspn(fbs: string) {
  const recordedHttp = HttpClient.make((request) => {
    const body = request.url.includes("/nfl/") ? nflPregame : fbs
    const response = new Response(body, { headers: { date: "Sun, 04 Oct 2026 18:00:00 GMT" } })
    return Effect.succeed(HttpClientResponse.fromWeb(request, response))
  })
  return Layer.merge(espnOver(recordedHttp), EspnDecoder.layer)
}

/** ESPN's provider whose every request is answered by `respond`, a failure as a transport error. */
function answering(respond: () => Effect.Effect<Response, Cause.UnknownError>) {
  return espnOver(
    HttpClient.make((request) =>
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
  )
}

/** ESPN's provider over `client`, with FastCast that opens no socket and the default Hub config. */
function espnOver(client: HttpClient.HttpClient) {
  const hubConfig = HubConfig.layerTest({}).pipe(Layer.orDie)
  return EspnProvider.layer.pipe(
    Layer.provide(FastCast.layer),
    Layer.provide([noSocket, hubConfig]),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
  )
}

function at(iso: string) {
  return DateTime.makeUnsafe(iso)
}

/** The wait ESPN's polling Schedule gives at noon on 2026-10-03, after a poll that left `slate` and `failed`. */
function waitAfter(slate: ReadonlyArray<GameSnapshot>, failed: ReadonlyArray<LeagueId>) {
  return Effect.gen(function* () {
    const now = at("2026-10-03T12:00:00Z")
    const provider = yield* Provider
    const step = yield* Schedule.toStep(provider.polling)

    const [, delay] = yield* step(now.epochMilliseconds, { slate, failed })
    return delay
  }).pipe(Effect.provide(recordedEspn(fbsLive)))
}

/** What `closingPush` fails its push with, and how many times its push was subscribed. */
class PushCloses extends Context.Service<
  PushCloses,
  { readonly closes: Queue.Queue<ProviderUnavailable>; readonly subscriptions: Ref.Ref<number> }
>()("test/PushCloses") {}

/** ESPN's provider over a FastCast whose push fails with each close offered, counting each subscription. */
function closingPush() {
  const state = Layer.effect(
    PushCloses,
    Effect.gen(function* () {
      const closes = yield* Queue.unbounded<ProviderUnavailable>()
      const subscriptions = yield* Ref.make(0)

      return { closes, subscriptions }
    })
  )
  const pushing = Layer.effect(
    FastCast,
    Effect.gen(function* () {
      const { closes, subscriptions } = yield* PushCloses

      return FastCast.of({
        push: () =>
          Stream.unwrap(
            Ref.update(subscriptions, (n) => n + 1).pipe(
              Effect.as(Stream.fromQueue(closes).pipe(Stream.mapEffect(Effect.fail)))
            )
          )
      })
    })
  )
  const unanswered = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.never)
  )
  return EspnProvider.layer.pipe(Layer.provide([pushing, unanswered]), Layer.provideMerge(state))
}

/** The provider's push, retried on its reconnect, run in the background. */
function pushRetried() {
  return Effect.gen(function* () {
    const provider = yield* Provider

    yield* provider
      .push(Stream.never)
      .pipe(Stream.retry(provider.reconnect), Stream.runDrain, Effect.forkScoped)
  })
}
