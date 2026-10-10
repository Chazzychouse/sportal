import { useAtomSet } from "@effect/atom-react"
import { ToggleGroup, ToggleGroupItem } from "@/design/toggle-group"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { LayoutName, Screen } from "../screen/Screen.ts"
import { Layout } from "./Layout.ts"
import { LayoutGlyph } from "./LayoutGlyph.tsx"

/** One button per layout, the current one lit; choosing one applies it. */
export function LayoutPicker(props: { current: LayoutName }) {
  const dispatch = useAtomSet(DisplayScreen.screen)
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
    >
      {LayoutName.literals.map((name) => (
        <ToggleGroupItem
          key={name}
          value={name}
          aria-label={Layout.label(name)}
          title={`${Layout.label(name)} · ${Screen.slotCount(name) === 1 ? "1 tile" : `${Screen.slotCount(name)} tiles`}`}
          className="text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-on-air"
        >
          <LayoutGlyph name={name} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
