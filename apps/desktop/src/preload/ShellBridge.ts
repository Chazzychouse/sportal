import type { ChannelPick, ShellBridge } from "@sportal/api/ShellBridge"
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"

const bridge: ShellBridge = {
  syncTiles: (placements) => ipcRenderer.send("sportal:sync-tiles", placements),
  onChannelPicked: (listener) => {
    // The page gets the pick alone, never the IPC event, which would expose the renderer's IPC handle.
    const forward = (_event: IpcRendererEvent, pick: ChannelPick) => listener(pick)
    ipcRenderer.on("sportal:channel-picked", forward)
    return () => {
      ipcRenderer.removeListener("sportal:channel-picked", forward)
    }
  }
}

contextBridge.exposeInMainWorld("sportalShell", bridge)
