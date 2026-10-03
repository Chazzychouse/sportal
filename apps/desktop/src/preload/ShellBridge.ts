import type { ShellBridge } from "@sportal/api/ShellBridge"
import { contextBridge, ipcRenderer } from "electron"

const bridge: ShellBridge = {
  syncTiles: (placements) => ipcRenderer.send("sportal:sync-tiles", placements)
}

contextBridge.exposeInMainWorld("sportalShell", bridge)
