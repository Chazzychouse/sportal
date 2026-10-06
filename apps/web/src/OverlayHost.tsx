import type { GameId } from "@sportal/domain/Game"
import { createContext, type ReactNode, useCallback, useContext, useLayoutEffect, useRef } from "react"

/**
 * Where overlays meet native video. Provider views draw above the web UI, so an overlay (a dialog, the command
 * palette) over a video would be hidden behind it. The host knows every open overlay's rectangle and every
 * video's, and asks the shell to hide exactly the views an overlay covers, until it closes.
 */
export function OverlayHost(props: { children: ReactNode }) {
  const host = useRef<Host | undefined>(undefined)
  host.current ??= makeHost()
  return <HostContext.Provider value={host.current}>{props.children}</HostContext.Provider>
}

/**
 * A ref for an overlay's element: while the element is mounted, the videos it covers hide. Pass it as the
 * overlay content's `ref`, which mounts only while the overlay is open; React runs the returned cleanup when
 * the element unmounts.
 */
export function useCovering() {
  const host = useContext(HostContext)
  return useCallback(
    (element: HTMLElement | null) =>
      element === null || host === undefined ? undefined : host.cover(element),
    [host]
  )
}

/** Tells the host where each game's video is, in window pixels. */
export function useVideoAreas(areas: ReadonlyArray<{ game: GameId; bounds: Rect }>) {
  const host = useContext(HostContext)
  useLayoutEffect(() => host?.place(areas), [host, areas])
}

/**
 * Whether two rectangles share any area; touching edges do not.
 * @testonly
 */
export function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

type Rect = { x: number; y: number; width: number; height: number }
type Host = ReturnType<typeof makeHost>

const HostContext = createContext<Host | undefined>(undefined)

function makeHost() {
  const overlays = new Set<HTMLElement>()
  let videos: ReadonlyArray<{ game: GameId; bounds: Rect }> = []
  let hidden = ""

  const update = () => {
    const covering = [...overlays].map((element) => element.getBoundingClientRect())
    const games = videos
      .filter((video) => covering.some((overlay) => overlaps(overlay, video.bounds)))
      .map((video) => video.game)
    const key = games.join(" ")
    if (key === hidden) return
    hidden = key
    window.sportalShell?.setHidden(games)
  }

  return {
    cover(element: HTMLElement) {
      overlays.add(element)
      // An overlay grows into place with an animation, which a resize observer does not see.
      const observer = new ResizeObserver(update)
      observer.observe(element)
      element.addEventListener("animationend", update)
      update()
      return () => {
        overlays.delete(element)
        observer.disconnect()
        element.removeEventListener("animationend", update)
        update()
      }
    },
    place(areas: ReadonlyArray<{ game: GameId; bounds: Rect }>) {
      videos = areas
      update()
    }
  }
}
