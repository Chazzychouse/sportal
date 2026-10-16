import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { app, dialog, type UtilityProcess, utilityProcess } from "electron"
import { ShellConfig } from "./ShellConfig.ts"

/**
 * The Hub the shell ships with, run as an Electron utility process while the shell runs, its output written to
 * `hub.log` in the app's log folder. A Hub that stops on its own, such as one whose port is taken, is reported in a
 * dialog naming that log, and the shell quits. With a Hub address given, it starts nothing.
 */
export const layer: Layer.Layer<never, never, ShellConfig> = Layer.unwrap(
  Effect.gen(function* () {
    const { embeddedHub } = yield* ShellConfig
    return Option.match(embeddedHub, {
      onNone: () => Layer.empty,
      onSome: (hub) => Layer.effectDiscard(started(hub))
    })
  })
)

const started = Effect.fnUntraced(function* (hub: { script: string; webRoot: string; port: number }) {
  const logs = app.getPath("logs")
  yield* Effect.promise(() => mkdir(logs, { recursive: true }))
  const logPath = join(logs, "hub.log")

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const log = createWriteStream(logPath, { flags: "w" })
      const child = utilityProcess.fork(hub.script, [], {
        serviceName: "Sportal Hub",
        stdio: "pipe",
        env: {
          ...process.env,
          SPORTAL_PORT: String(hub.port),
          SPORTAL_WEB_ROOT: hub.webRoot,
          SPORTAL_VERSION: app.getVersion()
        }
      })
      child.stdout?.pipe(log)
      child.stderr?.pipe(log)
      child.once("exit", (code) => stoppedOnItsOwn(code, logPath))
      return child
    }),
    (child) => stopped(child)
  )
  yield* Effect.logInfo(`Sportal: started the Hub on port ${hub.port}; its log is ${logPath}`)
})

/** Stops the Hub, waiting up to five seconds for it to exit; an exit the shell asked for is not reported. */
function stopped(child: UtilityProcess) {
  return Effect.callback<void>((resume) => {
    child.removeAllListeners("exit")
    if (child.pid === undefined) return resume(Effect.void)
    child.once("exit", () => resume(Effect.void))
    child.kill()
  }).pipe(Effect.timeoutOption("5 seconds"), Effect.asVoid)
}

function stoppedOnItsOwn(code: number, logPath: string) {
  dialog.showErrorBox("Sportal", `The Hub stopped (exit code ${code}). Its log is at ${logPath}`)
  app.quit()
}
