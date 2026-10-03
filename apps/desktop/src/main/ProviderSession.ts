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
  view.webContents.on("will-navigate", (event, url) => {
    if (!allows(url)) event.preventDefault()
  })
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  return view
}

/** Provider views may only visit the provider and its sign-in pages. */
export function allows(url: string): boolean {
  if (!URL.canParse(url)) return false
  const { protocol, hostname } = new URL(url)
  return (
    protocol === "https:" && allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  )
}

const allowedHosts = ["youtube.com", "google.com"]

function providerSession() {
  const providers = session.fromPartition("persist:providers")
  providers.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "fullscreen")
  })
  return providers
}
