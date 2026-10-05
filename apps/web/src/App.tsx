import type { Hotkey } from "@sportal/api/Hotkey"
import type { StageCommand } from "@sportal/domain/Stage"
import { useState } from "react"
import { Toaster } from "@/design/sonner"
import { Display } from "./Display.ts"
import { useFullScreen } from "./frame/FullScreen.ts"
import { JoinRemote } from "./frame/JoinRemote.tsx"
import { KeysDialog } from "./frame/KeysDialog.tsx"
import { TopBar } from "./frame/TopBar.tsx"
import { dispatch } from "./hub/HubClient.ts"
import { useLive } from "./hub/Live.ts"
import { OverlayHost } from "./OverlayHost.tsx"
import { SlateView } from "./slate/SlateView.tsx"
import { stripCards } from "./slate/StripCards.ts"
import { CommandPalette } from "./stage/CommandPalette.tsx"
import { useHotkeys } from "./stage/Hotkeys.ts"
import { useRejectionToasts } from "./stage/Rejections.ts"
import { StageView } from "./stage/StageView.tsx"

export function App() {
  const live = useLive()
  const [display, setDisplay] = useState(Display.initial)
  const apply = (next: { display: Display; commands: ReadonlyArray<StageCommand> }) => {
    setDisplay(next.display)
    for (const command of next.commands) dispatch(command)
  }
  const closeOverlay = (open: boolean) => {
    if (!open) setDisplay(display.close())
  }
  const fullScreen = useFullScreen()
  const cards = stripCards(live.stage, live.slate)
  const selected = display.selectedOn(live.stage)
  useRejectionToasts()

  useHotkeys((hotkey: Hotkey) =>
    hotkey._tag === "FullScreen" ? fullScreen.toggle() : apply(display.press(hotkey, live.stage, cards))
  )

  return (
    <OverlayHost>
      <div className={`grid h-screen ${fullScreen.on ? "grid-rows-[1fr]" : "grid-rows-[auto_1fr_auto]"}`}>
        {fullScreen.on ? null : (
          <TopBar
            stage={live.stage}
            connected={live.connected}
            selected={selected}
            fullScreen={fullScreen}
            slate={{
              open: display.slateOpen,
              live: live.slate.filter((game) => game.progress() === "live").length,
              toggle: () => setDisplay(display.toggleSlate())
            }}
            onToggleSolo={() => apply(display.press({ _tag: "ToggleSolo" }, live.stage, cards))}
            onKeys={() => setDisplay(display.open("Keys"))}
            onRemote={() => setDisplay(display.open("JoinRemote"))}
          />
        )}
        <StageView
          stage={live.stage}
          slate={live.slate}
          connected={live.connected}
          selected={selected}
          interacting={display.interactingOn(live.stage)}
          onSelect={(slot) => apply(display.select(slot, live.stage))}
        />
        {fullScreen.on || !display.slateOpen ? null : (
          <SlateView
            cards={cards}
            display={display}
            stage={live.stage}
            watchability={live.watchability}
            onDrop={apply}
          />
        )}
      </div>
      <KeysDialog open={display.overlay._tag === "Keys"} onOpenChange={closeOverlay} />
      <JoinRemote open={display.overlay._tag === "JoinRemote"} onOpenChange={closeOverlay} />
      <CommandPalette
        open={display.overlay._tag === "Palette"}
        onOpenChange={closeOverlay}
        stage={live.stage}
        slate={live.slate}
        selected={selected}
        onFullScreen={fullScreen.toggle}
        onKeys={() => setDisplay(display.open("Keys"))}
      />
      {/* Top center, inside the 44px top bar strip, so a toast never covers a video: a 5px offset, a compact
          one-line toast, and one toast at a time so none stacks below the bar. */}
      <Toaster
        position="top-center"
        offset={{ top: 5 }}
        mobileOffset={{ top: 5 }}
        visibleToasts={1}
        toastOptions={{ style: { paddingBlock: 6, paddingInline: 12 } }}
      />
    </OverlayHost>
  )
}
