import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Toaster } from "@/design/sonner"
import * as AutopilotState from "../autopilot/AutopilotState.ts"
import * as GuideRelay from "../hub/GuideRelay.ts"
import { useScreenRejectionToasts } from "../screen/Rejections.ts"
import { ScreenView } from "../screen/ScreenView.tsx"
import * as TilePlacements from "../screen/TilePlacements.ts"
import { SlateView } from "../slate/SlateView.tsx"
import { CommandPalette } from "./CommandPalette.tsx"
import * as Covering from "./Covering.ts"
import { DisplayInput } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"
import { KeysDialog } from "./KeysDialog.tsx"
import { TopBar } from "./TopBar.tsx"

export function DisplayView() {
  const display = useAtomValue(DisplayState.display)
  const input = useAtomSet(DisplayState.display)
  const fullScreen = useAtomValue(DisplayState.fullScreen)
  const closeOverlay = (open: boolean) => {
    if (!open) input(DisplayInput.Closed())
  }
  useAtomMount(DisplayState.inputs)
  useAtomMount(GuideRelay.relay)
  useAtomMount(TilePlacements.sync)
  useAtomMount(Covering.sync)
  useAtomMount(AutopilotState.pilot)
  useScreenRejectionToasts()

  return (
    <>
      <div className={`grid h-screen ${fullScreen ? "grid-rows-[1fr]" : "grid-rows-[auto_1fr_auto]"}`}>
        {fullScreen ? null : <TopBar />}
        <ScreenView />
        {fullScreen || !display.slateOpen ? null : <SlateView />}
      </div>
      <KeysDialog open={display.shows("Keys")} onOpenChange={closeOverlay} />
      <CommandPalette open={display.shows("Palette")} onOpenChange={closeOverlay} />
      {/* Top center, inside the 44px top bar strip, so a toast never covers a video: a 5px offset, a compact
          one-line toast, and one toast at a time so none stacks below the bar. */}
      <Toaster
        position="top-center"
        offset={{ top: 5 }}
        mobileOffset={{ top: 5 }}
        visibleToasts={1}
        toastOptions={{ style: { paddingBlock: 6, paddingInline: 12 } }}
      />
    </>
  )
}
