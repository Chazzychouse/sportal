import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Scenario } from "@sportal/domain/Scenario"
import { Context, DateTime, Effect, FileSystem, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Ingest } from "../ingest/Ingest.ts"
import { Provider } from "../provider/Provider.ts"
import * as TestCluster from "../TestCluster.ts"
import * as ScenarioClock from "./ScenarioClock.ts"
import * as ScenarioProvider from "./ScenarioProvider.ts"

describe("ScenarioProvider", () => {
  it.effect("answers each league with the scenario's slate at the time since it started", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      assert.strictEqual((yield* provider.slate("fbs")).length, 4)
      assert.deepStrictEqual(yield* provider.slate("nfl"), [])

      yield* TestClock.adjust("2 minutes")
      const tie = (yield* provider.slate("fbs")).find((game) => game.id === "tie-uga-ala")
      assert.isTrue(tie?.situation?.isRedZone)
    }).pipe(
      Effect.provide(ScenarioProvider.layer("two-minute-drill-tie").pipe(Layer.provide(NodeServices.layer)))
    )
  )

  it.effect("plays a recorded slice from its folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const slice = Scenario.build("slice", [
        {
          id: "9",
          home: "UGA",
          away: "ALA",
          timeline: [["0:00", { status: "live", period: 1, clock: "15:00" }]]
        }
      ])
      yield* fs.writeFileString(
        join(dir, "slice.json"),
        yield* Schema.encodeEffect(Schema.fromJsonString(Scenario))(slice)
      )

      const slate = yield* Effect.gen(function* () {
        return yield* (yield* Provider).slate("fbs")
      }).pipe(Effect.provide(ScenarioProvider.layer("slice", dir)))
      assert.deepStrictEqual(
        slate.map((game) => game.id),
        ["9"]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("plays every slice committed in the folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const names = (yield* fs.readDirectory(ScenarioProvider.folder))
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -".json".length))
      assert.isAbove(names.length, 0)
      for (const name of names) {
        const provider = yield* Provider.pipe(Effect.provide(ScenarioProvider.layer(name)))
        const slate = [...(yield* provider.slate("fbs")), ...(yield* provider.slate("nfl"))]
        assert.isAbove(slate.length, 0, `${name} has games at its start`)
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("fails to load a slice that no longer decodes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(
        join(dir, "stale.json"),
        JSON.stringify({ name: "stale", origin: 7, frames: [] })
      )
      const exit = yield* Layer.build(ScenarioProvider.layer("stale", dir)).pipe(Effect.exit)
      assert.isTrue(exit._tag === "Failure")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("refuses a name it does not know, listing the names it does", () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const error = yield* Layer.build(ScenarioProvider.layer("../../etc/passwd", dir)).pipe(Effect.flip)
      assert.strictEqual(error._tag, "ScenarioUnknown")
      assert.include(error.message, "two-minute-drill-tie")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("plays at the scenario's speed under Ingest, while the rest of the Hub keeps real time", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Ingest.layer(["fbs"]).pipe(
          Layer.provide([ScenarioProvider.layer("two-minute-drill-tie"), TestCluster.gameActors]),
          Layer.provide(ScenarioClock.layer(10)),
          Layer.provide(NodeServices.layer)
        )
      )
      // 13 real seconds are 130 scenario seconds: the drive is at the 17, in the red zone, since 2:00.
      yield* TestClock.adjust("13 seconds")
      const tie = (yield* Context.get(context, Ingest).slate).find((game) => game.id === "tie-uga-ala")
      assert.isTrue(tie?.situation?.isRedZone)
      assert.strictEqual(DateTime.toEpochMillis(yield* DateTime.now), 13_000)
    }).pipe(Effect.scoped)
  )
})
