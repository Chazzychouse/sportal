import { Layout, LayoutName } from "@sportal/domain/Layout"
import type { Stage } from "@sportal/domain/Stage"
import { Expand, Keyboard, List, LogIn, Minimize2, Shrink, Smartphone, SquareDashed } from "lucide-react"
import { Button } from "@/design/button"
import { ToggleGroup, ToggleGroupItem } from "@/design/toggle-group"
import { dispatch } from "../hub/HubClient.ts"
import { LayoutGlyph, layoutLabel } from "./LayoutGlyph.tsx"

/** The strip across the top of a Display: the slate, layout, solo, full screen, and whether the Hub is live. */
export function TopBar(props: {
  stage: Stage
  connected: boolean
  selected: number
  fullScreen: { on: boolean; toggle: () => void }
  slate: { open: boolean; live: number; toggle: () => void }
  onToggleSolo: () => void
  onKeys: () => void
  onRemote: () => void
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
      <Button
        variant="ghost"
        size="sm"
        aria-keyshortcuts="S"
        aria-pressed={props.slate.open}
        className={`label-caps text-xs ${props.slate.open ? "bg-accent" : ""}`}
        onClick={props.slate.toggle}
      >
        <List />
        Slate
        {props.slate.live > 0 && (
          <span className="flex items-center gap-1 font-mono text-live">
            <span className="size-1.5 rounded-full bg-live" />
            {props.slate.live}
          </span>
        )}
        <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">S</kbd>
      </Button>
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
        aria-keyshortcuts="F"
        disabled={props.stage.solo === undefined && !canSolo}
        onClick={props.onToggleSolo}
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
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remote"
          title="Control from a phone"
          className="text-muted-foreground"
          onClick={props.onRemote}
        >
          <Smartphone />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Keys"
          aria-keyshortcuts="?"
          title="Keys · ?"
          className="text-muted-foreground"
          onClick={props.onKeys}
        >
          <Keyboard />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Full screen"
          aria-keyshortcuts="F11"
          title="Full screen · F11"
          onClick={props.fullScreen.toggle}
        >
          {props.fullScreen.on ? <Minimize2 /> : <Expand />}
        </Button>
      </div>
    </header>
  )
}
