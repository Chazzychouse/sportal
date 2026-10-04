import type { Hotkey } from "@sportal/api/Hotkey"
import type { GameId } from "@sportal/domain/Game"
import { Layout } from "@sportal/domain/Layout"
import { useState } from "react"
import { Toaster } from "@/design/sonner"
import { useFullScreen } from "./frame/FullScreen.ts"
import { JoinRemote } from "./frame/JoinRemote.tsx"
import { KeysDialog } from "./frame/KeysDialog.tsx"
import { TopBar } from "./frame/TopBar.tsx"
import { dispatch } from "./hub/HubClient.ts"
import { useLive } from "./hub/Live.ts"
import { OverlayHost } from "./OverlayHost.tsx"
import { SlateView } from "./slate/SlateView.tsx"
import { drop, nextPick, stripCards } from "./slate/StripCards.ts"
import { CommandPalette } from "./stage/CommandPalette.tsx"
import { useHotkeys } from "./stage/Hotkeys.ts"
import { useRejectionToasts } from "./stage/Rejections.ts"
import { StageView } from "./stage/StageView.tsx"

export function App() {
  const live = useLive()
  // The tile the next picked game goes to. Local to this client: it is a cursor, not shared state.
  const [selected, setSelected] = useState(0)
  const [palette, setPalette] = useState(false)
  const [keys, setKeys] = useState(false)
  const [joinRemote, setJoinRemote] = useState(false)
  const [slateOpen, setSlateOpen] = useState(true)
  // The slate card `[` `]` step to and Enter drops. Local, like `selected`.
  const [pick, setPick] = useState<GameId | undefined>(undefined)
  const fullScreen = useFullScreen()
  const cards = stripCards(live.stage, live.slate)
  // Puts a card in the selected tile, then selects the next empty tile, so the next drop fills it.
  const dropCard = (card: (typeof cards)[number]) => {
    const dropped = drop(card, live.stage, selected)
    if (dropped === undefined) return
    dispatch(dropped.command)
    setPick(card.id)
    setSelected(dropped.select)
  }
  useRejectionToasts()

  useHotkeys((hotkey: Hotkey) => {
    switch (hotkey._tag) {
      case "FocusAudio":
        return dispatch({ _tag: "FocusAudio", tile: hotkey.slot })
      case "Promote":
        return dispatch({ _tag: "Promote", tile: hotkey.slot })
      case "ToggleSolo":
        return dispatch(live.stage.solo === undefined ? { _tag: "Solo", tile: selected } : { _tag: "Unsolo" })
      case "Unsolo":
        // Esc closes the key help first, whether pressed here or in a stream view.
        if (keys) return setKeys(false)
        return live.stage.solo === undefined ? undefined : dispatch({ _tag: "Unsolo" })
      case "ToggleSlate":
        return setSlateOpen((open) => !open)
      case "StepPick":
        return setPick(nextPick(cards, pick, hotkey.step))
      case "DropPick": {
        const card = cards.find((card) => card.id === pick)
        return card === undefined ? undefined : dropCard(card)
      }
      case "SelectTile":
        return hotkey.slot < live.stage.onStage().length ? setSelected(hotkey.slot) : undefined
      case "ShowKeys":
        return setKeys((open) => !open)
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
      <div className={`grid h-screen ${fullScreen.on ? "grid-rows-[1fr]" : "grid-rows-[auto_1fr_auto]"}`}>
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
            onKeys={() => setKeys(true)}
            onRemote={() => setJoinRemote(true)}
          />
        )}
        <StageView
          stage={live.stage}
          slate={live.slate}
          connected={live.connected}
          selected={selected}
          onSelect={setSelected}
        />
        {fullScreen.on || !slateOpen ? null : (
          <SlateView
            cards={cards}
            selected={selected}
            pick={pick}
            watchability={live.watchability}
            onDrop={dropCard}
          />
        )}
      </div>
      <KeysDialog open={keys} onOpenChange={setKeys} />
      <JoinRemote open={joinRemote} onOpenChange={setJoinRemote} />
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        stage={live.stage}
        slate={live.slate}
        selected={selected}
        onFullScreen={fullScreen.toggle}
        onKeys={() => setKeys(true)}
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
