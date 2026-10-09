import type { Screen } from "@sportal/domain/Screen"
import { Option } from "effect"
import { Expand, Keyboard, List, LogIn, Minimize2, Shrink, SquareDashed } from "lucide-react"
import { Button } from "@/design/button"
import type * as LiveStream from "../hub/LiveStream.ts"
import { LayoutPicker } from "../layout/LayoutPicker.tsx"
import { BrandMark, ConnectionPill } from "./Brand.tsx"

/** The strip across the top of a Display: the slate, layout, solo, full screen, and whether the Hub is live. */
export function TopBar(props: {
  screen: Screen
  connection: LiveStream.Connection
  fullScreen: { on: boolean; toggle: () => void }
  slate: { open: boolean; live: number; toggle: () => void }
  solo: { enabled: boolean; toggle: () => void }
  onKeys: () => void
}) {
  return (
    <header className="flex h-11 items-center gap-4 border-b bg-card/60 px-3">
      <BrandMark />
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

      <LayoutPicker current={props.screen.layout} />

      <Button
        variant="ghost"
        size="sm"
        className="label-caps text-xs"
        aria-keyshortcuts="F"
        disabled={!props.solo.enabled}
        onClick={props.solo.toggle}
      >
        {Option.isNone(props.screen.solo) ? <SquareDashed /> : <Shrink />}
        {Option.isNone(props.screen.solo) ? "Solo" : "Unsolo"}
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
        <ConnectionPill connection={props.connection} />
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
