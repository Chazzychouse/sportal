import { type ReactNode, useEffect, useRef } from "react"
import { cn } from "@/design/ClassName"

interface ShelfProps {
  title?: string | undefined
  live?: boolean
  focus: number | undefined
  children: ReactNode
}

/**
 * A row of cards under an optional title, scrolling sideways without a scrollbar and keeping the child at `focus` in
 * view. `live` lights the title in the live color.
 */
export function Shelf({ title, live = false, focus, children }: ShelfProps) {
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focus === undefined) return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    row.current?.children
      .item(focus)
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced ? "auto" : "smooth" })
  }, [focus])

  return (
    <section className="flex min-h-0 flex-col gap-1.5">
      {title !== undefined && (
        <h2 className={cn("label-caps text-xs", live ? "text-live" : "text-muted-foreground")}>{title}</h2>
      )}
      <div ref={row} className="flex min-h-0 gap-3 overflow-x-auto px-1 py-2 [scrollbar-width:none]">
        {children}
      </div>
    </section>
  )
}
