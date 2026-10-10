import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { listedBy } from "../TestProvider.ts"
import * as TestEspn from "./TestEspn.ts"

describe("Espn.layer", () => {
  it.effect("should provide a provider that decodes its own frames", () =>
    Effect.gen(function* () {
      const slate = yield* listedBy("fbs")

      assert.strictEqual(slate.length, 59)
      assert.strictEqual(slate.find((game) => game.id === "401862787")?.status, "live")
    }).pipe(
      Effect.provide(
        TestEspn.recordedEspn({
          nfl: TestEspn.recordedScoreboard("nfl-scoreboard-pregame"),
          fbs: TestEspn.recordedScoreboard("fbs-scoreboard-live")
        })
      )
    )
  )
})
