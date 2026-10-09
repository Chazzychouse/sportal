import { LayoutName, Screen } from "@sportal/domain/Screen"
import { cn } from "@/design/ClassName"
import { ToggleGroup, ToggleGroupItem } from "@/design/toggle-group"
import { dispatch } from "../hub/HubClient.ts"
import { runtime } from "../hub/HubRuntime.ts"
import { LayoutGlyph, layoutLabel } from "./LayoutGlyph.tsx"

/** One button per layout, the current one lit; choosing one sends it to the Hub. */
export function LayoutPicker(props: { current: LayoutName }) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={props.current}
      onValueChange={(value) => {
        const layout = LayoutName.literals.find((name) => name === value)
        if (layout !== undefined) runtime.runFork(dispatch({ _tag: "SetLayout", layout }))
      }}
      aria-label="Layout"
    >
      {LayoutName.literals.map((name) => (
        <ToggleGroupItem
          key={name}
          value={name}
          aria-label={layoutLabel(name)}
          title={`${layoutLabel(name)} · ${Screen.slotCount(name) === 1 ? "1 tile" : `${Screen.slotCount(name)} tiles`}`}
          className={cn("text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-on-air")}
        >
          <LayoutGlyph name={name} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
