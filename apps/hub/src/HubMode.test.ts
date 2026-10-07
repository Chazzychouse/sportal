import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Layer, Option, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import { FeedLog } from "./feed-log/FeedLog.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubMode from "./HubMode.ts"
import { LiveSlate } from "./LiveSlate.ts"

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

        const { published, latest } = yield* playedForASecond.pipe(
          Effect.provide(scenarioHub("bogus-clock-two-minute", { SPORTAL_DATA_DIR: dataDir }))
        )

        const files = yield* fs.readDirectory(dataDir)
        assert.isAbove(published.games.length, 0)
        // The slate's seq is the last frame it took from the feed log, so the scenario's frames were logged.
        assert.isTrue(Option.isSome(latest.seq), "the scenario's frames were logged")
        assert.deepStrictEqual(files, [])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect(
    "should keep a scenario's feed log in the file SPORTAL_SCENARIO_FEED_LOG names, never feed.sqlite",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dataDir = yield* fs.makeTempDirectoryScoped()
        const env = { SPORTAL_DATA_DIR: dataDir, SPORTAL_SCENARIO_FEED_LOG: "scenario.sqlite" }
        yield* playedForASecond.pipe(Effect.provide(scenarioHub("bogus-clock-two-minute", env)))

        const replayed = yield* replayedFrom(dataDir, "scenario.sqlite")

        const files = yield* fs.readDirectory(dataDir)
        assert.isAbove(replayed.length, 0, "the scenario's frames are in its file")
        assert.include(files, "scenario.sqlite")
        assert.notInclude(files, "feed.sqlite")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** The slate's latest and published once the scenario has played for a second of the test clock. */
const playedForASecond = Effect.gen(function* () {
  const liveSlate = yield* LiveSlate

  yield* TestClock.adjust(0)
  yield* TestClock.adjust("1 second")
  const published = yield* liveSlate.published
  const latest = yield* liveSlate.latest

  return { published, latest }
})

/** Every frame the feed log in the file `name` in `dataDir` holds, replayed from the start. */
function replayedFrom(dataDir: string, name: string) {
  const onFile = FeedLog.layer.pipe(
    Layer.provide([Database.layerFile(name), NodeCrypto.layer]),
    Layer.provide(HubConfig.layerTest({ SPORTAL_DATA_DIR: dataDir })),
    Layer.orDie
  )
  return FeedLog.use((log) => Stream.runCollect(log.replay(DateTime.makeUnsafe(0)))).pipe(
    Effect.provide(onFile),
    Effect.scoped
  )
}

/** The Hub's mode on the scenario `name`, configured by `env` beside its name, with an in-memory database. */
function scenarioHub(name: string, env: Record<string, string> = {}) {
  return HubMode.layer.pipe(
    Layer.provide([Database.layerMemory, NodeCrypto.layer, FetchHttpClient.layer]),
    Layer.provide(HubConfig.layerTest({ SPORTAL_SCENARIO: name, ...env }).pipe(Layer.orDie)),
    Layer.provide(NodeServices.layer)
  )
}
