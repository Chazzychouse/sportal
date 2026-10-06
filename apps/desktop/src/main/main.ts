import { StageTransition, TilePlacement } from "@sportal/api/ShellBridge"
import { ShellChannel } from "@sportal/api/ShellChannel"
import { GameId } from "@sportal/domain/Game"
import { Cause, Effect, FiberSet, Layer, Option, Queue, Schedule, Schema, Stream } from "effect"
import { app, components, type IpcMainEvent, ipcMain } from "electron"
import { GuideReader } from "./GuideReader.ts"
import { hostOf, load } from "./Navigation.ts"
import { ProviderSession } from "./ProviderSession.ts"
import { ShellConfig } from "./ShellConfig.ts"
import { ShellWindow } from "./ShellWindow.ts"
import { TileViews } from "./TileViews.ts"

const Shell = Layer.unwrap(
  Effect.gen(function* () {
    yield* Effect.promise(() => app.whenReady())
    // Widevine is delivered as a component of the castlabs Electron build; wait for it before any playback.
    yield* Effect.tryPromise({
      try: () => components.whenReady(),
      catch: (cause) => new WidevineUnavailable({ cause })
    })
    return Layer.effectDiscard(serveHub).pipe(
      Layer.provide([TileViews.layer, GuideReader.layer]),
      Layer.provideMerge(ProviderSession.layer),
      Layer.provideMerge(ShellWindow.layer),
      Layer.provideMerge(ShellConfig.layer)
    )
  })
)

class WidevineUnavailable extends Schema.TaggedError<WidevineUnavailable>()("WidevineUnavailable", {
  cause: Schema.Defect()
}) {}

const serveHub = Effect.gen(function* () {
  const window = yield* ShellWindow
  const { hubUrl } = yield* ShellConfig
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
  yield* listen(ShellChannel.syncTiles, (placements, transition) => {
    const decoded = decodePlacements(placements)
    const along = decodeTransition(transition)
    if (Option.isSome(decoded) && Option.isSome(along))
      Queue.offerUnsafe(pending, { placements: decoded.value, transition: along.value })
  })
  yield* listen(ShellChannel.setHidden, (games) => {
    const decoded = decodeGames(games)
    if (Option.isSome(decoded)) run(tiles.hide(decoded.value))
  })
  yield* listen(ShellChannel.setFullScreen, (on) => {
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

  yield* forward(ShellChannel.hotkey, tiles.hotkeys)
  yield* forward(ShellChannel.tilePressed, tiles.tilePresses)
  yield* listen(ShellChannel.openSignIn, () => run(providers.openSignIn))
  yield* forward(ShellChannel.channelPicked, tiles.channelPicks)

  const reader = yield* GuideReader
  yield* forward(ShellChannel.guideRead, reader.guides)
  yield* listen(ShellChannel.readGuide, () => run(reader.readSoon))

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

function forward(channel: string, stream: Stream.Stream<unknown>) {
  return Effect.gen(function* () {
    const window = yield* ShellWindow
    yield* Effect.forkScoped(
      stream.pipe(
        Stream.runForEach((value) =>
          Effect.sync(() => {
            if (!window.isDestroyed()) window.webContents.send(channel, value)
          })
        )
      ),
      { startImmediately: true }
    )
  })
}

/** Hears the shell window's own page on `channel`; a message from any other sender is dropped. */
function listen(channel: string, handler: (...args: ReadonlyArray<unknown>) => void) {
  return Effect.gen(function* () {
    const window = yield* ShellWindow
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onMessage = (event: IpcMainEvent, ...args: ReadonlyArray<unknown>) => {
          if (event.sender === window.webContents) handler(...args)
        }
        ipcMain.on(channel, onMessage)
        return onMessage
      }),
      (onMessage) => Effect.sync(() => ipcMain.removeListener(channel, onMessage))
    )
  })
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
