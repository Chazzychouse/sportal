import { join } from "node:path"
import { StageTransition, TilePlacement } from "@sportal/api/ShellBridge"
import { ShellChannel } from "@sportal/api/ShellChannel"
import { GameId } from "@sportal/domain/Game"
import { Cause, Config, Effect, FiberSet, Layer, Option, Queue, Schedule, Schema, Stream } from "effect"
import { app, BrowserWindow, components, type IpcMainEvent, ipcMain } from "electron"
import { GuideReader } from "./GuideReader.ts"
import { confine, hostOf, load } from "./Navigation.ts"
import { ProviderSession } from "./ProviderSession.ts"
import { sandboxed } from "./Sandbox.ts"
import { TileViews } from "./TileViews.ts"

const Shell = Layer.unwrap(
  Effect.gen(function* () {
    const hubUrl = yield* Config.String("SPORTAL_HUB_URL").pipe(Config.withDefault("http://127.0.0.1:4400"))
    yield* Effect.promise(() => app.whenReady())
    // Widevine is delivered as a component of the castlabs Electron build; wait for it before any playback.
    yield* Effect.tryPromise({
      try: () => components.whenReady(),
      catch: (cause) => new WidevineUnavailable({ cause })
    })
    const window = yield* openWindow(hubUrl)

    return Layer.effectDiscard(serveHub(window, hubUrl)).pipe(
      Layer.provide(Layer.mergeAll(TileViews.layer(window), GuideReader.layer)),
      Layer.provide(ProviderSession.layer(hubUrl))
    )
  })
)

class WidevineUnavailable extends Schema.TaggedError<WidevineUnavailable>()("WidevineUnavailable", {
  cause: Schema.Defect()
}) {}

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
              ...sandboxed,
              preload: join(import.meta.dirname, "../preload/ShellBridge.cjs")
            }
          })
      ),
      (window) =>
        Effect.sync(() => {
          if (!window.isDestroyed()) window.destroy()
        })
    )

    // The shell window holds the privileged preload, so neither it nor any frame in it leaves the Hub.
    const hubOrigin = new URL(hubUrl).origin
    confine(
      window.webContents,
      (url) => URL.canParse(url) && new URL(url).origin === hubOrigin,
      (message) => log(Effect.logWarning(`Sportal: ${message}`)),
      { subframes: true }
    )
    return window
  })
}

function serveHub(window: BrowserWindow, hubUrl: string) {
  return Effect.gen(function* () {
    const tiles = yield* TileViews
    // Electron's IPC callbacks decide synchronously; the work they start runs as an Effect.
    const run = yield* FiberSet.makeRuntime()
    const providers = yield* ProviderSession

    // Placements are applied one at a time, and only the newest waiting set matters: each replaces all before it.
    const pending = yield* Queue.sliding<{
      placements: ReadonlyArray<TilePlacement>
      transition: StageTransition | undefined
    }>(1)
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(pending).pipe(
          Effect.flatMap(({ placements, transition }) =>
            tiles.sync(placements, transition).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterrupts(cause)) {
                  return Effect.failCause(cause)
                }
                return Effect.logError("Sportal: a tile sync failed", cause)
              })
            )
          )
        )
      )
    )
    yield* listen(window, ShellChannel.syncTiles, (placements, transition) => {
      const decoded = decodePlacements(placements)
      const along = decodeTransition(transition)
      if (Option.isSome(decoded) && Option.isSome(along))
        Queue.offerUnsafe(pending, { placements: decoded.value, transition: along.value })
    })
    yield* listen(window, ShellChannel.setHidden, (games) => {
      const decoded = decodeGames(games)
      if (Option.isSome(decoded)) run(tiles.hide(decoded.value))
    })
    yield* listen(window, ShellChannel.setFullScreen, (on) => {
      if (typeof on === "boolean") window.setFullScreen(on)
    })
    // The window manager or the OS may change full screen too; the web UI hears every change from here.
    const enteredFullScreen = () => window.webContents.send(ShellChannel.fullScreenChanged, true)
    const leftFullScreen = () => window.webContents.send(ShellChannel.fullScreenChanged, false)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        window.on("enter-full-screen", enteredFullScreen)
        window.on("leave-full-screen", leftFullScreen)
      }),
      () =>
        Effect.sync(() => {
          if (window.isDestroyed()) return
          window.removeListener("enter-full-screen", enteredFullScreen)
          window.removeListener("leave-full-screen", leftFullScreen)
        })
    )

    yield* forward(window, ShellChannel.hotkey, tiles.hotkeys)
    yield* forward(window, ShellChannel.tilePressed, tiles.tilePresses)
    yield* listen(window, ShellChannel.openSignIn, () => run(providers.openSignIn(window)))
    yield* forward(window, ShellChannel.channelPicked, tiles.channelPicks)

    const reader = yield* GuideReader
    yield* forward(window, ShellChannel.guideRead, reader.guides)
    yield* listen(window, ShellChannel.readGuide, () => run(reader.readSoon))

    // The Hub may still be starting; wait for it rather than leave the window blank.
    yield* load(window.webContents, hubUrl).pipe(
      Effect.tapError((failure) =>
        failure.code === "ERR_CONNECTION_REFUSED"
          ? Effect.logInfo(`Sportal: waiting for the Hub at ${hostOf(hubUrl)}`)
          : Effect.void
      ),
      Effect.retry({
        schedule: Schedule.spaced("1 second"),
        while: (failure) => failure.code === "ERR_CONNECTION_REFUSED" && !window.isDestroyed()
      }),
      Effect.catchTag("LoadFailed", (failure) =>
        // Closing the window while the Hub page loads fails the load; that is the user leaving, not an outage.
        window.isDestroyed()
          ? Effect.void
          : Effect.logError(`Sportal: the Hub could not be reached at ${hostOf(hubUrl)}: ${failure.code}`)
      )
    )
  })
}

function forward(window: BrowserWindow, channel: string, stream: Stream.Stream<unknown>) {
  return Effect.forkScoped(
    stream.pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          if (!window.isDestroyed()) window.webContents.send(channel, value)
        })
      )
    ),
    { startImmediately: true }
  )
}

/** Hears the shell window's own page on `channel`; a message from any other sender is dropped. */
function listen(window: BrowserWindow, channel: string, handler: (...args: ReadonlyArray<unknown>) => void) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const onMessage = (event: IpcMainEvent, ...args: ReadonlyArray<unknown>) => {
        if (event.sender === window.webContents) handler(...args)
      }
      ipcMain.on(channel, onMessage)
      return onMessage
    }),
    (onMessage) => Effect.sync(() => ipcMain.removeListener(channel, onMessage))
  )
}

const decodePlacements = Schema.decodeUnknownOption(Schema.Array(TilePlacement))
const decodeTransition = Schema.decodeUnknownOption(Schema.UndefinedOr(StageTransition))
const decodeGames = Schema.decodeUnknownOption(Schema.Array(GameId))

function allWindowsClosed() {
  return Effect.callback<void>((resume) => {
    const closed = () => resume(Effect.void)
    app.once("window-all-closed", closed)
    return Effect.sync(() => app.removeListener("window-all-closed", closed))
  })
}

// Launched last, once everything above is defined. Electron owns the process, so the shell is not
// run with NodeRuntime.runMain: it runs until its last window closes, releases what it holds, and
// then asks Electron to quit.
Layer.launch(Shell).pipe(
  Effect.raceFirst(allWindowsClosed()),
  Effect.tapCause((cause) => Effect.logError("Sportal: the shell stopped", cause)),
  Effect.ensuring(Effect.sync(() => app.quit())),
  Effect.runFork
)
