import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, FileSystem, Layer, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import { FeedLog } from "./feed-log/FeedLog.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubMode from "./HubMode.ts"
import { Board } from "./slate/Board.ts"

describe("HubMode", () => {
  it.effect("should bring a scenario's polls, appended by Ingest, to the Board", () =>
    Effect.gen(function* () {
      const { published } = yield* playedForASecond.pipe(
        Effect.provide(scenarioHub("bogus-clock-two-minute"))
      )

      assert.isAbove(published.games.length, 0)
    })
  )

  it.effect(
    "should keep a scenario's frames in memory by default, writing no file in the data directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dataDir = yield* fs.makeTempDirectoryScoped()

        const { published, taken } = yield* playedForASecond.pipe(
          Effect.provide(scenarioHub("bogus-clock-two-minute", { SPORTAL_DATA_DIR: dataDir }))
        )

        const files = yield* fs.readDirectory(dataDir)
        assert.isAbove(published.games.length, 0)
        assert.isAbove(taken, 0, "the board took the scenario's frames from the feed log")
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

/** What the board publishes once the scenario has played for a second of the test clock, and how many takes it took. */
const playedForASecond = Effect.gen(function* () {
  const board = yield* Board
  const taken = yield* Ref.make(0)
  const counting = yield* board.taken.pipe(
    Stream.runForEach(() => Ref.update(taken, (count) => count + 1)),
    Effect.forkChild({ startImmediately: true })
  )

  yield* TestClock.adjust(0)
  yield* TestClock.adjust("1 second")
  const latest = yield* board.latest
  yield* Fiber.interrupt(counting)
  const takes = yield* Ref.get(taken)

  return { published: latest.published(), taken: takes }
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
