import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { GameDay } from "@sportal/domain/GameDay"
import { DateTime, Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// Each test spawns the corpus command in a fresh Node, which takes seconds under a full suite's load.
describe("corpus backfill", () => {
  it.live(
    "should refuse a span that reaches today, whose archived scoreboard would freeze part way, fetching nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const utcNow = yield* DateTime.now
        const now = DateTime.setZone(utcNow, zone)
        const today = DateTime.formatIsoDate(now)
        const yesterday = DateTime.formatIsoDate(DateTime.subtract(now, { days: 1 }))
        // The game day now is in: yesterday's until 04:00.
        const unended = DateTime.formatIsoDate(DateTime.setZone(GameDay.dayStart(now), zone))

        const { output, code, corpus } = yield* backfill(["--from", yesterday, "--to", today])

        const fetched = yield* fs.exists(corpus)
        assert.notStrictEqual(code, ChildProcessSpawner.ExitCode(0))
        assert.include(output, `${unended} is not over`)
        assert.isFalse(fetched)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000
  )

  it.live(
    "should refuse a day in the future",
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
    const command = yield* path.fromFileUrl(new URL("./corpus.ts", import.meta.url))
    const inherited = Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("SPORTAL_")
    )

    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [command, "backfill", "--league", "nfl", ...span], {
        env: {
          ...Object.fromEntries(inherited),
          TZ: DateTime.zoneToString(zone),
          SPORTAL_DATA_DIR: dataDir
        },
        extendEnv: false
      })
    )
    const output = yield* child.all.pipe(Stream.decodeText(), Stream.mkString)
    const code = yield* child.exitCode

    return { output, code, corpus: path.join(dataDir, "corpus") }
  })
}
