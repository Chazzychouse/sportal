import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { Expand, Keyboard, List, LogIn, Minimize2, Shrink, Smartphone, SquareDashed } from "lucide-react"
import { Button } from "@/design/button"
import * as LiveStream from "../hub/LiveStream.ts"
import { LayoutPicker } from "../layout/LayoutPicker.tsx"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { BrandMark, ConnectionPill } from "./Brand.tsx"
import { DisplayInput } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"

/**
 * The strip across the top of a Display: the slate, layout, solo, full screen, and whether the Hub is live.
 */
export function TopBar() {
  const display = useAtomValue(DisplayState.display)
  const input = useAtomSet(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const cards = useAtomValue(DisplayState.cards)
  const { connection, slate } = useAtomValue(LiveStream.live)
  const fullScreen = useAtomValue(DisplayState.fullScreen)
  const toggleFullScreen = useAtomSet(DisplayState.toggleFullScreen)
  const signIn = useAtomValue(DisplayState.signIn)
  const openSignIn = useAtomSet(DisplayState.openSignIn)
  const soloToggles = display.press({ _tag: "ToggleSolo" }, screen, cards).commands.length > 0
  const live = slate.games.filter(({ snapshot }) => snapshot.progress() === "live").length

  return (
    <header className="flex h-11 items-center gap-4 border-b bg-card/60 px-3">
      <BrandMark />
      <span className="h-5 w-px bg-border" />
      <Button
        variant="ghost"
        size="sm"
        aria-keyshortcuts="S"
        aria-pressed={display.slateOpen}
        className={`label-caps text-xs ${display.slateOpen ? "bg-accent" : ""}`}
        onClick={() => input(DisplayInput.SlateToggled())}
      >
        <List />
        Slate
        {live > 0 && (
          <span className="flex items-center gap-1 font-mono text-live">
            <span className="size-1.5 rounded-full bg-live" />
            {live}
          </span>
        )}
        <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">S</kbd>
      </Button>
      <span className="h-5 w-px bg-border" />

      <LayoutPicker
        current={screen.layout}
        onChoose={(layout) => input(DisplayInput.Commanded({ command: { _tag: "SetLayout", layout } }))}
      />

      <Button
        variant="ghost"
        size="sm"
        className="label-caps text-xs"
        aria-keyshortcuts="F"
        disabled={!soloToggles}
        onClick={() => input(DisplayInput.Pressed({ hotkey: { _tag: "ToggleSolo" } }))}
      >
        {Option.isNone(screen.solo) ? <SquareDashed /> : <Shrink />}
        {Option.isNone(screen.solo) ? "Solo" : "Unsolo"}
        <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">F</kbd>
      </Button>

      <div className="ml-auto flex items-center gap-3">
        {signIn && (
          <Button
            variant="ghost"
            size="sm"
            className="label-caps text-xs text-muted-foreground"
            onClick={() => openSignIn(undefined)}
          >
            <LogIn />
            YouTube TV
          </Button>
        )}
        <ConnectionPill connection={connection} />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remote"
          title="Control from a phone"
          className="text-muted-foreground"
          onClick={() => input(DisplayInput.Opened({ overlay: "JoinRemote" }))}
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
          onClick={() => input(DisplayInput.Opened({ overlay: "Keys" }))}
        >
          <Keyboard />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Full screen"
          aria-keyshortcuts="F11"
          title="Full screen · F11"
          onClick={() => toggleFullScreen(undefined)}
        >
          {fullScreen ? <Minimize2 /> : <Expand />}
        </Button>
      </div>
    </header>
  )
}
