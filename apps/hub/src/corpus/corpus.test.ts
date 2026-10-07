import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

describe("corpus backfill", () => {
  it.live(
    "refuses a span that reaches today, whose archived scoreboard would freeze part way, and fetches nothing",
    () =>
      Effect.gen(function* () {
        const today = DateTime.formatIsoDate(DateTime.setZone(yield* DateTime.now, zone))
        const yesterday = DateTime.formatIsoDate(
          DateTime.subtract(DateTime.setZone(yield* DateTime.now, zone), { days: 1 })
        )
        const { output, code, corpus } = yield* backfill(["--from", yesterday, "--to", today])

        assert.notStrictEqual(code, ChildProcessSpawner.ExitCode(0))
        assert.include(output, `${today} is not over`)
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(corpus))
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000
  )

  it.live(
    "refuses a day in the future",
    () =>
      Effect.gen(function* () {
        const { output, code } = yield* backfill(["--from", "2999-01-01", "--to", "2999-01-01"])

        assert.notStrictEqual(code, ChildProcessSpawner.ExitCode(0))
        assert.include(output, "2999-01-01 is not over")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000
  )
})

// The zone the command runs in, set on the child so its game days are the test's.
const zone = DateTime.zoneMakeNamedUnsafe("America/New_York")

/**
 * Runs `corpus backfill --league nfl` with `span` over a temporary data directory, on the developer's environment
 * minus any `SPORTAL_*` of their own: its output, exit code, and corpus directory.
 */
function backfill(span: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dataDir = yield* fs.makeTempDirectoryScoped()
    const inherited = Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("SPORTAL_")
    )
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          yield* path.fromFileUrl(new URL("./corpus.ts", import.meta.url)),
          "backfill",
          "--league",
          "nfl",
          ...span
        ],
        {
          env: {
            ...Object.fromEntries(inherited),
            TZ: DateTime.zoneToString(zone),
            SPORTAL_DATA_DIR: dataDir
          },
          extendEnv: false
        }
      )
    )
    const output = yield* child.all.pipe(Stream.decodeText(), Stream.mkString)
    return { output, code: yield* child.exitCode, corpus: path.join(dataDir, "corpus") }
  })
}
