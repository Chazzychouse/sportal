import { Layout, type LayoutName } from "@sportal/domain/Layout"

/** A small drawing of a layout at its default split, main tile lit. */
export function LayoutGlyph(props: { name: LayoutName }) {
  const slots = new Layout({ name: props.name, split: Layout.defaultSplit(props.name) }).slots()
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

/** A layout's name as people read it. */
export function layoutLabel(name: LayoutName): string {
  switch (name) {
    case "Single":
      return "Single"
    case "Pair":
      return "Side by side"
    case "Quad":
      return "Quad"
    case "MainThree":
      return "Main + 3"
    case "MainFive":
      return "Main + 5"
  }
}
