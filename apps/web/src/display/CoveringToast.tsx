import { type ReactNode, useCallback } from "react"
import { type ExternalToast, toast } from "sonner"
import { useOverlayRef } from "./OverlayRef.ts"

/**
 * Shows `message` as a warning toast that hides the videos it covers for as long as it shows: provider views draw
 * above the page, so a toast over one would be hidden under it.
 */
export function warning(message: string, options?: ExternalToast) {
  return toast.warning(<Covered>{message}</Covered>, options)
}

/** A toast's content: while it is mounted, the toast it sits in counts as an overlay. */
function Covered({ children }: { children: ReactNode }) {
  const covering = useOverlayRef()
  const ref = useCallback(
    (content: HTMLElement | null) =>
      covering(content?.closest<HTMLElement>("[data-sonner-toast]") ?? content),
    [covering]
  )
  return <span ref={ref}>{children}</span>
}
