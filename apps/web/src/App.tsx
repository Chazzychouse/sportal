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
import { Bench } from "./stage/Bench.tsx"
import { CommandPalette } from "./stage/CommandPalette.tsx"
import { useHotkeys } from "./stage/Hotkeys.ts"
import { StageView } from "./stage/StageView.tsx"

export function App() {
  const live = useLive()
  // The tile the next picked game goes to. Local to this client: it is a cursor, not shared state.
  const [selected, setSelected] = useState(0)
  const [palette, setPalette] = useState(false)
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
        return live.stage.solo === undefined ? undefined : dispatch({ _tag: "Unsolo" })
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
          <TopBar stage={live.stage} connected={live.connected} selected={selected} fullScreen={fullScreen} />
        )}
        <div className={`grid min-h-0 ${fullScreen.on ? "grid-cols-[1fr]" : "grid-cols-[20rem_1fr]"}`}>
          {fullScreen.on ? null : (
            <aside className="flex min-h-0 flex-col border-r bg-card/40">
              <SlateView
                slate={live.slate}
                selected={selected}
                onPick={(game) => dispatch({ _tag: "Assign", tile: selected, game: game.id })}
              />
              <Bench stage={live.stage} slate={live.slate} selected={selected} />
            </aside>
          )}
          <StageView
            stage={live.stage}
            slate={live.slate}
            connected={live.connected}
            selected={selected}
            onSelect={setSelected}
          />
        </div>
      </div>
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        stage={live.stage}
        slate={live.slate}
        selected={selected}
        onFullScreen={fullScreen.toggle}
      />
      {/* Bottom left, over the sidebar: a toast never covers a video. */}
      <Toaster position="bottom-left" />
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
