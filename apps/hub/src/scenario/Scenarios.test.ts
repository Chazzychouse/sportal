import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Layer, Path } from "effect"
import { writtenScenarios } from "../TestFeed.ts"
import { Scenarios } from "./Scenarios.ts"
import { scripts } from "./written/Scripts.ts"

describe("Scenarios", () => {
  it.effect("lists every recorded file and every written script, sorted", () =>
    Effect.gen(function* () {
      const files = yield* (yield* FileSystem.FileSystem).readDirectory(fixtures)
      const recorded = files
        .filter((file) => file.endsWith(".frames.jsonl.gz"))
        .map((file) => file.slice(0, -".frames.jsonl.gz".length))
      const names = yield* (yield* Scenarios).names
      assert.lengthOf(scripts, 5)
      assert.deepStrictEqual(names, [...recorded, ...scripts.keys()].sort())
      assert.include(names, "late-go-ahead-cascade")
      assert.include(names, "uk-sc-tying-drive-solo")
    }).pipe(Effect.provide([committed, NodeServices.layer]))
  )

  it.effect("loads a frames file in order, starting at its first frame's receipt", () =>
    Effect.gen(function* () {
      const scenario = yield* (yield* Scenarios).load("late-go-ahead-cascade")
      const received = scenario.frames.map(({ receivedAt }) => receivedAt.epochMilliseconds)

      assert.isAbove(scenario.frames.length, 100)
      assert.deepStrictEqual(
        received,
        received.toSorted((a, b) => a - b)
      )
      assert.deepStrictEqual(scenario.origin(), DateTime.makeUnsafe("2026-10-04T20:00:07.418Z"))
    }).pipe(Effect.provide(committed))
  )

  it.effect("loads a written script as ESPN's frames, the first of them a poll at its start", () =>
    Effect.gen(function* () {
      const scenario = yield* (yield* Scenarios).load("two-minute-drill-tie")
      const [first] = scenario.frames
      assert.strictEqual(scenario.name, "two-minute-drill-tie")
      assert.deepStrictEqual([first?.feed, first?.kind], ["poll", "response"])
      assert.deepStrictEqual(scenario.origin(), DateTime.makeUnsafe("2026-10-03T16:00:00Z"))
    }).pipe(Effect.provide(committed))
  )

  it.effect("a file that is not gzip'd frames is ScenarioUnreadable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString((yield* Path.Path).join(dir, "broken.frames.jsonl.gz"), "not gzip")
      const error = yield* Scenarios.use((scenarios) => scenarios.load("broken")).pipe(
        Effect.provide(Scenarios.in(dir, writtenScenarios)),
        Effect.flip
      )
      assert.strictEqual(error._tag, "ScenarioUnreadable")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("a recorded file named like a written script is ScenarioDuplicate, to list or to load", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString((yield* Path.Path).join(dir, "two-minute-drill-tie.frames.jsonl.gz"), "")
      const errors = yield* Effect.all([
        Scenarios.use((scenarios) => scenarios.names).pipe(Effect.flip),
        Scenarios.use((scenarios) => scenarios.load("kickoff-window")).pipe(Effect.flip)
      ]).pipe(Effect.provide(Scenarios.in(dir, writtenScenarios)))
      assert.deepStrictEqual(
        errors.map((error) => [error._tag, error._tag === "ScenarioDuplicate" && error.name]),
        [
          ["ScenarioDuplicate", "two-minute-drill-tie"],
          ["ScenarioDuplicate", "two-minute-drill-tie"]
        ]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("a name that is neither is ScenarioUnknown, listing the recorded and the written", () =>
    Effect.gen(function* () {
      const error = yield* (yield* Scenarios).load("nope").pipe(Effect.flip)
      assert.strictEqual(error._tag, "ScenarioUnknown")
      assert.include(error._tag === "ScenarioUnknown" ? error.known : [], "late-go-ahead-cascade")
      assert.include(error.message, "late-go-ahead-cascade")
      assert.include(error.message, "two-minute-drill-tie")
    }).pipe(Effect.provide(committed))
  )
})

const fixtures = fileURLToPath(new URL("../../../../fixtures/scenarios/", import.meta.url))

const committed = Scenarios.layer(writtenScenarios).pipe(Layer.provide(NodeServices.layer))
