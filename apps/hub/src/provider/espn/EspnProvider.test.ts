import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Provider } from "../Provider.ts"
import * as EspnProvider from "./EspnProvider.ts"

// Real payloads recorded from ESPN. A payload that breaks decoding gets added here before the fix.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
const fbsLive = fixture("fbs-scoreboard-live")
const nflPregame = fixture("nfl-scoreboard-pregame")

const RecordedEspn = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(request.url.includes("/nfl/") ? nflPregame : fbsLive))
    )
  )
)

const TestLayer = EspnProvider.layer.pipe(Layer.provide(RecordedEspn))

describe("EspnProvider", () => {
  it.effect("decodes a live FBS scoreboard into snapshots", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const slate = yield* provider.slate("fbs")

      assert.strictEqual(slate.length, 59)
      const game = slate.find((g) => g.id === "401862787")
      assert.strictEqual(game?.status, "live")
      assert.strictEqual(game?.away.team.abbreviation, "MEM")
      assert.strictEqual(game?.away.team.id, "fbs:235")
      assert.strictEqual(game?.away.score, 27)
      assert.deepStrictEqual(game?.broadcasts, [{ network: Network.make("ESPN+"), medium: "streaming" }])
      assert.strictEqual(game?.situation?.isRedZone, true)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("keeps television and streaming broadcasts and drops radio", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const game = (yield* provider.slate("fbs")).find((g) => g.id === "401856710")

      assert.deepStrictEqual(game?.broadcasts, [{ network: Network.make("ESPN"), medium: "tv" }])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("keeps each team's location and short name", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const game = (yield* provider.slate("fbs")).find((g) => g.id === "401862787")

      assert.strictEqual(game?.home.team.location, "Charlotte")
      assert.strictEqual(game?.home.team.shortName, "Charlotte")
      assert.strictEqual(game?.home.team.name, "Charlotte 49ers")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("leaves out what ESPN reports with placeholder values", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const game = (yield* provider.slate("fbs")).find((g) => g.id === "401862787")

      // ESPN sends rank 99 for an unranked team and down -1 between plays.
      assert.strictEqual(game?.home.ranking, undefined)
      assert.strictEqual(game?.situation?.down, undefined)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("decodes an NFL scoreboard, namespacing team ids by league", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const slate = yield* provider.slate("nfl")

      assert.strictEqual(slate.length, 16)
      assert.isTrue(slate.every((game) => game.league === "nfl" && game.home.team.id.startsWith("nfl:")))
      assert.isTrue(slate.some((game) => game.status === "scheduled" && game.situation === undefined))
    }).pipe(Effect.provide(TestLayer))
  )
})
