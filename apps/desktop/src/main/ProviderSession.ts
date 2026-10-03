import { session, WebContentsView } from "electron"

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

function refuseUnlessAllowed(event: { preventDefault(): void }, url: string) {
  if (allows(url)) return
  event.preventDefault()
  // Hostname only: the full URL can carry tokens.
  const host = URL.canParse(url) ? new URL(url).hostname : "(unparseable address)"
  console.warn(`ProviderSession: blocked navigation to ${host}`)
}

function providerSession() {
  const providers = session.fromPartition("persist:providers")
  providers.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "fullscreen")
  })
  return providers
}
