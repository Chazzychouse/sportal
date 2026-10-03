import type { Hotkey } from "@sportal/api/Hotkey"
import { Layout } from "@sportal/domain/Layout"
import type { StageRejection } from "@sportal/domain/Stage"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Toaster } from "@/design/sonner"
import { useFullScreen } from "./frame/FullScreen.ts"
import { TopBar } from "./frame/TopBar.tsx"
import { dispatch, onStageRejected } from "./hub/HubClient.ts"
import { useLive } from "./hub/Live.ts"
import { OverlayHost } from "./OverlayHost.tsx"
import { SlateView } from "./slate/SlateView.tsx"
import { CommandPalette } from "./stage/CommandPalette.tsx"
import { useHotkeys } from "./stage/Hotkeys.ts"
import { StageView } from "./stage/StageView.tsx"

export function App() {
  const live = useLive()
  // The tile the next picked game goes to. Local to this client: it is a cursor, not shared state.
  const [selected, setSelected] = useState(0)
  const [palette, setPalette] = useState(false)
  const [slateOpen, setSlateOpen] = useState(false)
  const fullScreen = useFullScreen()

  useEffect(() => onStageRejected((reason) => toast.warning(rejectionText(reason))), [])

  useHotkeys((hotkey: Hotkey) => {
    switch (hotkey._tag) {
      case "FocusAudio":
        return dispatch({ _tag: "FocusAudio", tile: hotkey.slot })
      case "Promote":
        return dispatch({ _tag: "Promote", tile: hotkey.slot })
      case "ToggleSolo":
        return dispatch(live.stage.solo === undefined ? { _tag: "Solo", tile: selected } : { _tag: "Unsolo" })
      case "Unsolo":
        // Esc closes the open slate first, whether pressed here or in a stream view.
        if (slateOpen) return setSlateOpen(false)
        return live.stage.solo === undefined ? undefined : dispatch({ _tag: "Unsolo" })
      case "ToggleSlate":
        return setSlateOpen((open) => !open)
      case "FullScreen":
        return fullScreen.toggle()
      case "NextLayout":
        return dispatch({ _tag: "SetLayout", layout: Layout.next(live.stage.layout) })
      case "CommandPalette":
        return setPalette((open) => !open)
    }
  })

  return (
    <OverlayHost>
      <div className={`grid h-screen ${fullScreen.on ? "grid-rows-[1fr]" : "grid-rows-[auto_1fr]"}`}>
        {fullScreen.on ? null : (
          <TopBar
            stage={live.stage}
            connected={live.connected}
            selected={selected}
            fullScreen={fullScreen}
            slate={{
              open: slateOpen,
              live: live.slate.filter((game) => game.isLive()).length,
              toggle: () => setSlateOpen((open) => !open)
            }}
          />
        )}
        <StageView
          stage={live.stage}
          slate={live.slate}
          connected={live.connected}
          selected={selected}
          onSelect={setSelected}
        />
      </div>
      <SlateView
        open={slateOpen}
        onOpenChange={setSlateOpen}
        stage={live.stage}
        slate={live.slate}
        selected={selected}
        fullScreen={fullScreen.on}
      />
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        stage={live.stage}
        slate={live.slate}
        selected={selected}
        onFullScreen={fullScreen.toggle}
      />
      {/* Top center, over the top bar: a toast never covers a video. */}
      <Toaster position="top-center" />
    </OverlayHost>
  )
}

function rejectionText(reason: StageRejection["reason"]): string {
  switch (reason) {
    case "no-such-tile":
      return "There is no tile there."
    case "empty-tile":
      return "That tile is empty."
    case "offstage-tile":
      return "That game is on the bench. Swap it in first."
    case "split-out-of-range":
      return "Every tile needs some room."
  }
}
