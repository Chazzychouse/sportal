import { Effect } from "effect"
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
  if (shell !== undefined) return shell.setFullScreen(on)
  // A browser refuses full screen outside a user gesture, or when the page may not have it.
  Effect.runFork(
    Effect.tryPromise(() =>
      on ? document.documentElement.requestFullscreen() : document.exitFullscreen()
    ).pipe(Effect.catch((error) => Effect.logWarning("The browser did not change full screen", error)))
  )
}
