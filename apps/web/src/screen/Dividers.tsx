import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { useRef } from "react"
import { DisplayInput } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { Layout } from "../layout/Layout.ts"
import { type LayoutName, Screen, type Split } from "./Screen.ts"
import * as TilePlacements from "./TilePlacements.ts"
import * as TileRects from "./TileRects.ts"

/**
 * Drag handles in the gaps between tiles, one per divider the layout uses. While dragging, the split is shown
 * through `TilePlacements.dragged`; on release it is committed to the Screen.
 */
export function Dividers(props: { layout: LayoutName; split: Split }) {
  const area = useAtomValue(TilePlacements.area)
  const setDragged = useAtomSet(TilePlacements.dragged)
  const input = useAtomSet(DisplayState.display)
  const dragging = useRef<Split | undefined>(undefined)

  return Layout.dividers(props.layout).map((axis) => {
    const at = props.split[axis] * (axis === "x" ? area.width : area.height)

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
        style={
          axis === "x"
            ? { left: at - TileRects.gap / 2, width: TileRects.gap }
            : { top: at - TileRects.gap / 2, height: TileRects.gap }
        }
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
          const split = Layout.clamp({ ...dragging.current, [axis]: fraction })
          dragging.current = split
          setDragged(Option.some(split))
        }}
        onPointerUp={() => {
          const split = dragging.current
          dragging.current = undefined
          if (split === undefined) return
          // Committed before the drag is cleared, so the shown split never falls back to the old one in between.
          input(DisplayInput.Commanded({ command: { _tag: "SetSplit", split } }))
          setDragged(Option.none())
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
