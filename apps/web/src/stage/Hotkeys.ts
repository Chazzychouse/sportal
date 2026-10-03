import { Hotkey } from "@sportal/api/Hotkey"
import { useEffect, useRef } from "react"

/**
 * Calls `handle` for each hotkey, pressed in the web UI or in a stream view that had focus (the shell forwards
 * those). Keys typed into a text field are the field's, except the command palette's.
 */
export function useHotkeys(handle: (hotkey: Hotkey) => void) {
  const latest = useRef(handle)
  latest.current = handle

  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      const hotkey = Hotkey.of(
        {
          code: event.code,
          shift: event.shiftKey,
          alt: event.altKey,
          control: event.ctrlKey,
          meta: event.metaKey
        },
        "page"
      )
      if (hotkey === undefined || event.repeat) return
      if (hotkey._tag !== "CommandPalette" && isTyping(event.target)) return
      event.preventDefault()
      latest.current(hotkey)
    }
    window.addEventListener("keydown", pressed)
    const stop = window.sportalShell?.onHotkey((hotkey) => latest.current(hotkey))
    return () => {
      window.removeEventListener("keydown", pressed)
      stop?.()
    }
  }, [])
}

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  )
}
