import { Context, Effect, FiberSet, Layer } from "effect"
import { BrowserWindow, type Session, session, WebContentsView } from "electron"
import { confine, hostOf, load } from "./Navigation.ts"

/**
 * The one persistent session every provider view shares, so one sign-in covers every tile and survives
 * restarts. It grants playback only what playback needs, and keeps its views on the provider's pages.
 */
export class ProviderSession extends Context.Service<
  ProviderSession,
  {
    /** The provider session itself, for the requests the shell sends as the signed-in account. */
    readonly session: Session
    /** A new view on the provider session, guarded so it can only visit addresses `allows` permits. */
    readonly createView: Effect.Effect<WebContentsView>
    /** Whether a provider view may load `url`: the provider's pages, or the UI's own scenario streams. */
    readonly allows: (url: string) => boolean
    /**
     * Opens a normal-sized window on the provider session at YouTube TV, so the user can sign in once for
     * every tile. It is a child of `parent`, so it closes with it. An open window is focused instead of a
     * second being opened.
     */
    readonly openSignIn: (parent: BrowserWindow) => Effect.Effect<void>
  }
>()("sportal/desktop/ProviderSession") {
  static readonly layer = (ui: string) =>
    Layer.effect(
      ProviderSession,
      Effect.gen(function* () {
        const permits = (url: string) => allows(url, ui)
        // Electron's callbacks decide synchronously; only their logging runs as an Effect.
        const log = yield* FiberSet.makeRuntime()
        const providers = session.fromPartition("persist:providers")
        providers.setPermissionRequestHandler((_webContents, permission, callback, details) => {
          const granted = grantsPermission(permission)
          if (!granted)
            log(
              Effect.logWarning(`ProviderSession: denied ${permission} for ${hostOf(details.requestingUrl)}`)
            )
          callback(granted)
        })

        const warn = (message: string) => log(Effect.logWarning(`ProviderSession: ${message}`))

        let signIn: BrowserWindow | undefined
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (signIn && !signIn.isDestroyed()) signIn.close()
          })
        )

        return ProviderSession.of({
          session: providers,
          allows: permits,
          createView: Effect.sync(() => {
            const view = new WebContentsView({
              webPreferences: {
                session: providers,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
              }
            })
            // Subframes are left alone: provider pages embed frames from hosts the allowlist does not name.
            confine(view.webContents, permits, warn, { subframes: false })
            return view
          }),
          openSignIn: (parent) =>
            Effect.sync(() => {
              if (signIn && !signIn.isDestroyed()) {
                signIn.focus()
                return
              }
              const window = new BrowserWindow({
                width: 1000,
                height: 800,
                parent,
                webPreferences: {
                  session: providers,
                  contextIsolation: true,
                  nodeIntegration: false,
                  sandbox: true
                }
              })
              signIn = window
              confine(window.webContents, permits, warn, { subframes: false })
              log(
                load(window.webContents, signInUrl).pipe(
                  Effect.catchTag("LoadFailed", (failure) =>
                    Effect.logWarning(`ProviderSession: the sign-in window did not load: ${failure.code}`)
                  )
                )
              )
            })
        })
      })
    )
}

const signInUrl = "https://tv.youtube.com/"

/**
 * Provider views may visit the provider and its sign-in pages, and the web UI's own synthetic stream pages for a
 * scenario (`ui` is the address the shell loads the UI from).
 * @testonly
 */
export function allows(url: string, ui: string): boolean {
  if (!URL.canParse(url)) return false
  const { protocol, hostname, origin, pathname } = new URL(url)
  if (URL.canParse(ui) && origin === new URL(ui).origin && pathname.startsWith("/scenario-stream/"))
    return true
  return protocol === "https:" && allowedHosts.includes(hostname)
}

const allowedHosts = ["tv.youtube.com", "www.youtube.com", "accounts.youtube.com", "accounts.google.com"]

/**
 * Playback needs DRM key systems, fullscreen, and a screen that stays awake; nothing else is granted.
 * @testonly
 */
export function grantsPermission(permission: string): boolean {
  return ["mediaKeySystem", "fullscreen", "screen-wake-lock"].includes(permission)
}
