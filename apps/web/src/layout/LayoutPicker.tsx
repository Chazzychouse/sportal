import { Layout, LayoutName } from "@sportal/domain/Layout"
import { cn } from "@/design/ClassName"
import { ToggleGroup, ToggleGroupItem } from "@/design/toggle-group"
import { dispatch } from "../hub/HubClient.ts"
import { LayoutGlyph, layoutLabel } from "./LayoutGlyph.tsx"

/**
 * One button per layout, the current one lit; choosing one sends it to the Hub. `fill` spreads the buttons across
 * the row at a thumb's height, for the Remote.
 */
export function LayoutPicker(props: { current: LayoutName; fill?: boolean }) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={props.current}
      onValueChange={(value) => {
        const layout = LayoutName.literals.find((name) => name === value)
        if (layout !== undefined) dispatch({ _tag: "SetLayout", layout })
      }}
      aria-label="Layout"
      className={props.fill === true ? "w-full justify-between" : undefined}
    >
      {LayoutName.literals.map((name) => (
        <ToggleGroupItem
          key={name}
          value={name}
          aria-label={layoutLabel(name)}
          title={`${layoutLabel(name)} · ${Layout.slotCount(name) === 1 ? "1 tile" : `${Layout.slotCount(name)} tiles`}`}
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
