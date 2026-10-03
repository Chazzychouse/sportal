import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Layer, Option, Stream } from "effect"
import { Ingest } from "../ingest/Ingest.ts"
import { Source } from "../source/Source.ts"
import { StageSessions } from "./StageSessions.ts"

function game(id: string, broadcasts: ReadonlyArray<string>) {
  return snapshot({ id: GameId.make(id), status: "live", period: 1, clock: "10:00", broadcasts })
}

const slate = [game("1", ["ESPN"]), game("2", ["ESPN"]), game("3", ["ESPN"]), game("4", ["Local"])]

const TestSessions = StageSessions.layer.pipe(
  Layer.provide(Layer.succeed(Ingest, Ingest.of({ slate: Effect.succeed(slate), changes: Stream.empty }))),
  Layer.provide(
    Layer.succeed(
      Source,
      Source.of({
        locate: (snapshot) =>
          snapshot.broadcasts.includes("ESPN")
            ? Option.some({ _tag: "WebView", url: `https://tv.example/${snapshot.id}` })
            : Option.none()
      })
    )
  )
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
      assert.strictEqual(rejection._tag, "StageRejection")
      assert.deepStrictEqual(yield* sessions.stage, before)
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("assigns a locatable game as a stream tile and any other as a data tile", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
      const stage = yield* sessions.dispatch({ _tag: "Assign", tile: 1, game: GameId.make("4") })
      assert.deepStrictEqual(stage.tiles[0], {
        _tag: "StreamTile",
        game: GameId.make("1"),
        locator: { _tag: "WebView", url: "https://tv.example/1" }
      })
      assert.deepStrictEqual(stage.tiles[1], { _tag: "DataTile", game: GameId.make("4") })
    }).pipe(Effect.provide(TestSessions))
  )
})
