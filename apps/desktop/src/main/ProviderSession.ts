import { type Session, session, WebContentsView } from "electron"

/** A view on the shared, persistent provider session, so one sign-in covers every tile and survives restarts. */
export function createView(): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      session: providerSession(),
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

/** The code Electron attaches to a failed load (such as `ERR_ABORTED`); the message would carry the full URL. */
export function loadErrorCode(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown"
}

let configured: Session | undefined

function providerSession() {
  if (configured !== undefined) return configured
  configured = session.fromPartition("persist:providers")
  configured.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const granted = grantsPermission(permission)
    if (!granted) console.warn(`ProviderSession: denied ${permission} for ${hostOf(details.requestingUrl)}`)
    callback(granted)
  })
  return configured
}

function refuseUnlessAllowed(event: { preventDefault(): void }, url: string) {
  if (allows(url)) return
  event.preventDefault()
  console.warn(`ProviderSession: blocked navigation to ${hostOf(url)}`)
}
