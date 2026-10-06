import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import { DateTime, Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Provider } from "../Provider.ts"
import { listedBy } from "../TestProvider.ts"
import * as EspnProvider from "./EspnProvider.ts"

// Real payloads recorded from ESPN. A payload that breaks decoding gets added here before the fix.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
const fbsLive = fixture("fbs-scoreboard-live")
const fbsMidday = fixture("fbs-scoreboard-2026-10-03T2024Z")
const nflPregame = fixture("nfl-scoreboard-pregame")

const recordedEspn = (fbs: string) =>
  EspnProvider.layer.pipe(
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
})
