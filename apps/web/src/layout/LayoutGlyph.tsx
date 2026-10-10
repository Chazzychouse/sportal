import type { LayoutName } from "../screen/Screen.ts"
import { Layout } from "./Layout.ts"

/** A small drawing of a layout at its default split, main tile lit. */
export function LayoutGlyph(props: { name: LayoutName }) {
  const slots = Layout.ofDefault(props.name).slots()
  return (
    <svg viewBox="0 0 32 18" className="h-3.5 w-6" aria-hidden="true">
      {slots.map((slot, index) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: a slot is identified by its place in the layout.
          key={index}
          x={slot.x * 32 + 0.75}
          y={slot.y * 18 + 0.75}
          width={slot.width * 32 - 1.5}
          height={slot.height * 18 - 1.5}
          rx={0.75}
          className={index === 0 ? "fill-current" : "fill-current opacity-35"}
        />
      ))}
    </svg>
  )
}
