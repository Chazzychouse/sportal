import { join } from "node:path"
import { TilePlacement } from "@sportal/api/ShellBridge"
import { Schema } from "effect"
import { app, BrowserWindow, components, ipcMain } from "electron"
import * as TileViews from "./TileViews.ts"

const hubUrl = process.env.SPORTAL_HUB_URL ?? "http://127.0.0.1:4400"

// Native Wayland rendering fails on some GPU setups (see docs/adr/0002); XWayland is reliable.
if (process.platform === "linux") app.commandLine.appendSwitch("ozone-platform", "x11")

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

  const tiles = TileViews.attach(window)
  ipcMain.on("sportal:sync-tiles", (event, placements: unknown) => {
    if (event.sender !== window.webContents) return
    const decoded = decodePlacements(placements)
    if (decoded._tag === "Some") tiles.sync(decoded.value)
  })

  await window.loadURL(hubUrl).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`Sportal: the Hub could not be reached at ${hubUrl}: ${reason}`)
  })
})

app.on("window-all-closed", () => app.quit())

const decodePlacements = Schema.decodeUnknownOption(Schema.Array(TilePlacement))
