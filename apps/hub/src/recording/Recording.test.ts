import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Path } from "effect"
import * as Recording from "./Recording.ts"

describe("Recording.polls", () => {
  it.effect("lists a league's polls of both recorders in order of instant, skipping other files", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path
      const dir = yield* recordedLeague("nfl", [
        "1791130525.541.json.gz",
        "20261004T161000Z.json.gz",
        "1791130515.585.json.gz",
        "notes.txt",
        "1791130515.585.json.gz.tmp"
      ])

      const polls = yield* Recording.polls(dir)

      assert.deepStrictEqual(
        polls.map(({ league, at, path }) => [league, DateTime.toEpochMillis(at), path]),
        [
          ["nfl", 1791130200000, join(dir, "scoreboard", "20261004T161000Z.json.gz")],
          ["nfl", 1791130515585, join(dir, "scoreboard", "1791130515.585.json.gz")],
          ["nfl", 1791130525541, join(dir, "scoreboard", "1791130525.541.json.gz")]
        ]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("reads a name written as a UTC instant", () =>
    Effect.gen(function* () {
      const dir = yield* recordedLeague("nfl", ["20261003T160848Z.json.gz"])
      const polls = yield* Recording.polls(dir)
      assert.deepStrictEqual(
        polls.map(({ at }) => DateTime.formatIso(at)),
        ["2026-10-03T16:08:48.000Z"]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("calls college-football's polls fbs's, whatever trailing slash the folder is given", () =>
    Effect.gen(function* () {
      const dir = yield* recordedLeague("college-football", ["20261003T160848Z.json.gz"])
      const polls = yield* Recording.polls(`${dir}/`)
      assert.deepStrictEqual(
        polls.map(({ league }) => league),
        ["fbs"]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("is unreadable for a folder that is no league's", () =>
    Effect.gen(function* () {
      const dir = yield* recordedLeague("mlb", ["20261003T160848Z.json.gz"])
      const error = yield* Recording.polls(dir).pipe(Effect.flip)
      assert.strictEqual(error._tag, "RecordingUnreadable")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("is unreadable for a league folder with no scoreboard folder", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path
      const dir = join(yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(), "nfl")
      const error = yield* Recording.polls(dir).pipe(Effect.flip)
      assert.strictEqual(error._tag, "RecordingUnreadable")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** A league folder holding an empty file under each of these names in its `scoreboard` folder. */
function recordedLeague(league: string, files: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { join } = yield* Path.Path
    const dir = join(yield* fs.makeTempDirectoryScoped(), league)
    yield* fs.makeDirectory(join(dir, "scoreboard"), { recursive: true })
    yield* Effect.forEach(files, (file) => fs.writeFileString(join(dir, "scoreboard", file), ""), {
      discard: true
    })
    return dir
  })
}
