import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Toaster } from "@/design/sonner"
import { CustomStreamForm } from "../custom/CustomStreamForm.tsx"
import { FullGuide } from "../guide/FullGuide.tsx"
import { Ribbon } from "../guide/Ribbon.tsx"
import * as GuideRelay from "../hub/GuideRelay.ts"
import { JoinRemote } from "../remote/JoinRemote.tsx"
import * as RemoteLink from "../remote/RemoteLink.ts"
import { useScreenRejectionToasts } from "../screen/Rejections.ts"
import { ScreenView } from "../screen/ScreenView.tsx"
import * as TilePlacements from "../screen/TilePlacements.ts"
import { useTheme } from "../ui/Theme.ts"
import { CommandPalette } from "./CommandPalette.tsx"
import { useConnectionToast } from "./ConnectionToast.ts"
import * as Covering from "./Covering.ts"
import { DisplayInput, Overlay } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"
import { GamePage } from "./GamePage.tsx"
import { KeysDialog } from "./KeysDialog.tsx"

/**
 * A Display: one column of the Screen and, while the guide's ribbon is open, the ribbon docked under it (the Screen
 * shrinks above it, and every video moves with it). The full guide, a game's page, the key help, Join Remote, the
 * palette and the YouTube form open over it, one at a time. Toasts sit at the bottom center, above the ribbon while it is open.
 */
export function DisplayView() {
  const display = useAtomValue(DisplayState.display)
  const input = useAtomSet(DisplayState.display)
  const closeOverlay = (open: boolean) => {
    if (!open) input(DisplayInput.Closed())
  }
  useAtomMount(DisplayState.inputs)
  useAtomMount(DisplayState.guideOpenSync)
  useAtomMount(GuideRelay.relay)
  useAtomMount(TilePlacements.sync)
  useAtomMount(Covering.sync)
  useAtomMount(RemoteLink.link)
  useScreenRejectionToasts()
  useConnectionToast()
  useTheme()
  const guide = Overlay.$is("Guide")(display.overlay) ? display.overlay : undefined
  const ribbon = guide?.level === "Ribbon" ? guide : undefined
  const toastOffset = { bottom: ribbon === undefined ? 16 : "calc(25vh + 12px)" }

  return (
    <>
      <div
        className={`grid h-screen ${ribbon === undefined ? "grid-rows-[minmax(0,1fr)]" : "grid-rows-[minmax(0,1fr)_25%]"}`}
      >
        <ScreenView />
        {ribbon !== undefined && <Ribbon entry={ribbon.entry} focus={ribbon.focus} />}
      </div>
      {guide?.level === "Full" && <FullGuide entry={guide.entry} focus={guide.focus} />}
      {Overlay.$is("GamePage")(display.overlay) && <GamePage game={display.overlay.game} />}
      <KeysDialog open={display.shows("Keys")} onOpenChange={closeOverlay} />
      {display.shows("JoinRemote") && <JoinRemote open onOpenChange={closeOverlay} />}
      <CommandPalette open={display.shows("Palette")} onOpenChange={closeOverlay} />
      {Overlay.$is("CustomForm")(display.overlay) && (
        <CustomStreamForm
          key={display.overlay.editing?.id ?? "add"}
          editing={display.overlay.editing}
          onOpenChange={closeOverlay}
        />
      )}
      <Toaster
        position="bottom-center"
        offset={toastOffset}
        mobileOffset={toastOffset}
        visibleToasts={1}
        toastOptions={{ style: { paddingBlock: 6, paddingInline: 12 } }}
      />
    </>
  )
}
