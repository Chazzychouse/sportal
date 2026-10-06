import type { ShellBridge } from "@sportal/api/ShellBridge"
import { ShellChannel } from "@sportal/api/ShellChannel"
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"

const bridge: ShellBridge = {
  syncTiles: (placements, transition) => ipcRenderer.send(ShellChannel.syncTiles, placements, transition),
  setHidden: (games) => ipcRenderer.send(ShellChannel.setHidden, games),
  setFullScreen: (on) => ipcRenderer.send(ShellChannel.setFullScreen, on),
  onFullScreenChanged: subscribe(ShellChannel.fullScreenChanged),
  onHotkey: subscribe(ShellChannel.hotkey),
  onTilePressed: subscribe(ShellChannel.tilePressed),
  openSignIn: () => ipcRenderer.send(ShellChannel.openSignIn),
  onGuideRead: subscribe(ShellChannel.guideRead),
  readGuide: () => ipcRenderer.send(ShellChannel.readGuide)
}

contextBridge.exposeInMainWorld("sportalShell", bridge)

/** The page gets the value alone, never the IPC event, which would expose the renderer's IPC handle. */
function subscribe<Value>(channel: string) {
  return (listener: (value: Value) => void) => {
    const forward = (_event: IpcRendererEvent, value: Value) => listener(value)
    ipcRenderer.on(channel, forward)
    return () => {
      ipcRenderer.removeListener(channel, forward)
    }
  }
}
