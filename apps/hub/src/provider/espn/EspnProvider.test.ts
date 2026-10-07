import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "@sportal/domain/Game"
import { Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { Cause, DateTime, Duration, Effect, Layer, Schedule } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { listedBy } from "../../TestFeed.ts"
import { Provider } from "../Provider.ts"
import * as EspnDecode from "./EspnDecode.ts"
import * as EspnProvider from "./EspnProvider.ts"
import { FastCast } from "./FastCast.ts"
import { noSocket } from "./TestEspn.ts"

// Real payloads recorded from ESPN. A payload that breaks decoding gets added here before the fix.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
const fbsLive = fixture("fbs-scoreboard-live")
const fbsMidday = fixture("fbs-scoreboard-2026-10-03T2024Z")
const nflPregame = fixture("nfl-scoreboard-pregame")

const recordedEspn = (fbs: string) =>
  Layer.merge(
    EspnProvider.layer.pipe(
      Layer.provide(FastCast.layer),
      Layer.provide(noSocket),
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(request.url.includes("/nfl/") ? nflPregame : fbs, {
                  headers: { date: "Sun, 04 Oct 2026 18:00:00 GMT" }
                })
              )
            )
          )
        )
      )
    ),
    EspnDecode.layer
  )

const TestLayer = recordedEspn(fbsLive)

describe("EspnProvider", () => {
  it.effect("a poll is the scoreboard's body untouched, sent when its Date header says", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const frame = yield* provider.poll("nfl")

      assert.strictEqual(frame.body, nflPregame)
      assert.deepStrictEqual([frame.feed, frame.channel, frame.kind], ["poll", "nfl", "response"])
      assert.strictEqual(
        frame.sentAt?.epochMilliseconds,
        DateTime.makeUnsafe("2026-10-04T18:00:00Z").epochMilliseconds
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("decodes a live FBS scoreboard into snapshots", () =>
    Effect.gen(function* () {
      const slate = yield* listedBy("fbs")

      assert.strictEqual(slate.length, 59)
      const game = slate.find((g) => g.id === "401862787")
      assert.strictEqual(game?.status, "live")
      assert.strictEqual(game?.away.team.abbreviation, "MEM")
      assert.strictEqual(game?.away.team.id, "fbs:235")
      assert.strictEqual(game?.away.score, 27)
      assert.deepStrictEqual(game?.broadcasts, [{ network: Network.make("ESPN+"), medium: "streaming" }])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("keeps television and streaming broadcasts and drops radio", () =>
    Effect.gen(function* () {
      const game = (yield* listedBy("fbs")).find((g) => g.id === "401856710")

      assert.deepStrictEqual(game?.broadcasts, [{ network: Network.make("ESPN"), medium: "tv" }])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("keeps each team's location and short name", () =>
    Effect.gen(function* () {
      const game = (yield* listedBy("fbs")).find((g) => g.id === "401862787")

      assert.strictEqual(game?.home.team.location, "Charlotte")
      assert.strictEqual(game?.home.team.shortName, "Charlotte")
      assert.strictEqual(game?.home.team.name, "Charlotte 49ers")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("leaves out what ESPN reports with placeholder values", () =>
    Effect.gen(function* () {
      const game = (yield* listedBy("fbs")).find((g) => g.id === "401862787")

      // ESPN sends rank 99 for an unranked team and down -1 between plays.
      assert.strictEqual(game?.home.ranking, undefined)
      assert.strictEqual(game?.situation?.down, undefined)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("decodes an NFL scoreboard, namespacing team ids by league", () =>
    Effect.gen(function* () {
      const slate = yield* listedBy("nfl")

      assert.strictEqual(slate.length, 16)
      assert.isTrue(slate.every((game) => game.league === "nfl" && game.home.team.id.startsWith("nfl:")))
      assert.isTrue(slate.some((game) => game.status === "scheduled" && game.situation === undefined))
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("orients the yard line for the team with the ball: ESPN counts it from the home goal line", () =>
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

  describe("polling", () => {
    const now = DateTime.makeUnsafe("2026-10-03T12:00:00Z")
    const at = (iso: string) => DateTime.makeUnsafe(iso)

    it.effect("10 s while a game is live", () =>
      waits([liveSnapshot({ kickoff: at("2026-10-03T11:00:00Z") })], [], Duration.seconds(10))
    )
    it.effect("10 s while the only game is delayed in the second quarter", () =>
      waits(
        [snapshot({ status: "delayed", period: 2, kickoff: at("2026-10-03T11:00:00Z") })],
        [],
        Duration.seconds(10)
      )
    )
    it.effect("1 min when a kickoff is within 30 minutes", () =>
      waits([snapshot({ kickoff: at("2026-10-03T12:20:00Z") })], [], Duration.minutes(1))
    )
    it.effect("1 min when a game delayed before kickoff is within 30 minutes", () =>
      waits([snapshot({ status: "delayed", kickoff: at("2026-10-03T12:20:00Z") })], [], Duration.minutes(1))
    )
    it.effect("15 min when the next kickoff is more than 30 minutes away", () =>
      waits([snapshot({ kickoff: at("2026-10-03T13:00:00Z") })], [], Duration.minutes(15))
    )
    it.effect("15 min when a game delayed before kickoff is more than 30 minutes away", () =>
      waits([snapshot({ status: "delayed", kickoff: at("2026-10-03T13:00:00Z") })], [], Duration.minutes(15))
    )
    it.effect("30 s after a failed poll with an empty slate", () => waits([], ["fbs"], Duration.seconds(30)))
    it.effect("10 s after a failed poll during a live game", () =>
      waits([liveSnapshot({ kickoff: at("2026-10-03T11:00:00Z") })], ["fbs"], Duration.seconds(10))
    )

    /** Checks the wait ESPN's polling Schedule gives after a poll that left `slate` and `failed`, at `now`. */
    function waits(
      slate: ReadonlyArray<GameSnapshot>,
      failed: ReadonlyArray<LeagueId>,
      expected: Duration.Duration
    ) {
      return Effect.gen(function* () {
        const step = yield* Schedule.toStep((yield* Provider).polling)
        const [, delay] = yield* step(now.epochMilliseconds, { slate, failed })
        assert.deepStrictEqual(delay, expected)
      }).pipe(Effect.provide(TestLayer))
    }
  })

  it.effect("a poll that fails to connect is Unreachable for its league; a non-2xx is Refused", () =>
    Effect.gen(function* () {
      const failing = (respond: () => Effect.Effect<Response, Cause.UnknownError>) =>
        EspnProvider.layer.pipe(
          Layer.provide(FastCast.layer),
          Layer.provide(noSocket),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
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
          )
        )
      const unreachable = yield* Provider.use((provider) => Effect.flip(provider.poll("nfl"))).pipe(
        Effect.provide(failing(() => Effect.fail(new Cause.UnknownError("ECONNREFUSED"))))
      )
      const refused = yield* Provider.use((provider) => Effect.flip(provider.poll("fbs"))).pipe(
        Effect.provide(failing(() => Effect.succeed(new Response("busy", { status: 503 }))))
      )

      assert.deepStrictEqual([unreachable.reason, unreachable.league], ["Unreachable", "nfl"])
      assert.deepStrictEqual([refused.reason, refused.league], ["Refused", "fbs"])
    })
  )
})
