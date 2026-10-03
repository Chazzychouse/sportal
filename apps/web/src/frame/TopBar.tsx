import { Layout, LayoutName } from "@sportal/domain/Layout"
import type { Stage } from "@sportal/domain/Stage"
import { Expand, LogIn, Minimize2, Shrink, SquareDashed } from "lucide-react"
import { Button } from "@/design/button"
import { ToggleGroup, ToggleGroupItem } from "@/design/toggle-group"
import { dispatch } from "../hub/HubClient.ts"
import { LayoutGlyph, layoutLabel } from "./LayoutGlyph.tsx"

/** The strip across the top of a Display: layout, solo, full screen, and whether the Hub is live. */
export function TopBar(props: {
  stage: Stage
  connected: boolean
  selected: number
  fullScreen: { on: boolean; toggle: () => void }
}) {
  const selectedTile = props.stage.onStage()[props.selected]
  const canSolo = selectedTile !== undefined && selectedTile._tag !== "Empty"
  return (
    <header className="flex h-11 items-center gap-4 border-b bg-card/60 px-3">
      <span className="label-caps flex items-center gap-2 text-[15px] tracking-[0.22em]">
        <span className="size-2 rounded-full bg-on-air shadow-[0_0_8px_var(--on-air)]" />
        Sportal
      </span>
      <span className="h-5 w-px bg-border" />

      <ToggleGroup
        type="single"
        size="sm"
        value={props.stage.layout}
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
            aria-label={layoutLabel(name)}
            title={`${layoutLabel(name)} · ${Layout.slotCount(name) === 1 ? "1 tile" : `${Layout.slotCount(name)} tiles`}`}
            className="text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-on-air"
          >
            <LayoutGlyph name={name} />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Button
        variant="ghost"
        size="sm"
        className="label-caps text-xs"
        disabled={props.stage.solo === undefined && !canSolo}
        onClick={() =>
          dispatch(
            props.stage.solo === undefined ? { _tag: "Solo", tile: props.selected } : { _tag: "Unsolo" }
          )
        }
      >
        {props.stage.solo === undefined ? <SquareDashed /> : <Shrink />}
        {props.stage.solo === undefined ? "Solo" : "Unsolo"}
        <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">F</kbd>
      </Button>

      <div className="ml-auto flex items-center gap-3">
        {window.sportalShell && (
          <Button
            variant="ghost"
            size="sm"
            className="label-caps text-xs text-muted-foreground"
            onClick={() => window.sportalShell?.openSignIn()}
          >
            <LogIn />
            YouTube TV
          </Button>
        )}
        <span
          className={`label-caps flex items-center gap-1.5 text-[11px] ${
            props.connected ? "text-live" : "text-warn"
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${props.connected ? "bg-live" : "animate-pulse bg-warn"}`}
          />
          {props.connected ? "Hub live" : "Reconnecting"}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Full screen" onClick={props.fullScreen.toggle}>
          {props.fullScreen.on ? <Minimize2 /> : <Expand />}
        </Button>
      </div>
    </header>
  )
}
