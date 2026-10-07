import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, FileSystem, Path, Schedule, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpServer } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

describe("the Hub process", () => {
  // Windows cannot send a child SIGTERM. Ctrl-C there is SIGINT, which NodeRuntime.runMain handles the same way.
  it.live.skipIf(process.platform === "win32")(
    "should stop within seconds of SIGTERM with a Display connected, exiting 0",
    () =>
      Effect.gen(function* () {
        const stopped = yield* sigtermed({})

        assert.strictEqual(stopped.code, ChildProcessSpawner.ExitCode(0))
        assert.isBelow(stopped.took, 5_000)
      }),
    30_000
  )

  it.live.skipIf(process.platform === "win32")(
    "should open no sportal.sqlite in the data directory",
    () =>
      Effect.gen(function* () {
        const stopped = yield* sigtermed({})

        assert.isFalse(stopped.sportalOpened)
      }),
    30_000
  )

  it.live.skipIf(process.platform === "win32")(
    "should stop as quickly when the telemetry collector cannot be reached",
    () =>
      Effect.gen(function* () {
        const port = yield* freePort()
        const settings = { SPORTAL_OTLP_URL: `http://127.0.0.1:${port}` }

        const stopped = yield* sigtermed(settings)

        assert.strictEqual(stopped.code, ChildProcessSpawner.ExitCode(0))
        assert.isBelow(stopped.took, 5_000)
      }),
    30_000
  )

  it.live(
    "should exit non-zero, naming the setting, when one is invalid",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dataDir = yield* fs.makeTempDirectoryScoped()

        const hub = yield* spawnHub({ SPORTAL_PORT: "eighty", SPORTAL_DATA_DIR: dataDir })
        const output = yield* hub.all.pipe(Stream.decodeText(), Stream.mkString)
        const code = yield* hub.exitCode

        assert.notStrictEqual(code, ChildProcessSpawner.ExitCode(0))
        assert.include(output, "SPORTAL_PORT")
      }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
    30_000
  )
})

/**
 * Starts the Hub with `settings`, connects a Display, and sends the Hub SIGTERM: its exit code, how long it took to
 * stop in milliseconds, and whether it opened a `sportal.sqlite` in its data directory.
 */
function sigtermed(settings: Record<string, string>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const http = yield* HttpClient.HttpClient
    const dataDir = yield* fs.makeTempDirectoryScoped()
    const port = yield* freePort()
    const base = `http://127.0.0.1:${port}`

    const hub = yield* spawnHub({ ...settings, SPORTAL_PORT: String(port), SPORTAL_DATA_DIR: dataDir })
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
    const stopped = yield* Clock.currentTimeMillis

    const sportalOpened = yield* fs.exists(path.join(dataDir, "sportal.sqlite"))
    return { code, took: stopped - stopping, sportalOpened }
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer]))
}

/**
 * Starts the Hub in a child process on a scenario, on loopback, with `settings` on top of the developer's
 * environment minus any `SPORTAL_*` of their own.
 */
function spawnHub(settings: Record<string, string>) {
  return Effect.gen(function* () {
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const main = yield* path.fromFileUrl(new URL("./main.ts", import.meta.url))
    const inherited = Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("SPORTAL_")
    )

    return yield* spawner.spawn(
      ChildProcess.make(process.execPath, [main], {
        env: {
          ...Object.fromEntries(inherited),
          SPORTAL_HOST: "127.0.0.1",
          SPORTAL_SCENARIO: "two-minute-drill-tie",
          ...settings
        },
        extendEnv: false
      })
    )
  })
}

/** A port nothing is listening on: a test server takes one from the OS and releases it for the Hub. */
function freePort() {
  return Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer
    if (!("port" in address)) {
      return yield* Effect.die("the test server listens on no TCP port")
    }
    return address.port
  }).pipe(Effect.provide(NodeHttpServer.layerTest))
}
