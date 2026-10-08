import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { HubConfig } from "./HubConfig.ts"
import * as HubMode from "./HubMode.ts"
import { Board } from "./slate/Board.ts"

describe("HubMode", () => {
  it.effect("should bring a scenario's polls to the Board", () =>
    Effect.gen(function* () {
      const published = yield* playedUntilPublished.pipe(
        Effect.provide(scenarioHub("bogus-clock-two-minute"))
      )

      assert.isAbove(published.games.length, 0)
    })
  )
})

/**
 * What the board publishes once it publishes games. A scenario's frames are read from disk as they play, which the test
 * clock does not wait for, so it moves on a second at a time, a moment of real time apart, up to five minutes; a
 * scenario that publishes nothing by then gives what the board has.
 */
const playedUntilPublished = Effect.gen(function* () {
  const board = yield* Board

  const latest = yield* TestClock.adjust("1 second").pipe(
    Effect.andThen(TestClock.withLive(Effect.sleep("10 millis"))),
    Effect.andThen(board.latest),
    Effect.repeat({ until: (slate) => slate.published().games.length > 0, times: 300 })
  )

  return latest.published()
})

/** The Hub's mode on the scenario `name`. */
function scenarioHub(name: string) {
  return HubMode.layer.pipe(
    Layer.provide([NodeCrypto.layer, FetchHttpClient.layer]),
    Layer.provide(HubConfig.layerTest({ SPORTAL_SCENARIO: name }).pipe(Layer.orDie)),
    Layer.provide(NodeServices.layer)
  )
}
