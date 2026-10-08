import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  Cause,
  Clock,
  DateTime,
  type Duration,
  Effect,
  Exit,
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
import { TestClock } from "effect/testing"
import { HubConfig } from "../../HubConfig.ts"
import { Delivery } from "../../slate/Delivery.ts"
import { counted, recordingLogs, recordingSpans, withMetrics } from "../../TestTelemetry.ts"
import { Provider } from "../Provider.ts"
import { listedBy } from "../TestProvider.ts"
import * as EspnProvider from "./EspnProvider.ts"
import { FastCast } from "./FastCast.ts"
import type { Frame } from "./Frame.ts"
import { ProviderUnavailable } from "./ProviderUnavailable.ts"

// Real payloads recorded from ESPN. A payload that breaks decoding gets added here before the fix.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
const fbsLive = fixture("fbs-scoreboard-live")
const fbsMidday = fixture("fbs-scoreboard-2026-10-03T2024Z")
const nflPregame = fixture("nfl-scoreboard-pregame")

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

      const said = yield* polledOnce(nflDown)

      assert.deepStrictEqual(
        said.flatMap((deliveries) => deliveries.filter(Delivery.guards.Listing).map(({ league }) => league)),
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

  it.effect("should deliver FastCast's frames beside its polls", () =>
    Effect.gen(function* () {
      const pushed: Frame = {
        receivedAt: DateTime.makeUnsafe(0),
        source: "push",
        channel: "event-football-nfl",
        kind: "change",
        body: "{}"
      }
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
 * (nothing, unless given), and each span that ends recorded in `ended`.
 */
function espnOver(
  client: HttpClient.HttpClient,
  options: {
    readonly leagues?: string
    readonly pushing?: Stream.Stream<Frame>
    readonly ended?: Array<Tracer.Span>
  } = {}
) {
  return EspnProvider.layer.pipe(
    Layer.provide([
      FastCast.layerTest(options.pushing ?? Stream.never),
      HubConfig.layerTest({ SPORTAL_LEAGUES: options.leagues ?? "nfl,fbs" }).pipe(Layer.orDie),
      Layer.succeed(HttpClient.HttpClient, client)
    ]),
    Layer.provideMerge(recordingSpans(options.ended ?? []))
  )
}

/** What each frame of ESPN's provider's first poll over `client` said, each span that ends recorded in `ended`. */
function polledOnce(
  client: HttpClient.HttpClient,
  options: { readonly leagues?: string; readonly ended?: Array<Tracer.Span> } = {}
) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    const said = yield* Queue.unbounded<ReadonlyArray<Delivery>>()
    yield* provider.deliveries.pipe(
      Stream.runForEach((one) => Queue.offer(said, one)),
      Effect.forkScoped({ startImmediately: true })
    )

    yield* TestClock.adjust(0)

    return yield* Queue.clear(said)
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
  answers: Partial<Record<LeagueId, string | ReadonlyArray<string>>>
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
    }).pipe(Effect.provide(espnOver(client, { leagues: leagues.join(",") })), Effect.scoped)

    const polled = yield* Ref.get(requests)
    return Arr.dedupe(polled.map(({ at }) => at))
  })
}

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
