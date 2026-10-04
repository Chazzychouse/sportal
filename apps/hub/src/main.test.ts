import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, FileSystem, Path, Schedule, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpServer } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

describe("the Hub process", () => {
  // Windows cannot send a child SIGTERM. Ctrl-C there is SIGINT, which NodeRuntime.runMain handles the same way.
  it.live.skipIf(process.platform === "win32")(
    "stops within seconds of SIGTERM with a Display connected, and leaves the database checkpointed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const http = yield* HttpClient.HttpClient
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const dataDir = yield* fs.makeTempDirectoryScoped()
        const port = yield* freePort()
        const base = `http://127.0.0.1:${port}`

        const hub = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [yield* path.fromFileUrl(new URL("./main.ts", import.meta.url))],
            {
              env: {
                SPORTAL_PORT: String(port),
                SPORTAL_HOST: "127.0.0.1",
                SPORTAL_DATA_DIR: dataDir,
                SPORTAL_SCENARIO: "two-minute-drill-tie"
              },
              extendEnv: true
            }
          )
        )
        // Unread output would fill the pipe and block the Hub.
        yield* hub.all.pipe(Stream.runDrain, Effect.exit, Effect.forkScoped)

        yield* http
          .get(`${base}/api/health`)
          .pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }))
        // The stream fails when the Hub goes away; its exit is kept, not raised.
        const live = yield* http.get(`${base}/api/live`)
        yield* live.stream.pipe(Stream.runDrain, Effect.exit, Effect.forkScoped)

        const stopping = yield* Clock.currentTimeMillis
        yield* hub.kill({ killSignal: "SIGTERM" })
        const code = yield* hub.exitCode
        const took = (yield* Clock.currentTimeMillis) - stopping

        assert.strictEqual(code, ChildProcessSpawner.ExitCode(0))
        assert.isBelow(took, 5_000)
        assert.isTrue(yield* fs.exists(path.join(dataDir, "sportal.sqlite")))
        assert.isFalse(yield* fs.exists(path.join(dataDir, "sportal.sqlite-wal")))
        assert.isFalse(yield* fs.exists(path.join(dataDir, "sportal.sqlite-shm")))
      }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
    30_000
  )
})

/** A port nothing is listening on: a test server takes one from the OS and releases it for the Hub. */
function freePort() {
  return Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer
    return "port" in address ? address.port : yield* Effect.die("the test server listens on no TCP port")
  }).pipe(Effect.provide(NodeHttpServer.layerTest))
}
