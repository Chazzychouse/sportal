import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as TestHub from "../../TestHub.ts"

describe("Espn.layer", () => {
  it.effect("should provide a provider that decodes its own frames", () =>
    Effect.gen(function* () {
      const slate = yield* TestHub.listedBy("fbs")

      assert.strictEqual(slate.length, 59)
      assert.strictEqual(slate.find((game) => game.id === "401862787")?.status, "live")
    }).pipe(
      Effect.provide(
        TestHub.recordedEspn({
          nfl: TestHub.recordedScoreboard("nfl-scoreboard-pregame"),
          fbs: TestHub.recordedScoreboard("fbs-scoreboard-live")
        })
      )
    )
  )
})
