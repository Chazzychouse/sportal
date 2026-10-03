import { assert, layer } from "@effect/vitest"
import { SportalApi } from "@sportal/api/SportalApi"
import { GameId } from "@sportal/domain/Game"
import { snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer } from "effect"
import { HttpServer } from "effect/http"
import { HttpApiTest } from "effect/http-api"
import { Ingest } from "../ingest/Ingest.ts"
import { Provider } from "../provider/Provider.ts"
import * as YouTubeTv from "../source/YouTubeTv.ts"
import { StageSessions } from "../stage/StageSessions.ts"
import { ApiHandlers } from "./HubServer.ts"

const game = snapshot({
  id: GameId.make("401856707"),
  home: { team: team("MSST"), score: 0 },
  away: { team: team("ALA"), score: 0 },
  broadcasts: ["ESPN"]
})

const TestHub = ApiHandlers.pipe(
  Layer.provide(StageSessions.layer),
  Layer.provide(YouTubeTv.layer({ ESPN: "https://tv.youtube.com/watch/espn" })),
  Layer.provide(Ingest.layer(["fbs"])),
  Layer.provide(Layer.succeed(Provider, Provider.of({ slate: () => Effect.succeed([game]) })))
)

const makeClient = HttpApiTest.groups(SportalApi, ["slate", "stage"])

layer(Layer.mergeAll(TestHub, HttpServer.layerServices))("Hub API", (it) => {
  it.effect("serves the slate and turns an assignment into a stream tile", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      // Let the ingest loop's first poll run.
      yield* Effect.yieldNow

      const slate = yield* client.slate.current()
      assert.strictEqual(slate[0]?.away.team.abbreviation, "ALA")
      assert.isTrue(DateTime.isDateTime(slate[0]?.kickoff))

      const stage = yield* client.stage.dispatch({
        payload: { command: { _tag: "Assign", tile: 0, game: game.id } }
      })
      assert.deepStrictEqual(stage.tiles[0], {
        _tag: "StreamTile",
        game: game.id,
        locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/espn" }
      })

      const rejected = yield* client.stage
        .dispatch({ payload: { command: { _tag: "Clear", tile: 9 } } })
        .pipe(Effect.flip)
      assert.strictEqual(rejected._tag, "StageRejection")
    })
  )
})
