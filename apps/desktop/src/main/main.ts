import { join } from "node:path"
import { TilePlacement } from "@sportal/api/ShellBridge"
import { Config, Effect, FiberSet, Layer, Option, Schema, Stream } from "effect"
import { app, BrowserWindow, components, type IpcMainEvent, ipcMain } from "electron"
import { hostOf, load, ProviderSession } from "./ProviderSession.ts"
import { TileViews } from "./TileViews.ts"

const Shell = Layer.unwrap(
  Effect.gen(function* () {
    const hubUrl = yield* Config.String("SPORTAL_HUB_URL").pipe(Config.withDefault("http://127.0.0.1:4400"))
    yield* Effect.promise(() => app.whenReady())
    // Widevine is delivered as a component of the castlabs Electron build; wait for it before any playback.
    yield* Effect.tryPromise({ try: () => components.whenReady(), catch: () => new WidevineUnavailable() })
    const window = yield* openWindow(hubUrl)

    return Layer.effectDiscard(serveHub(window, hubUrl)).pipe(
      Layer.provide(TileViews.layer(window)),
      Layer.provide(ProviderSession.layer)
    )
  })
)

// Electron owns the process, so the shell is not run with NodeRuntime.runMain: it runs until its last window
// closes, releases what it holds, and then asks Electron to quit.
Layer.launch(Shell).pipe(
  Effect.raceFirst(allWindowsClosed()),
  Effect.tapCause((cause) => Effect.logError("Sportal: the shell stopped", cause)),
  Effect.ensuring(Effect.sync(() => app.quit())),
  Effect.runFork
)

class WidevineUnavailable extends Schema.TaggedError<WidevineUnavailable>()("WidevineUnavailable", {}) {}

function openWindow(hubUrl: string) {
  return Effect.gen(function* () {
    const log = yield* FiberSet.makeRuntime()
    const window = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new BrowserWindow({
            width: 1920,
            height: 1080,
            backgroundColor: "#0a0a0a",
            webPreferences: {
              preload: join(import.meta.dirname, "../preload/ShellBridge.cjs"),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
            }
          })
      ),
      (window) =>
        Effect.sync(() => {
          if (!window.isDestroyed()) window.destroy()
        })
    )

    // The shell window holds the privileged preload, so it never leaves the Hub.
    const hubOrigin = new URL(hubUrl).origin
    const refuseOffHub = (event: { preventDefault(): void }, url: string) => {
      if (URL.canParse(url) && new URL(url).origin === hubOrigin) return
      event.preventDefault()
      log(Effect.logWarning(`Sportal: refused shell navigation to ${hostOf(url)}`))
    }
    window.webContents.on("will-navigate", (event) => refuseOffHub(event, event.url))
    window.webContents.on("will-redirect", (event) => refuseOffHub(event, event.url))
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    return window
  })
}

function serveHub(window: BrowserWindow, hubUrl: string) {
  return Effect.gen(function* () {
    const tiles = yield* TileViews
    const run = yield* FiberSet.makeRuntime()
    const syncTiles = (event: IpcMainEvent, placements: unknown) => {
      if (event.sender !== window.webContents) return
      const decoded = decodePlacements(placements)
      if (Option.isSome(decoded)) run(tiles.sync(decoded.value))
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => ipcMain.on("sportal:sync-tiles", syncTiles)),
      () => Effect.sync(() => ipcMain.removeListener("sportal:sync-tiles", syncTiles))
    )

    yield* Effect.forkScoped(
      tiles.channelPicks.pipe(
        Stream.runForEach((pick) =>
          Effect.sync(() => {
            if (!window.isDestroyed()) window.webContents.send("sportal:channel-picked", pick)
          })
        )
      ),
      { startImmediately: true }
    )

    yield* load(window.webContents, hubUrl).pipe(
      Effect.catchTag("LoadFailed", (failure) =>
        Effect.logError(`Sportal: the Hub could not be reached at ${hostOf(hubUrl)}: ${failure.code}`)
      )
    )
  })
}

const decodePlacements = Schema.decodeUnknownOption(Schema.Array(TilePlacement))

function allWindowsClosed() {
  return Effect.callback<void>((resume) => {
    const closed = () => resume(Effect.void)
    app.once("window-all-closed", closed)
    return Effect.sync(() => app.removeListener("window-all-closed", closed))
  })
}
