import type { ChannelPick, ShellBridge } from "@sportal/api/ShellBridge"
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"

const bridge: ShellBridge = {
  syncTiles: (placements) => ipcRenderer.send("sportal:sync-tiles", placements),
  openSignIn: () => ipcRenderer.send("sportal:open-sign-in"),
  onChannelPicked: (listener) => {
    // The page gets the pick alone, never the IPC event, which would expose the renderer's IPC handle.
    const forward = (_event: IpcRendererEvent, pick: ChannelPick) => listener(pick)
    ipcRenderer.on("sportal:channel-picked", forward)
    return () => {
      ipcRenderer.removeListener("sportal:channel-picked", forward)
    }
  },
  onGuideRead: (listener) => {
    // The page gets the guide alone, never the IPC event.
    const forward = (_event: IpcRendererEvent, guide: string) => listener(guide)
    ipcRenderer.on("sportal:guide-read", forward)
    return () => {
      ipcRenderer.removeListener("sportal:guide-read", forward)
    }
  },
  readGuide: () => ipcRenderer.send("sportal:read-guide")
}

contextBridge.exposeInMainWorld("sportalShell", bridge)
