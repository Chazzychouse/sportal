import { useSyncExternalStore } from "react"

/**
 * Whether this Display's window is full screen, and a way to toggle it. In the shell the window itself goes
 * full screen; in a browser, the page does.
 */
export function useFullScreen(): { on: boolean; toggle: () => void } {
  const on = useSyncExternalStore(subscribe, () => current)
  return { on, toggle: () => setFullScreen(!current) }
}

let current = false

function subscribe(listener: () => void) {
  const shell = window.sportalShell
  if (shell !== undefined)
    return shell.onFullScreenChanged((on) => {
      current = on
      listener()
    })
  const changed = () => {
    current = document.fullscreenElement !== null
    listener()
  }
  document.addEventListener("fullscreenchange", changed)
  return () => document.removeEventListener("fullscreenchange", changed)
}

function setFullScreen(on: boolean) {
  const shell = window.sportalShell
  if (shell !== undefined) shell.setFullScreen(on)
  else if (on) void document.documentElement.requestFullscreen()
  else void document.exitFullscreen()
}
