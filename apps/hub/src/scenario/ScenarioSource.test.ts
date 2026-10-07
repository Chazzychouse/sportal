import { assert, describe, it } from "@effect/vitest"
import { broadcast, snapshot } from "@sportal/domain/TestGame"
import { Effect, Stream } from "effect"
import { Source } from "../source/Source.ts"
import * as ScenarioSource from "./ScenarioSource.ts"

describe("ScenarioSource", () => {
  it.effect("should carry every game on its synthetic stream page, named for its first network", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const availability = yield* source.availability
      const game = snapshot({ broadcasts: [broadcast("CBS"), broadcast("Paramount+", "streaming")] })

      const carried = availability(game)

      assert.strictEqual(carried._tag, "Carried")
      if (carried._tag !== "Carried") return
      assert.deepStrictEqual(carried.channel, {
        name: "CBS",
        source: "Scenario",
        locator: { _tag: "WebView", url: "/scenario-stream/1" }
      })
    }).pipe(Effect.provide(ScenarioSource.layer))
  )

  it.effect("should call a game with no network's channel Scenario", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const availability = yield* source.availability

      const carried = availability(snapshot())

      assert.strictEqual(carried._tag === "Carried" ? carried.channel.name : undefined, "Scenario")
    }).pipe(Effect.provide(ScenarioSource.layer))
  )

  it.effect("should read no guide, never changing", () =>
    Effect.gen(function* () {
      const source = yield* Source

      yield* source.readGuide("{}")

      const changes = yield* Stream.runCount(source.changes)
      assert.strictEqual(changes, 0)
    }).pipe(Effect.provide(ScenarioSource.layer))
  )
})
