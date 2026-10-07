import { join } from "node:path"
import { Context, Effect, FiberSet, Layer } from "effect"
import { BrowserWindow } from "electron"
import { confine } from "./Navigation.ts"
import { sandboxed } from "./Sandbox.ts"
import { ShellConfig } from "./ShellConfig.ts"

/** The shell's one window, showing the Hub's web UI with the privileged preload, confined to the Hub's origin. */
export class ShellWindow extends Context.Service<ShellWindow, BrowserWindow>()(
  "sportal/desktop/main/ShellWindow"
) {
  /** Opens the window with the layer and destroys it with the layer. Built only once Electron is ready. */
  static readonly layer: Layer.Layer<ShellWindow, never, ShellConfig> = Layer.effect(
    ShellWindow,
    Effect.gen(function* () {
      const { hubUrl } = yield* ShellConfig
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

      return ShellWindow.of(window)
    })
  )
}
