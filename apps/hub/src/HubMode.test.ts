import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
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
    }).pipe(Effect.provide(scenarioHub("bogus-clock-two-minute")))
  )

  it.effect(
    "should keep a scenario's frames in memory by default, writing no file in the data directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dataDir = yield* fs.makeTempDirectoryScoped()

        const published = yield* Effect.gen(function* () {
          const liveSlate = yield* LiveSlate
          yield* TestClock.adjust(0)
          yield* TestClock.adjust("1 second")
          return yield* liveSlate.published
        }).pipe(Effect.provide(scenarioHub("bogus-clock-two-minute", { SPORTAL_DATA_DIR: dataDir })))

        const files = yield* fs.readDirectory(dataDir)
        assert.isAbove(published.games.length, 0, "the scenario's frames were logged")
        assert.deepStrictEqual(files, [])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** The Hub's mode on the scenario `name`, configured by `env` beside its name, with an in-memory database. */
function scenarioHub(name: string, env: Record<string, string> = {}) {
  return HubMode.layer.pipe(
    Layer.provide([Database.layerMemory, NodeCrypto.layer, FetchHttpClient.layer]),
    Layer.provide(withEnv({ SPORTAL_SCENARIO: name, ...env }).pipe(Layer.orDie)),
    Layer.provide(NodeServices.layer)
  )
}
