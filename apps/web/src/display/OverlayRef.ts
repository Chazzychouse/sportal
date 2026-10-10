import { useAtomSet } from "@effect/atom-react"
import { useCallback, useId } from "react"
import * as Covering from "./Covering.ts"

/**
 * A ref for an overlay's content, which mounts only while the overlay is open: while the element is mounted, the
 * videos it covers hide. React runs the returned cleanup when the element unmounts.
 */
export function useOverlayRef() {
  const key = useId()
  const setOverlays = useAtomSet(Covering.overlays)
  return useCallback(
    (element: HTMLElement | null) => {
      if (element === null) return undefined
      const measure = () => {
        const { x, y, width, height } = element.getBoundingClientRect()
        setOverlays((all) => new Map(all).set(key, { x, y, width, height }))
      }
      // An overlay grows into place with an animation, which a resize observer does not see, and a fixed overlay can move with the window without resizing.
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      element.addEventListener("animationend", measure)
      window.addEventListener("resize", measure)
      measure()
      return () => {
        observer.disconnect()
        element.removeEventListener("animationend", measure)
        window.removeEventListener("resize", measure)
        setOverlays((all) => {
          const rest = new Map(all)
          rest.delete(key)
          return rest
        })
      }
    },
    [key, setOverlays]
  )
}
