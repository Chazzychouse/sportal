import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, FileSystem, Layer, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import { FeedLog } from "./feed-log/FeedLog.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubMode from "./HubMode.ts"
import { Scenarios } from "./scenario/Scenarios.ts"
import { Board } from "./slate/Board.ts"

describe("HubMode", () => {
  it.effect("should bring a scenario's polls, appended by Ingest, to the Board", () =>
    Effect.gen(function* () {
      const { published } = yield* playedUntilPublished.pipe(
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

        const { published, taken } = yield* playedUntilPublished.pipe(
          Effect.provide(scenarioHub("bogus-clock-two-minute", { SPORTAL_DATA_DIR: dataDir }))
        )

        const files = yield* fs.readDirectory(dataDir)
        assert.isAbove(published.games.length, 0)
        assert.isAbove(taken, 0, "the board took the scenario's frames from the feed log")
        assert.deepStrictEqual(files, [])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("should play a game day from the data directory's feed log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* fs.makeTempDirectoryScoped()
      const config = HubConfig.layerTest({ SPORTAL_DATA_DIR: dataDir }).pipe(Layer.orDie)
      const recorded = yield* Scenarios.use((scenarios) => scenarios.load("bogus-clock-two-minute")).pipe(
        Effect.flatMap(({ frames }) => Stream.runCollect(frames)),
        Effect.provide(Scenarios.layer.pipe(Layer.provide([config, DateTime.layerCurrentZoneLocal])))
      )
      const logged = FeedLog.layerTest(recorded).pipe(
        Layer.provide(Database.layerFile("feed.sqlite")),
        Layer.provide(config),
        Layer.orDie
      )
      const [day = ""] = yield* FeedLog.use((log) => log.days).pipe(
        Effect.provide([logged, DateTime.layerCurrentZoneLocal])
      )

      const { published } = yield* playedUntilPublished.pipe(
        Effect.provide(scenarioHub(day, { SPORTAL_DATA_DIR: dataDir }))
      )

      assert.isAbove(published.games.length, 0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/**
 * What the board publishes once it publishes games, the test clock moved on a second at a time until then, and how many
 * takes it took. A scenario's frames are read from disk as they play, which the test clock does not wait for.
 */
const playedUntilPublished = Effect.gen(function* () {
  const board = yield* Board
  const taken = yield* Ref.make(0)
  const counting = yield* board.taken.pipe(
    Stream.runForEach(() => Ref.update(taken, (count) => count + 1)),
    Effect.forkChild({ startImmediately: true })
  )

  const latest = yield* TestClock.adjust("1 second").pipe(
    Effect.andThen(board.latest),
    Effect.repeat({ until: (slate) => slate.published().games.length > 0 })
  )
  yield* Fiber.interrupt(counting)
  const takes = yield* Ref.get(taken)

  return { published: latest.published(), taken: takes }
})

/** The Hub's mode on the scenario `name`, configured by `env` beside its name, with an in-memory database. */
function scenarioHub(name: string, env: Record<string, string> = {}) {
  return HubMode.layer.pipe(
    Layer.provide([Database.layerMemory, NodeCrypto.layer, FetchHttpClient.layer]),
    Layer.provide(HubConfig.layerTest({ SPORTAL_SCENARIO: name, ...env }).pipe(Layer.orDie)),
    Layer.provide(NodeServices.layer)
  )
}
