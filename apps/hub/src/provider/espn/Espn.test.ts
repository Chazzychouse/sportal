import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { withEnv } from "../../TestHubConfig.ts"
import { listedBy } from "../TestDecoder.ts"
import * as Espn from "./Espn.ts"
import { noSocket } from "./TestEspn.ts"

const fbsLive = readFileSync(new URL("./fixtures/fbs-scoreboard-live.json", import.meta.url), "utf8")

describe("Espn.layer", () => {
  it.effect("should provide a provider and a decoder that decodes its frames", () =>
    Effect.gen(function* () {
      const slate = yield* listedBy("fbs")

      assert.strictEqual(slate.length, 59)
      assert.strictEqual(slate.find((game) => game.id === "401862787")?.status, "live")
    }).pipe(Effect.provide(recordedEspn()))
  )
})

/** ESPN live over a recorded FBS scoreboard, with FastCast that opens no socket and the default Hub config. */
function recordedEspn() {
  const recordedHttp = HttpClient.make((request) => {
    const response = new Response(fbsLive, { headers: { date: "Sun, 04 Oct 2026 18:00:00 GMT" } })
    return Effect.succeed(HttpClientResponse.fromWeb(request, response))
  })
  return Espn.layer.pipe(
    Layer.provide([noSocket, withEnv({}).pipe(Layer.orDie)]),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, recordedHttp))
  )
}
