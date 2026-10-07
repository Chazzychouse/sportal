import type { Hotkey } from "@sportal/api/Hotkey"
import { useState } from "react"
import { Toaster } from "@/design/sonner"
import { dispatch } from "../hub/HubClient.ts"
import { runtime, useLive } from "../hub/HubRuntime.ts"
import { JoinRemote } from "../remote/JoinRemote.tsx"
import { SlateView } from "../slate/SlateView.tsx"
import { StripCard } from "../slate/StripCards.ts"
import { useStageFailureToasts } from "../stage/Rejections.ts"
import { StageView } from "../stage/StageView.tsx"
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
  const cards = StripCard.of(live.stage, live.slate)
  const selected = display.selectedOn(live.stage)
  const toggleSolo = display.press({ _tag: "ToggleSolo" }, live.stage, cards)
  const liveCount = live.slate.filter((game) => game.progress() === "live").length
  useStageFailureToasts()

  useHotkeys((hotkey: Hotkey) =>
    hotkey._tag === "FullScreen" ? fullScreen.toggle() : run(display.press(hotkey, live.stage, cards))
  )

  return (
    <OverlayHost>
      <div className={`grid h-screen ${fullScreen.on ? "grid-rows-[1fr]" : "grid-rows-[auto_1fr_auto]"}`}>
        {fullScreen.on ? null : (
          <TopBar
            stage={live.stage}
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
        <StageView
          stage={live.stage}
          slate={live.slate}
          connection={live.connection}
          selected={selected}
          interacting={display.interactingOn(live.stage)}
          onSelect={(slot) => run(display.select(slot, live.stage))}
        />
        {fullScreen.on || !display.slateOpen ? null : (
          <SlateView cards={cards} display={display} stage={live.stage} onDrop={run} />
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

/** This device's Display: its state, a step run (its display kept, its commands sent to the Hub), and a Display set. */
export function useDisplay() {
  const [display, set] = useState(Display.initial)
  const run = (step: DisplayStep) => {
    set(step.display)
    for (const command of step.commands) runtime.runFork(dispatch(command))
  }
  return { display, run, set }
}
