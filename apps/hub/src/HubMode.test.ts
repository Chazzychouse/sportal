import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import * as HubMode from "./HubMode.ts"
import { Slate } from "./Slate.ts"
import { withEnv } from "./TestHubConfig.ts"

describe("HubMode", () => {
  it.effect("a scenario's polls, appended by Ingest, reach the fold the Slate reads", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("1 second")
      assert.isAbove((yield* (yield* Slate).latest).games.length, 0)
    }).pipe(
      Effect.provide(
        HubMode.layer.pipe(
          Layer.provide([Database.at(":memory:"), NodeCrypto.layer, FetchHttpClient.layer]),
          Layer.provide(withEnv({ SPORTAL_SCENARIO: "two-minute-drill-tie" }).pipe(Layer.orDie)),
          Layer.provide(NodeServices.layer)
        )
      )
    )
  )
})
