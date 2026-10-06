import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem } from "effect"
import * as CutScenario from "./CutScenario.ts"

// A real ESPN poll, recorded as the spike's recorder writes them: gzipped, named for the instant.
const poll = gzipSync(
  readFileSync(new URL("../provider/espn/fixtures/fbs-scoreboard-live.json", import.meta.url))
)
const utc = (iso: string) => DateTime.makeUnsafe(iso)

describe("CutScenario.cut", () => {
  it.effect("makes a frame of each poll in the window, timed from the first", () =>
    Effect.gen(function* () {
      const recording = yield* recordingOf("college-football", [
        "20261003T160848Z",
        "20261003T160918Z",
        "20261003T170000Z"
      ])
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
      const recording = yield* recordingOf("college-football", ["20261003T160848Z"])
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
      const recording = yield* recordingOf("college-football", ["20261003T160848Z"])
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

  it.effect("reads polls named in epoch seconds, timed to the millisecond", () =>
    Effect.gen(function* () {
      const recording = yield* recordingOf("nfl", ["1791130515.585", "1791130525.541"])
      const scenario = yield* CutScenario.cut({
        name: "sunday",
        recording,
        from: DateTime.makeUnsafe(1791130515 * 1000 - 60_000),
        to: DateTime.makeUnsafe(1791130525 * 1000 + 60_000),
        games: []
      })
      assert.deepStrictEqual(
        scenario.frames.map((frame) => frame.at),
        [0, 9956]
      )
      assert.strictEqual(DateTime.formatIso(scenario.origin), "2026-10-04T16:15:15.585Z")
      assert.strictEqual(
        DateTime.toEpochMillis(scenario.origin),
        DateTime.toEpochMillis(DateTime.makeUnsafe(1791130515 * 1000 + 585))
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("skips a file that is neither name", () =>
    Effect.gen(function* () {
      const recording = yield* recordingOf("nfl", ["1791130515.585"])
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFile(join(recording, "scoreboard", "notes.txt"), poll)
      yield* fs.writeFile(join(recording, "scoreboard", "1791130515.585.json.gz.tmp"), poll)
      const scenario = yield* CutScenario.cut({
        name: "one-poll",
        recording,
        from: DateTime.makeUnsafe(1791130515 * 1000 - 60_000),
        to: DateTime.makeUnsafe(1791130515 * 1000 + 60_000),
        games: []
      })
      assert.strictEqual(scenario.frames.length, 1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** A recording folder for a league holding the live poll under each of these file stems. */
function recordingOf(league: "college-football" | "nfl", stems: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const recording = join(yield* fs.makeTempDirectoryScoped(), league)
    yield* fs.makeDirectory(join(recording, "scoreboard"), { recursive: true })
    for (const stem of stems) yield* fs.writeFile(join(recording, "scoreboard", `${stem}.json.gz`), poll)
    return recording
  })
}
