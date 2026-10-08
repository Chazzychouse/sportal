import { Hotkey } from "@sportal/api/Hotkey"
import { useState } from "react"
import { Toaster } from "@/design/sonner"
import { dispatch } from "../hub/HubClient.ts"
import { runtime, useLive } from "../hub/HubRuntime.ts"
import { JoinRemote } from "../remote/JoinRemote.tsx"
import { useScreenFailureToasts } from "../screen/Rejections.ts"
import { ScreenView } from "../screen/ScreenView.tsx"
import { SlateView } from "../slate/SlateView.tsx"
import { StripCard } from "../slate/StripCards.ts"
import { CommandPalette } from "./CommandPalette.tsx"
import { Display, type DisplayStep } from "./Display.ts"
import { useFullScreen } from "./FullScreen.ts"
import { useHotkeys } from "./Hotkeys.ts"
import { KeysDialog } from "./KeysDialog.tsx"
import { OverlayHost } from "./OverlayHost.tsx"
import { TopBar } from "./TopBar.tsx"

export function DisplayView() {
  const live = useLive()
  const { display, run, set: setDisplay } = useDisplay()
  const closeOverlay = (open: boolean) => {
    if (!open) setDisplay(display.close())
  }
  const fullScreen = useFullScreen()
  const cards = StripCard.of(live.screen, live.slate)
  const selected = display.selectedOn(live.screen)
  const toggleSolo = display.press({ _tag: "ToggleSolo" }, live.screen, cards)
  const liveCount = live.slate.filter(({ snapshot }) => snapshot.progress() === "live").length
  useScreenFailureToasts()

  useHotkeys((hotkey: Hotkey) =>
    Hotkey.guards.FullScreen(hotkey) ? fullScreen.toggle() : run(display.press(hotkey, live.screen, cards))
  )

  return (
    <OverlayHost>
      <div className={`grid h-screen ${fullScreen.on ? "grid-rows-[1fr]" : "grid-rows-[auto_1fr_auto]"}`}>
        {fullScreen.on ? null : (
          <TopBar
            screen={live.screen}
            connection={live.connection}
            fullScreen={fullScreen}
            slate={{
              open: display.slateOpen,
              live: liveCount,
              toggle: () => setDisplay(display.toggleSlate())
            }}
            solo={{
              enabled: toggleSolo.commands.length > 0,
              toggle: () => run(toggleSolo)
            }}
            onKeys={() => setDisplay(display.open("Keys"))}
            onRemote={() => setDisplay(display.open("JoinRemote"))}
          />
        )}
        <ScreenView
          screen={live.screen}
          slate={live.slate}
          connection={live.connection}
          selected={selected}
          interacting={display.interactingOn(live.screen)}
          onSelect={(slot) => run(display.select(slot, live.screen))}
        />
        {fullScreen.on || !display.slateOpen ? null : (
          <SlateView cards={cards} display={display} screen={live.screen} onDrop={run} />
        )}
      </div>
      <KeysDialog open={display.shows("Keys")} onOpenChange={closeOverlay} />
      <JoinRemote open={display.shows("JoinRemote")} onOpenChange={closeOverlay} />
      <CommandPalette
        open={display.shows("Palette")}
        onOpenChange={closeOverlay}
        screen={live.screen}
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

/** This device's Display: its state, a step run (its display kept, its commands sent to the Hub), and a Display set. */
export function useDisplay() {
  const [display, set] = useState(Display.initial)
  const run = (step: DisplayStep) => {
    set(step.display)
    for (const command of step.commands) runtime.runFork(dispatch(command))
  }
  return { display, run, set }
}
