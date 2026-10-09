import { assert, describe, it } from "@effect/vitest"
import { GameId, Network } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  Cause,
  Clock,
  DateTime,
  type Duration,
  Effect,
  Exit,
  HashMap,
  Layer,
  Metric,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
  type Tracer
} from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import { HubConfig } from "../../HubConfig.ts"
import { counted, recordingLogs, recordingSpans, withMetrics } from "../../TestTelemetry.ts"
import { Delivery, Provider } from "../Provider.ts"
import { listedBy } from "../TestProvider.ts"
import * as EspnProvider from "./EspnProvider.ts"
import { FastCast, type Wanted } from "./FastCast.ts"
import { Frame } from "./Frame.ts"
import { ProviderUnavailable } from "./ProviderUnavailable.ts"
import { recordedScoreboard } from "./TestEspn.ts"
import { fakeServer, subscribed, watched } from "./TestFastCast.ts"
import { Topic } from "./Topic.ts"

// Real payloads recorded from ESPN. A payload that breaks decoding gets added here before the fix.
const fbsLive = recordedScoreboard("fbs-scoreboard-live")
const fbsMidday = recordedScoreboard("fbs-scoreboard-2026-10-03T2024Z")
const nflPregame = recordedScoreboard("nfl-scoreboard-pregame")
const nflLive = recordedScoreboard("nfl-scoreboard-2026-10-04T1800Z")

describe("EspnProvider", () => {
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

  it.effect("should take a poll that cannot connect as Unreachable for its league", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* polledOnce(
        answering(() => Effect.fail(new Cause.UnknownError("ECONNREFUSED"))),
        {
          ended,
          leagues: "nfl"
        }
      )

      const unreachable = pollFailures(ended)
      assert.deepStrictEqual(unreachable, [["Unreachable", "nfl"]])
    })
  })

  it.effect("should take a poll answered with a non-2xx as Refused for its league", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* polledOnce(
        answering(() => Effect.succeed(new Response("busy", { status: 503 }))),
        {
          ended,
          leagues: "fbs"
        }
      )

      const refused = pollFailures(ended)
      assert.deepStrictEqual(refused, [["Refused", "fbs"]])
    })
  })
})

describe("EspnProvider.deliveries", () => {
  it.effect("should poll every 10 seconds while a game is live", () =>
    Effect.gen(function* () {
      const live = scoreboardOf([{ state: "in", period: 2 }])

      const polled = yield* polledOver("10 seconds", { fbs: live })

      assert.deepStrictEqual(polled, [0, 10_000])
    })
  )

  it.effect("should poll every 10 seconds while the only game is delayed in the second quarter", () =>
    Effect.gen(function* () {
      const delayed = scoreboardOf([{ state: "in", name: "STATUS_DELAYED", period: 2 }])

      const polled = yield* polledOver("10 seconds", { fbs: delayed })

      assert.deepStrictEqual(polled, [0, 10_000])
    })
  )

  it.effect("should poll every minute within 30 minutes of a kickoff", () =>
    Effect.gen(function* () {
      const soon = scoreboardOf([{ state: "pre", period: 0, kickoff: "2026-10-03T12:20Z" }])

      const polled = yield* polledOver("1 minute", { fbs: soon })

      assert.deepStrictEqual(polled, [0, 60_000])
    })
  )

  it.effect("should poll every minute when a game delayed before kickoff is within 30 minutes", () =>
    Effect.gen(function* () {
      const delayed = scoreboardOf([
        { state: "pre", name: "STATUS_DELAYED", period: 0, kickoff: "2026-10-03T12:20Z" }
      ])

      const polled = yield* polledOver("1 minute", { fbs: delayed })

      assert.deepStrictEqual(polled, [0, 60_000])
    })
  )

  it.effect("should poll every 15 minutes otherwise", () =>
    Effect.gen(function* () {
      const later = scoreboardOf([{ state: "pre", period: 0, kickoff: "2026-10-03T13:00Z" }])

      const polled = yield* polledOver("15 minutes", { fbs: later })

      assert.deepStrictEqual(polled, [0, 900_000])
    })
  )

  it.effect(
    "should poll every 15 minutes when a game delayed before kickoff is more than 30 minutes away",
    () =>
      Effect.gen(function* () {
        const delayed = scoreboardOf([
          { state: "pre", name: "STATUS_DELAYED", period: 0, kickoff: "2026-10-03T13:00Z" }
        ])

        const polled = yield* polledOver("15 minutes", { fbs: delayed })

        assert.deepStrictEqual(polled, [0, 900_000])
      })
  )

  it.effect("should poll again within 30 seconds after a league fails", () =>
    Effect.gen(function* () {
      const polled = yield* polledOver("30 seconds", { fbs: down })

      assert.deepStrictEqual(polled, [0, 30_000])
    })
  )

  it.effect("should poll every 10 seconds after a league fails during a live game", () =>
    Effect.gen(function* () {
      const live = scoreboardOf([{ state: "in", period: 2 }])

      const polled = yield* polledOver("10 seconds", { nfl: live, fbs: down })

      assert.deepStrictEqual(polled, [0, 10_000])
    })
  )

  it.effect("should poll every 10 seconds after a league fails during its own live game", () =>
    Effect.gen(function* () {
      const live = scoreboardOf([{ state: "in", period: 2 }])

      const polled = yield* polledOver(["10 seconds", "10 seconds"], { fbs: [live, down] })

      assert.deepStrictEqual(polled, [0, 10_000, 20_000])
    })
  )

  it.effect("should poll every 10 seconds after its own live game's scoreboard does not decode", () =>
    Effect.gen(function* () {
      const live = scoreboardOf([{ state: "in", period: 2 }])

      const polled = yield* polledOver(["10 seconds", "10 seconds"], { fbs: [live, "not json"] })

      assert.deepStrictEqual(polled, [0, 10_000, 20_000])
    })
  )

  it.effect("should poll again within 30 seconds after a scoreboard that does not decode", () =>
    Effect.gen(function* () {
      const polled = yield* polledOver("30 seconds", { fbs: "not json" })

      assert.deepStrictEqual(polled, [0, 30_000])
    })
  )

  it.effect("should log and count a league that fails", () => {
    const ended: Array<Tracer.Span> = []
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* polledOnce(
        answering(() => Effect.fail(new Cause.UnknownError("ECONNREFUSED"))),
        {
          ended,
          leagues: "fbs"
        }
      )

      const poll = ended.find((span) => span.name === "EspnProvider.pollEveryLeague")
      const errors = yield* counted("sportal_provider_errors", { league: "fbs" })
      const warned = logs.filter(
        ({ level, message }) =>
          level === "Warn" &&
          message.includes(
            "EspnProvider: a poll failed; keeping the last good listing for this league, if any"
          )
      )
      assert.deepStrictEqual(poll?.attributes.get("sportal.failed_leagues"), ["fbs"])
      assert.strictEqual(errors, 1)
      assert.lengthOf(warned, 1)
    }).pipe(Effect.provide(layer), withMetrics)
  })

  it.effect("should deliver no frame for a league that fails", () =>
    Effect.gen(function* () {
      const nflDown = HttpClient.make((request) =>
        request.url.includes("/nfl/") ? transportFailure(request) : Effect.succeed(answered(request, fbsLive))
      )

      const said = yield* polledOnce(nflDown, { frames: 1 })

      assert.deepStrictEqual(
        said.flatMap((deliveries) => deliveries.filter(Delivery.$is("Listing")).map(({ league }) => league)),
        ["fbs"]
      )
    })
  )

  it.effect("should make a poll of every league one span, with each league's poll inside it", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* polledOnce(recordedHttp(fbsLive), { ended })

      const polls = ended.filter((span) => span.name === "EspnProvider.pollEveryLeague")
      const inside = ended.filter(
        (span) =>
          span.name === "EspnProvider.poll" &&
          Option.exists(span.parent, (parent) => parent.spanId === polls[0]?.spanId)
      )
      assert.strictEqual(polls.length, 1)
      assert.deepStrictEqual(polls[0]?.attributes.get("sportal.leagues"), ["nfl", "fbs"])
      assert.deepStrictEqual(polls[0]?.attributes.get("sportal.failed_leagues"), [])
      assert.deepStrictEqual(
        inside.map((span) => span.attributes.get("sportal.league")),
        ["nfl", "fbs"]
      )
    })
  })

  it.effect("should record each poll's duration", () =>
    Effect.gen(function* () {
      const live = scoreboardOf([{ state: "in", period: 2 }])
      yield* polledOver("10 seconds", { fbs: live })

      const metrics = yield* Metric.snapshot

      const duration = metrics.find((metric) => metric.id === "sportal_poll_duration")
      assert.strictEqual(duration?.type === "Histogram" ? duration.state.count : undefined, 2)
    }).pipe(withMetrics)
  )

  it.effect("should give each run of its deliveries every frame", () =>
    Effect.gen(function* () {
      const first = yield* listedBy("nfl")
      const second = yield* listedBy("nfl")

      assert.strictEqual(first.length, 16)
      assert.strictEqual(second.length, 16)
    }).pipe(Effect.provide(recordedEspn(fbsLive)))
  )

  it.effect("should deliver FastCast's frames beside its polls", () =>
    Effect.gen(function* () {
      const pushed = Frame.Pushed({
        topic: Option.some(Topic.Scoreboard({ league: "nfl" })),
        mid: Option.none(),
        body: "{}"
      })
      const espn = espnOver(recordedHttp(fbsLive), { leagues: "fbs", pushing: Stream.make(pushed) })

      const said = yield* Provider.use((provider) =>
        provider.deliveries.pipe(Stream.take(2), Stream.runCollect)
      ).pipe(Effect.provide(espn))

      assert.deepStrictEqual(
        said.map((deliveries) => deliveries.map(({ _tag }) => _tag)).toSorted((a, b) => a.length - b.length),
        [[], ["Listing"]],
        "the push, which says nothing, beside the poll's listing"
      )
    })
  )

  it.effect("should deliver a push taken between two leagues' polls after the first league's listing", () =>
    Effect.gen(function* () {
      const live = scoreboardOf([{ state: "in", period: 2 }])
      const checkpoint = Frame.Checkpoint({
        topic: Topic.Scoreboard({ league: "nfl" }),
        mid: 1,
        body: JSON.stringify({ sports: [{ leagues: [{ events: JSON.parse(live).events }] }] })
      })
      const fbsSlow = HttpClient.make((request) =>
        request.url.includes("/nfl/")
          ? Effect.succeed(answered(request, live))
          : Effect.sleep("10 seconds").pipe(Effect.as(answered(request, fbsLive)))
      )
      const pushedAt5s = Stream.fromEffect(Effect.sleep("5 seconds")).pipe(Stream.as(checkpoint))
      const espn = espnOver(fbsSlow, { pushing: pushedAt5s })

      const said = yield* Effect.gen(function* () {
        const provider = yield* Provider
        const frames = yield* Queue.unbounded<ReadonlyArray<Delivery>>()
        yield* provider.deliveries.pipe(
          Stream.runForEach((deliveries) => Queue.offer(frames, deliveries)),
          Effect.forkScoped({ startImmediately: true })
        )
        yield* TestClock.adjust("10 seconds")
        return yield* Queue.takeBetween(frames, 3, 3)
      }).pipe(Effect.provide(espn), Effect.scoped)

      assert.deepStrictEqual(
        said.map((deliveries) =>
          deliveries.map((one) => (Delivery.$is("Listing")(one) ? `Listing ${one.league}` : one._tag))
        ),
        [["Listing nfl"], ["Snapshot"], ["Listing fbs"]]
      )
    })
  )

  it.effect(
    "should poll every 10 seconds after a push shows a game live that the poll still shows upcoming",
    () =>
      Effect.gen(function* () {
        const soon = scoreboardOf([{ state: "pre", period: 0, kickoff: "2026-10-03T12:20Z" }])
        const live = JSON.parse(scoreboardOf([{ state: "in", period: 2, kickoff: "2026-10-03T12:20Z" }]))
        const checkpoint = Frame.Checkpoint({
          topic: Topic.Scoreboard({ league: "fbs" }),
          mid: 1,
          body: JSON.stringify({ sports: [{ leagues: [{ events: live.events }] }] })
        })
        const pushedAt30s = Stream.fromEffect(Effect.sleep("30 seconds")).pipe(Stream.as(checkpoint))

        const polled = yield* polledOver(["1 minute", "10 seconds"], { fbs: soon }, pushedAt30s)

        assert.deepStrictEqual(polled, [0, 60_000, 70_000])
      })
  )

  it.effect("should tell FastCast to follow every league's scoreboard topic from the start", () =>
    Effect.gen(function* () {
      const unanswered = HttpClient.make(() => Effect.never)

      const told = yield* toldOver(unanswered, "fbs", [])

      const [first] = told
      assert.deepStrictEqual(first === undefined ? [] : [...HashMap.entries(first)], [
        [Topic.Scoreboard({ league: "fbs" }), "AwaitingCheckpoint"]
      ])
    })
  )

  it.effect("should want a game's topic once its kickoff is 30 minutes away, with no frame", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.makeUnsafe("2026-10-03T12:00:00Z").epochMilliseconds)
      const later = scoreboardOf([{ state: "pre", period: 0, kickoff: "2026-10-03T12:31Z" }])
      const [event] = decodeEventIds(later).events
      const game = Topic.Game({ league: "fbs", game: event.id })
      const answering = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(later)))
      )

      const told = yield* toldOver(answering, "fbs", ["1 minute"])

      assert.isFalse(
        told.slice(0, -1).some((one) => HashMap.has(one, game)),
        "31 minutes out, it is not followed"
      )
      assert.isTrue(Option.exists(Arr.last(told), (one) => HashMap.has(one, game)))
    })
  )
})

describe("EspnProvider over FastCast", () => {
  // Depends on recorded games 401872974/401872976 being upcoming in the 18:00Z scoreboard and the clock staying at epoch.
  it.effect(
    "should subscribe to a listed live game once, and once more only after a gap in its messages",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const delivered = watched<ReadonlyArray<Delivery>>()
        const subscriptions = () => server.sent.all().filter((sent) => sent.op === "S" && sent.tc === liveTc)

        const counted = yield* Effect.gen(function* () {
          const provider = yield* Provider
          yield* provider.deliveries.pipe(
            Stream.runForEach((deliveries) => Effect.sync(() => delivered.add(deliveries))),
            Effect.forkScoped({ startImmediately: true })
          )
          yield* server.sent.until(subscribed(liveTc, 1))
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

/** `body` without any team's colors. */
function withoutColors(body: string) {
  return JSON.stringify(JSON.parse(body), (key, value) =>
    key === "color" || key === "alternateColor" ? undefined : value
  )
}

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
 * (nothing, unless given) or, when given `wanting`, the frames it gives for what FastCast is told to follow, and each
 * span that ends recorded in `ended`.
 */
function espnOver(
  client: HttpClient.HttpClient,
  options: {
    readonly leagues?: string
    readonly pushing?: Stream.Stream<Frame>
    readonly wanting?: (wanted: Stream.Stream<Wanted>) => Stream.Stream<Frame>
    readonly ended?: Array<Tracer.Span>
  } = {}
) {
  return EspnProvider.layer.pipe(
    Layer.provide([
      FastCast.layerTest(options.wanting ?? (() => options.pushing ?? Stream.never)),
      HubConfig.layerTest({ SPORTAL_LEAGUES: options.leagues ?? "nfl,fbs" }).pipe(Layer.orDie),
      Layer.succeed(HttpClient.HttpClient, client)
    ]),
    Layer.provideMerge(recordingSpans(options.ended ?? []))
  )
}

/**
 * What the first `frames` frames (none, unless given) of ESPN's provider's first poll over `client` said, each span that
 * ends recorded in `ended`.
 */
function polledOnce(
  client: HttpClient.HttpClient,
  options: { readonly leagues?: string; readonly frames?: number; readonly ended?: Array<Tracer.Span> } = {}
) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    const said = yield* Queue.unbounded<ReadonlyArray<Delivery>>()
    yield* provider.deliveries.pipe(
      Stream.runForEach((one) => Queue.offer(said, one)),
      Effect.forkScoped({ startImmediately: true })
    )

    yield* TestClock.adjust(0)

    return yield* Queue.takeBetween(said, options.frames ?? 0, options.frames ?? 0)
  }).pipe(Effect.provide(espnOver(client, options)), Effect.scoped)
}

/** The reason and league of the error each failed `EspnProvider.poll` span among `ended` ended with. */
function pollFailures(ended: ReadonlyArray<Tracer.Span>) {
  return ended
    .filter((span) => span.name === "EspnProvider.poll")
    .flatMap((span) => ("exit" in span.status ? Option.toArray(Exit.findErrorOption(span.status.exit)) : []))
    .filter(Schema.is(ProviderUnavailable))
    .map(({ reason, league }) => [reason, league])
}

// What a league answers when its every poll cannot connect.
const down = "down"

/**
 * The instants, in milliseconds from noon on 2026-10-03, at which ESPN's provider polls as the test clock moves from
 * then by each of `spans`. Each league of `answers` answers its polls in turn (the last answer again once they run
 * out) with a scoreboard body, or cannot connect when the answer is `down`.
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
    const framesOfPoll = (poll: number) => leagues.filter((league) => answerOf(league, poll) !== down).length

    yield* Effect.gen(function* () {
      const provider = yield* Provider
      const frames = yield* Queue.unbounded<ReadonlyArray<Delivery>>()
      yield* provider.deliveries.pipe(
        Stream.runForEach((deliveries) => Queue.offer(frames, deliveries)),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* Queue.takeBetween(frames, framesOfPoll(0), framesOfPoll(0))

      yield* Effect.forEach(Arr.ensure(spans), (span, index) =>
        TestClock.adjust(span).pipe(
          Effect.andThen(Queue.takeBetween(frames, framesOfPoll(index + 1), framesOfPoll(index + 1)))
        )
      )
      yield* TestClock.adjust(0)
    }).pipe(Effect.provide(espnOver(client, { leagues: leagues.join(","), pushing })), Effect.scoped)

    const polled = yield* Ref.get(requests)
    return Arr.dedupe(polled.map(({ at }) => at))
  })
}

/**
 * Each wanted set ESPN's provider over `client`, polling `leagues`, tells FastCast as the test clock moves by each of
 * `spans`.
 */
function toldOver(client: HttpClient.HttpClient, leagues: string, spans: ReadonlyArray<Duration.Input>) {
  return Effect.gen(function* () {
    const told = yield* Ref.make<ReadonlyArray<Wanted>>([])
    const espn = espnOver(client, {
      leagues,
      wanting: (wanted) =>
        wanted.pipe(
          Stream.tap((one) => Ref.update(told, (all) => [...all, one])),
          Stream.drain
        )
    })

    yield* Effect.gen(function* () {
      const provider = yield* Provider
      yield* provider.deliveries.pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
      yield* TestClock.adjust(0)
      yield* Effect.forEach(spans, (span) => TestClock.adjust(span), { discard: true })
    }).pipe(Effect.provide(espn), Effect.scoped)

    return yield* Ref.get(told)
  })
}

/**
 * ESPN's provider polling the NFL over the real FastCast on `server`. Its first poll is answered with the recorded
 * scoreboard of 18:00Z on 2026-10-04, in which NE at BUF is live; each poll after it also shows one more of
 * `laterGames` live. Each checkpoint is an empty game document.
 */
function espnOverFastCast(server: ReturnType<typeof fakeServer>) {
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
  return EspnProvider.layer.pipe(
    Layer.provide([FastCast.layer, HubConfig.layerTest({ SPORTAL_LEAGUES: "nfl" }).pipe(Layer.orDie)]),
    Layer.provide(host)
  )
}

/**
 * Moves the test clock to the next poll and waits for `game`'s first S, which that poll makes wanted. FastCast steers by
 * each wanted set in turn, so every S an earlier frame would send has been sent by then.
 */
function markedByTheNextPoll(server: ReturnType<typeof fakeServer>, game: string) {
  return TestClock.adjust("10 seconds").pipe(
    Effect.andThen(server.sent.until(subscribed(`gp-football-nfl-${game}`, 1)))
  )
}

/** NE at BUF's `H` at `mid`. */
function checkpointAt(mid: number) {
  return { op: "H", tc: liveTc, mid, pl: `https://checkpoint.test/${mid}` }
}

/** Whether at least `count` deliveries of plays have arrived. */
function playsDelivered(count: number) {
  return (all: ReadonlyArray<ReadonlyArray<Delivery>>) =>
    all.flat().filter(Delivery.$is("Plays")).length >= count
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
const laterGames = ["401872974", "401872976"] as const

const decodeEventIds = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ events: Schema.Tuple([Schema.Struct({ id: GameId })]) }))
)

/**
 * An ESPN scoreboard of one game per entry, each the pregame scoreboard's second event kicking off at `kickoff` (the
 * recorded kickoff, unless given), in ESPN's status `state`, named `name` (the recorded name, unless given), in `period`.
 */
function scoreboardOf(
  games: ReadonlyArray<{
    readonly state: "pre" | "in" | "post"
    readonly name?: string
    readonly period: number
    readonly kickoff?: string
  }>
) {
  const scoreboard = JSON.parse(nflPregame)
  const template = scoreboard.events[1]
  const events = games.map(({ state, name, period, kickoff }, index) => ({
    ...template,
    id: `${template.id}${index}`,
    date: kickoff ?? template.date,
    status: {
      ...template.status,
      period,
      type: { ...template.status.type, state, name: name ?? template.status.type.name }
    }
  }))
  return JSON.stringify({ ...scoreboard, events })
}
