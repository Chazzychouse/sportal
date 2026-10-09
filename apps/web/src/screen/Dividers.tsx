import { useRef } from "react"
import { Layout } from "../layout/Layout.ts"
import { type LayoutName, Screen, type Split } from "./Screen.ts"
import { gap } from "./TileRects.ts"

/**
 * Drag handles in the gaps between tiles, one per divider the layout uses. While dragging, the split is
 * reported through `onDrag`; on release, through `onDrop`, which commits it.
 */
export function Dividers(props: {
  layout: LayoutName
  split: Split
  area: { width: number; height: number }
  onDrag: (split: Split) => void
  onDrop: (split: Split) => void
}) {
  const dragging = useRef<Split | undefined>(undefined)

  return Layout.dividers(props.layout).map((axis) => {
    const at = props.split[axis] * (axis === "x" ? props.area.width : props.area.height)

    return (
      // biome-ignore lint/a11y/useSemanticElements: a draggable splitter is a widget, not an <hr>'s thematic break.
      <div
        key={axis}
        role="separator"
        aria-orientation={axis === "x" ? "vertical" : "horizontal"}
        aria-valuemin={Math.round(Screen.splitBounds.min * 100)}
        aria-valuemax={Math.round(Screen.splitBounds.max * 100)}
        aria-valuenow={Math.round(props.split[axis] * 100)}
        tabIndex={-1}
        className={`group absolute z-10 flex touch-none items-center justify-center ${
          axis === "x" ? "inset-y-0 cursor-col-resize" : "inset-x-0 cursor-row-resize"
        }`}
        style={axis === "x" ? { left: at - gap / 2, width: gap } : { top: at - gap / 2, height: gap }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          dragging.current = props.split
        }}
        onPointerMove={(event) => {
          if (dragging.current === undefined) return
          const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
          if (bounds === undefined) return
          const fraction =
            axis === "x"
              ? (event.clientX - bounds.x) / bounds.width
              : (event.clientY - bounds.y) / bounds.height
          dragging.current = Layout.clamp({ ...dragging.current, [axis]: fraction })
          props.onDrag(dragging.current)
        }}
        onPointerUp={() => {
          if (dragging.current !== undefined) props.onDrop(dragging.current)
          dragging.current = undefined
        }}
      >
        <span
          className={`rounded-full bg-border transition-colors group-hover:bg-ring group-active:bg-on-air ${
            axis === "x" ? "h-10 w-0.5" : "h-0.5 w-10"
          }`}
        />
      </div>
    )
  })
}
