import { join } from "node:path"
import { TilePlacement } from "@sportal/api/ShellBridge"
import { Schema } from "effect"
import { app, BrowserWindow, components, ipcMain } from "electron"
import * as ProviderSession from "./ProviderSession.ts"
import * as TileViews from "./TileViews.ts"

const hubUrl = process.env.SPORTAL_HUB_URL ?? "http://127.0.0.1:4400"

app.whenReady().then(async () => {
  // Widevine is delivered as a component of the castlabs Electron build; wait for it before any playback.
  await components.whenReady()

  const window = new BrowserWindow({
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

  // The shell window holds the privileged preload, so it never leaves the Hub.
  const hubOrigin = new URL(hubUrl).origin
  const refuseOffHub = (event: { preventDefault(): void }, url: string) => {
    if (URL.canParse(url) && new URL(url).origin === hubOrigin) return
    event.preventDefault()
    console.warn(`Sportal: refused shell navigation to ${ProviderSession.hostOf(url)}`)
  }
  window.webContents.on("will-navigate", (event) => refuseOffHub(event, event.url))
  window.webContents.on("will-redirect", (event) => refuseOffHub(event, event.url))
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))

  const tiles = TileViews.attach(window)
  ipcMain.on("sportal:sync-tiles", (event, placements: unknown) => {
    if (event.sender !== window.webContents) return
    const decoded = decodePlacements(placements)
    if (decoded._tag === "Some") tiles.sync(decoded.value)
  })

  await window.loadURL(hubUrl).catch((error: unknown) => {
    const code = ProviderSession.loadErrorCode(error)
    console.error(`Sportal: the Hub could not be reached at ${ProviderSession.hostOf(hubUrl)}: ${code}`)
  })
})

app.on("window-all-closed", () => app.quit())

const decodePlacements = Schema.decodeUnknownOption(Schema.Array(TilePlacement))
