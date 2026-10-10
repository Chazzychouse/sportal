import { cn } from "@/design/ClassName"
import { ToggleGroup, ToggleGroupItem } from "@/design/toggle-group"
import { LayoutName, Screen } from "../screen/Screen.ts"
import { Layout } from "./Layout.ts"
import { LayoutGlyph } from "./LayoutGlyph.tsx"

/**
 * One button per layout, the current one lit; choosing one calls `onChoose`. `fill` spreads the buttons across the row
 * at a thumb's height, for the Remote.
 */
export function LayoutPicker(props: {
  current: LayoutName
  onChoose: (layout: LayoutName) => void
  fill?: boolean
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={props.current}
      onValueChange={(value) => {
        const layout = LayoutName.literals.find((name) => name === value)
        if (layout !== undefined) props.onChoose(layout)
      }}
      aria-label="Layout"
      className={props.fill === true ? "w-full justify-between" : undefined}
    >
      {LayoutName.literals.map((name) => (
        <ToggleGroupItem
          key={name}
          value={name}
          aria-label={Layout.label(name)}
          title={`${Layout.label(name)} · ${Screen.slotCount(name) === 1 ? "1 tile" : `${Screen.slotCount(name)} tiles`}`}
          className={cn(
            "text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-on-air",
            props.fill === true && "min-h-10 flex-1"
          )}
        >
          <LayoutGlyph name={name} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
