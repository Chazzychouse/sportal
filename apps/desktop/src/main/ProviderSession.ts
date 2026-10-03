import { Context, Effect, FiberSet, Layer, Schema } from "effect"
import { session, type WebContents, WebContentsView } from "electron"

/**
 * The one persistent session every provider view shares, so one sign-in covers every tile and survives
 * restarts. It grants playback only what playback needs, and keeps its views on the provider's pages.
 */
export class ProviderSession extends Context.Service<
  ProviderSession,
  {
    /** A new view on the provider session, guarded so it can only visit addresses `allows` permits. */
    readonly createView: Effect.Effect<WebContentsView>
  }
>()("sportal/desktop/ProviderSession") {
  static readonly layer = Layer.effect(
    ProviderSession,
    Effect.gen(function* () {
      // Electron's callbacks decide synchronously; only their logging runs as an Effect.
      const log = yield* FiberSet.makeRuntime()
      const providers = session.fromPartition("persist:providers")
      providers.setPermissionRequestHandler((_webContents, permission, callback, details) => {
        const granted = grantsPermission(permission)
        if (!granted)
          log(Effect.logWarning(`ProviderSession: denied ${permission} for ${hostOf(details.requestingUrl)}`))
        callback(granted)
      })

      const refuseUnlessAllowed = (event: { preventDefault(): void }, url: string) => {
        if (allows(url)) return
        event.preventDefault()
        log(Effect.logWarning(`ProviderSession: blocked navigation to ${hostOf(url)}`))
      }

      return ProviderSession.of({
        createView: Effect.sync(() => {
          const view = new WebContentsView({
            webPreferences: {
              session: providers,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
            }
          })
          // will-navigate does not fire for server redirects, so guard both.
          view.webContents.on("will-navigate", (event) => refuseUnlessAllowed(event, event.url))
          view.webContents.on("will-redirect", (event) => refuseUnlessAllowed(event, event.url))
          view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
          return view
        })
      })
    })
  )
}

/** Provider views may only visit the provider and its sign-in pages. */
export function allows(url: string): boolean {
  if (!URL.canParse(url)) return false
  const { protocol, hostname } = new URL(url)
  return protocol === "https:" && allowedHosts.includes(hostname)
}

const allowedHosts = ["tv.youtube.com", "www.youtube.com", "accounts.youtube.com", "accounts.google.com"]

/** Playback needs DRM key systems, fullscreen, and a screen that stays awake; nothing else is granted. */
export function grantsPermission(permission: string): boolean {
  return ["mediaKeySystem", "fullscreen", "screen-wake-lock"].includes(permission)
}

/** The hostname alone, for logging: a full URL can carry tokens. */
export function hostOf(url: string) {
  return URL.canParse(url) ? new URL(url).hostname : "(unparseable address)"
}

/** Loads an address into a page; a failed load fails with Electron's error code, never its message. */
export function load(contents: WebContents, url: string) {
  return Effect.tryPromise({
    try: () => contents.loadURL(url),
    catch: (error) => new LoadFailed({ code: loadErrorCode(error) })
  })
}

/** The code Electron attaches to a failed load (such as `ERR_ABORTED`); the message would carry the full URL. */
export function loadErrorCode(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown"
}

class LoadFailed extends Schema.TaggedError<LoadFailed>()("LoadFailed", { code: Schema.String }) {}
