import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import * as HubMode from "./HubMode.ts"
import { LiveSlate } from "./LiveSlate.ts"
import { withEnv } from "./TestHubConfig.ts"

describe("HubMode", () => {
  it.effect("should bring a scenario's polls, appended by Ingest, to the LiveSlate", () =>
    Effect.gen(function* () {
      const liveSlate = yield* LiveSlate

      yield* TestClock.adjust(0)
      yield* TestClock.adjust("1 second")
      const published = yield* liveSlate.published

      assert.isAbove(published.games.length, 0)
    }).pipe(Effect.provide(scenarioHub("two-minute-drill-tie")))
  )
})

/** The Hub's mode on the scenario `name`, with an in-memory database. */
function scenarioHub(name: string) {
  return HubMode.layer.pipe(
    Layer.provide([Database.layerMemory, NodeCrypto.layer, FetchHttpClient.layer]),
    Layer.provide(withEnv({ SPORTAL_SCENARIO: name }).pipe(Layer.orDie)),
    Layer.provide(NodeServices.layer)
  )
}
