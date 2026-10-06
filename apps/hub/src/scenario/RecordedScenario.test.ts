import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Path } from "effect"
import { RecordedScenario } from "./RecordedScenario.ts"

describe("RecordedScenario", () => {
  it.effect("lists the names in the folder", () =>
    Effect.gen(function* () {
      const names = yield* RecordedScenario.names()
      assert.include(names, "late-go-ahead-cascade")
      assert.include(names, "uk-sc-tying-drive-solo")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("loads a frames file in order, starting at its first frame's receipt", () =>
    Effect.gen(function* () {
      const scenario = yield* RecordedScenario.load("late-go-ahead-cascade")
      const received = scenario.frames.map(({ receivedAt }) => receivedAt.epochMilliseconds)

      assert.isAbove(scenario.frames.length, 100)
      assert.deepStrictEqual(
        received,
        received.toSorted((a, b) => a - b)
      )
      assert.deepStrictEqual(scenario.origin(), DateTime.makeUnsafe("2026-10-04T20:00:07.418Z"))
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("a file that is not gzip'd frames is ScenarioUnreadable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString((yield* Path.Path).join(dir, "broken.frames.jsonl.gz"), "not gzip")
      const error = yield* RecordedScenario.load("broken", dir).pipe(Effect.flip)
      assert.strictEqual(error._tag, "ScenarioUnreadable")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("a name not in the folder is ScenarioUnknown, listing the names that are", () =>
    Effect.gen(function* () {
      const error = yield* RecordedScenario.load("nope").pipe(Effect.flip)
      assert.strictEqual(error._tag, "ScenarioUnknown")
      assert.include(error._tag === "ScenarioUnknown" ? error.known : [], "late-go-ahead-cascade")
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
