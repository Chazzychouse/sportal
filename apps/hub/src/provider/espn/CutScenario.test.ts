import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem } from "effect"
import * as CutScenario from "./CutScenario.ts"

// A real ESPN poll, recorded as the spike's recorder writes them: gzipped, named for the instant.
const poll = gzipSync(readFileSync(new URL("./fixtures/fbs-scoreboard-live.json", import.meta.url)))
const utc = (iso: string) => DateTime.makeUnsafe(iso)

describe("CutScenario.cut", () => {
  it.effect("makes a frame of each poll in the window, timed from the first", () =>
    Effect.gen(function* () {
      const recording = yield* recordingOf(["20261003T160848Z", "20261003T160918Z", "20261003T170000Z"])
      const scenario = yield* CutScenario.cut({
        name: "noon",
        recording,
        from: utc("2026-10-03T16:00:00Z"),
        to: utc("2026-10-03T16:30:00Z"),
        games: []
      })
      assert.deepStrictEqual(
        scenario.frames.map((frame) => frame.at),
        [0, 30_000]
      )
      assert.strictEqual(
        DateTime.toEpochMillis(scenario.origin),
        DateTime.toEpochMillis(utc("2026-10-03T16:08:48Z"))
      )
      assert.strictEqual(scenario.frames[0]?.slate.length, 59)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps only the games named", () =>
    Effect.gen(function* () {
      const recording = yield* recordingOf(["20261003T160848Z"])
      const scenario = yield* CutScenario.cut({
        name: "one",
        recording,
        from: utc("2026-10-03T16:00:00Z"),
        to: utc("2026-10-03T17:00:00Z"),
        games: ["401862787"]
      })
      assert.deepStrictEqual(
        scenario.frames[0]?.slate.map((game) => game.id),
        ["401862787"]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("fails when no poll falls in the window", () =>
    Effect.gen(function* () {
      const recording = yield* recordingOf(["20261003T160848Z"])
      const error = yield* CutScenario.cut({
        name: "none",
        recording,
        from: utc("2026-10-03T20:00:00Z"),
        to: utc("2026-10-03T21:00:00Z"),
        games: []
      }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "CutFailed")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** A recording folder for college football holding the live poll under each of these instants. */
function recordingOf(instants: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const recording = join(yield* fs.makeTempDirectoryScoped(), "college-football")
    yield* fs.makeDirectory(join(recording, "scoreboard"), { recursive: true })
    for (const instant of instants)
      yield* fs.writeFile(join(recording, "scoreboard", `${instant}.json.gz`), poll)
    return recording
  })
}
