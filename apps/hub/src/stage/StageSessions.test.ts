import { assert, describe, it } from "@effect/vitest"
import { GameId, Network } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Layer, Stream } from "effect"
import * as Database from "../database/Database.ts"
import { Ingest } from "../ingest/Ingest.ts"
import { Source } from "../source/Source.ts"
import * as SqlChannelStore from "../source/SqlChannelStore.ts"
import * as YouTubeTv from "../source/YouTubeTv.ts"
import { StageSessions } from "./StageSessions.ts"

const espn = Network.make("ESPN")
const espnPlus = Network.make("ESPN+")
const espnChannel = {
  network: espn,
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn?vp=0gEEEgIwAQ%3D%3D" }
}
const slate = [game("1", [espn]), game("2", [espn]), game("3", [espn]), game("4", [espnPlus])]

const TestSessions = StageSessions.layer.pipe(
  Layer.provide(Layer.succeed(Ingest, Ingest.of({ slate: Effect.succeed(slate), changes: Stream.empty }))),
  Layer.provide(sourceKnowingEspn())
)

describe("StageSessions", () => {
  it.effect("applies concurrent commands without losing any", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* Effect.all(
        slate.map((snapshot, tile) => sessions.dispatch({ _tag: "Assign", tile, game: snapshot.id })),
        { concurrency: "unbounded" }
      )
      const stage = yield* sessions.stage
      assert.isTrue(stage.tiles.every((tile) => tile._tag !== "Empty"))
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("rejects a command for a missing tile and leaves the stage unchanged", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
      const before = yield* sessions.stage
      const rejection = yield* sessions.dispatch({ _tag: "FocusAudio", tile: 9 }).pipe(Effect.flip)
      assert.strictEqual(rejection.reason, "no-such-tile")
      assert.deepStrictEqual(yield* sessions.stage, before)
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("assigns a carried game as a stream tile and any other as a data tile", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
      const stage = yield* sessions.dispatch({ _tag: "Assign", tile: 1, game: GameId.make("4") })
      assert.deepStrictEqual(stage.tiles[0], {
        _tag: "StreamTile",
        game: GameId.make("1"),
        channel: espnChannel
      })
      assert.deepStrictEqual(stage.tiles[1], { _tag: "DataTile", game: GameId.make("4") })
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("assigns a game missing from the slate as a data tile", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      const stage = yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("gone") })
      assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: GameId.make("gone") })
    }).pipe(Effect.provide(TestSessions))
  )
})

function game(id: string, broadcasts: ReadonlyArray<Network>) {
  return snapshot({ id: GameId.make(id), status: "live", period: 1, clock: "10:00", broadcasts })
}

/** YouTube TV over an in-memory database, already knowing ESPN's channel and that ESPN+ is not carried. */
function sourceKnowingEspn() {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, "https://tv.youtube.com/watch/espn")
      yield* source.markNotCarried(espnPlus)
    })
  ).pipe(
    Layer.provideMerge(YouTubeTv.layer),
    Layer.provide(SqlChannelStore.layer),
    Layer.provide(Database.layer(":memory:"))
  )
}
