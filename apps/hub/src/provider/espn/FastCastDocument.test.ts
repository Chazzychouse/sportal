import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Effect, FileSystem, Layer, Metric, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { counted, withMetrics } from "../../TestTelemetry.ts"
import * as EspnPayload from "./EspnPayload.ts"
import * as EspnProvider from "./EspnProvider.ts"
import * as FastCastDocument from "./FastCastDocument.ts"
import * as FastCastPayload from "./FastCastPayload.ts"

// Recorded from ESPN on 2026-10-04: the NFL checkpoint at 17:52Z, every message on its topic after it until 18:00Z,
// each line one socket text as it arrived, and the scoreboard polled at 18:00Z.
const checkpoint = "nfl-fastcast-checkpoint-2026-10-04T1752Z.json"
const messages = "nfl-fastcast-messages-2026-10-04T1752Z.jsonl"
const scoreboard = "nfl-scoreboard-2026-10-04T1800Z.json"

const readFixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(`${import.meta.dirname}/fixtures/${name}`)
  })

const recordedMessages = readFixture(messages).pipe(
  Effect.flatMap((text) => Effect.forEach(text.trim().split("\n"), (line) => decodeRecorded(line)))
)

const decodeRecorded = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.fromJsonString(FastCastPayload.Message))
)

const decodeMessage = Schema.decodeUnknownEffect(FastCastPayload.Message)

// A `P` whose patches are sent as an array, one of the three ways FastCast spells them.
const patchMessage = (mid: number, patches: ReadonlyArray<object>) =>
  decodeMessage({
    op: "P",
    tc: "event-football-nfl",
    mid,
    pl: JSON.stringify({ ts: 1791136341731, pl: patches })
  })

const ariAtNyg = "s:20~l:28~e:401872966~c:401872966"

// Answers every request, whatever its URL, with the recorded checkpoint.
const recordedCheckpoint = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(readFixture(checkpoint), (body) =>
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body))))
  )
)

const TestLayer = Layer.merge(recordedCheckpoint.pipe(Layer.provide(NodeServices.layer)), NodeServices.layer)

const batchesOf = (
  leagues: ReadonlyArray<LeagueId>,
  recorded: ReadonlyArray<typeof FastCastPayload.Message.Type>
) => FastCastDocument.batches(leagues, Stream.fromIterable(recorded)).pipe(Stream.runCollect)

// Each game as the last batch that touched it had it.
const lastOfEach = (batches: ReadonlyArray<ReadonlyArray<GameSnapshot>>) =>
  new Map<string, GameSnapshot>(batches.flat().map((game) => [game.id, game]))

describe("FastCastDocument", () => {
  it.effect("names each league's scoreboard topic", () =>
    Effect.sync(() => {
      assert.strictEqual(FastCastDocument.topic("nfl"), "event-football-nfl")
      assert.strictEqual(FastCastDocument.topic("fbs"), "event-football-college-football")
    })
  )

  it.effect("connecting, subscribing, and a checkpoint give one batch of every game on it", () =>
    Effect.gen(function* () {
      const recorded = yield* recordedMessages
      assert.deepStrictEqual(
        recorded.slice(0, 3).map((message) => message.op),
        ["C", "S", "H"]
      )

      const batches = yield* batchesOf(["nfl"], recorded.slice(0, 3))

      assert.strictEqual(batches.length, 1)
      assert.strictEqual(batches[0]?.length, 16)
      assert.isTrue(
        batches[0]?.every((game) => game.league === "nfl" && game.home.team.id.startsWith("nfl:"))
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("the checkpoint and every message after it end each live game where the scoreboard had it", () =>
    Effect.gen(function* () {
      const pushed = lastOfEach(yield* batchesOf(["nfl"], yield* recordedMessages))
      const polled = yield* readFixture(scoreboard).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(EspnPayload.Scoreboard))),
        Effect.flatMap((board) => EspnProvider.slateOf("nfl", board))
      )
      const live = polled.filter((game) => game.progress() === "live")
      const inPlay = (game: GameSnapshot | undefined) => ({
        status: game?.status,
        period: game?.period,
        clock: game?.clock,
        home: game?.home.score,
        away: game?.away.score,
        down: game?.situation?.down,
        distance: game?.situation?.distance,
        isRedZone: game?.situation?.isRedZone,
        homeTimeouts: game?.situation?.homeTimeouts,
        awayTimeouts: game?.situation?.awayTimeouts,
        lastPlay: game?.situation?.lastPlay
      })

      assert.strictEqual(live.length, 8)
      assert.deepStrictEqual(
        live.map((game) => [game.matchup(), inPlay(pushed.get(game.id))]),
        live.map((game) => [game.matchup(), inPlay(game)])
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("orients the yard line for the team with the ball", () =>
    Effect.gen(function* () {
      const pushed = lastOfEach(yield* batchesOf(["nfl"], yield* recordedMessages))
      const neAtBuf = pushed.get("401872971")?.situation

      assert.strictEqual(neAtBuf?.possession, "nfl:2")
      assert.strictEqual(neAtBuf?.yardLine, 58)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("keeps the team with the ball where the scoreboard drops it", () =>
    Effect.gen(function* () {
      const pushed = lastOfEach(yield* batchesOf(["nfl"], yield* recordedMessages))

      assert.strictEqual(pushed.get("401872968")?.situation?.possession, "nfl:27")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("a missed message fails with Gap", () =>
    Effect.gen(function* () {
      const recorded = yield* recordedMessages
      const error = yield* Effect.flip(batchesOf(["nfl"], [...recorded.slice(0, 20), ...recorded.slice(21)]))

      assert.strictEqual(error.reason, "Gap")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("a patch or an idle message before any checkpoint fails with Gap", () =>
    Effect.gen(function* () {
      const recorded = yield* recordedMessages
      const early = [recorded.slice(3, 4), recorded.slice(6, 7), recorded.slice(8, 9)]
      assert.deepStrictEqual(
        early.flat().map((message) => message.op),
        ["R", "P", "I"]
      )

      const reasons = yield* Effect.forEach(early, (message) =>
        Effect.flip(batchesOf(["nfl"], [...recorded.slice(0, 2), ...message])).pipe(
          Effect.map((error) => error.reason)
        )
      )
      assert.deepStrictEqual(reasons, ["Gap", "Gap", "Gap"])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("an idle message that skips a mid fails with Gap, and is still counted", () =>
    Effect.gen(function* () {
      const recorded = yield* recordedMessages
      const skipping = yield* decodeMessage({ op: "I", tc: "event-football-nfl", mid: 4286639 })
      const error = yield* Effect.flip(batchesOf(["nfl"], [...recorded.slice(0, 3), skipping]))

      assert.strictEqual(error.reason, "Gap")
      assert.strictEqual(yield* counted("sportal_live_feed_messages", { op: "I" }), 1)
    }).pipe(Effect.provide(TestLayer), withMetrics)
  )

  it.effect("a copy adds the value read at its source", () =>
    Effect.gen(function* () {
      const recorded = yield* recordedMessages
      // ARI at NYG: the away team (competitor 0) had 14, the home team 6.
      const copy = yield* patchMessage(4286638, [
        { op: "copy", from: `${ariAtNyg}/competitors/1/score`, path: `${ariAtNyg}/competitors/0/score` }
      ])
      const batches = yield* batchesOf(["nfl"], [...recorded.slice(0, 3), copy])

      assert.strictEqual(batches.length, 2)
      assert.deepStrictEqual(
        batches[1]?.map((game) => [game.id, game.away.score, game.home.score]),
        [["401872966", 6, 6]]
      )
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("a copy from nothing fails with Unapplicable", () =>
    Effect.gen(function* () {
      const recorded = yield* recordedMessages
      const copy = yield* patchMessage(4286638, [
        { op: "copy", from: `${ariAtNyg}/competitors/5/score`, path: `${ariAtNyg}/competitors/0/score` }
      ])
      const error = yield* Effect.flip(batchesOf(["nfl"], [...recorded.slice(0, 3), copy]))

      assert.strictEqual(error.reason, "Unapplicable")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("a patch at a competitor that does not exist fails with Unapplicable", () =>
    Effect.gen(function* () {
      const recorded = yield* recordedMessages
      const unapplicable = yield* patchMessage(4286638, [
        { op: "replace", path: `${ariAtNyg}/competitors/5/score`, value: "21" }
      ])
      const error = yield* Effect.flip(batchesOf(["nfl"], [...recorded.slice(0, 3), unapplicable]))

      assert.strictEqual(error.reason, "Unapplicable")
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("asked only for FBS, the NFL topic gives nothing", () =>
    Effect.gen(function* () {
      const batches = yield* batchesOf(["fbs"], yield* recordedMessages)

      assert.strictEqual(batches.length, 0)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("counts the messages by league and op", () =>
    Effect.gen(function* () {
      yield* batchesOf(["nfl"], yield* recordedMessages)
      const byLeagueAndOp = (yield* Metric.snapshot).flatMap((metric) =>
        metric.id === "sportal_live_feed_messages" && metric.type === "Counter"
          ? [[metric.attributes?.league, metric.attributes?.op, metric.state.count]]
          : []
      )

      assert.sameDeepMembers(byLeagueAndOp, [
        [undefined, "C", 1],
        ["nfl", "S", 1],
        ["nfl", "H", 1],
        ["nfl", "R", 3],
        ["nfl", "P", 81],
        ["nfl", "I", 16]
      ])
      assert.isUndefined(yield* counted("sportal_live_feed_undecoded"), "every event decodes")
    }).pipe(Effect.provide(TestLayer), withMetrics)
  )

  it.effect("counts the games it delivers", () =>
    Effect.gen(function* () {
      const batches = yield* batchesOf(["nfl"], yield* recordedMessages)
      assert.strictEqual(yield* counted("sportal_live_feed_games", { league: "nfl" }), batches.flat().length)
      assert.isAbove(batches.flat().length, 16)
    }).pipe(Effect.provide(TestLayer), withMetrics)
  )
})
