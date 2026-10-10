import { useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react"
import type { DisplayId } from "@sportal/api/DisplayId"
import type { Hotkey } from "@sportal/api/Hotkey"
import { Array as Arr, Option } from "effect"
import { Shrink } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Toaster } from "@/design/sonner"
import { AutopilotToggle } from "../autopilot/AutopilotToggle.tsx"
import { BrandMark, ConnectionPill } from "../display/Brand.tsx"
import { DisplayInput } from "../display/Display.ts"
import { GameStatus } from "../game/GameStatus.tsx"
import { Score } from "../game/Score.tsx"
import * as LiveStream from "../hub/LiveStream.ts"
import { LayoutPicker } from "../layout/LayoutPicker.tsx"
import { PromptsToggle } from "../prompts/PromptsToggle.tsx"
import { Screen } from "../screen/Screen.ts"
import { PlaceBadge } from "../slate/PlaceBadge.tsx"
import { StripCard } from "../slate/StripCard.ts"
import * as Chime from "./Chime.ts"
import { RemotePrompt } from "./RemotePrompt.tsx"
import * as RemoteState from "./RemoteState.ts"
import { Followed } from "./RemoteState.ts"
import { ScreenMap } from "./ScreenMap.tsx"

/**
 * The Remote: a phone's view of one Display. Its prompt on top, then its toggles, its layout and tiles in miniature,
 * and the slate in tabs; tapping a game puts it in the selected tile and selects the next empty one.
 */
export function RemoteView(props: { id: DisplayId }) {
  const live = useAtomValue(LiveStream.live)
  const followed = useAtomValue(RemoteState.followed(props.id))
  const display = useAtomValue(RemoteState.display(props.id))
  const input = useAtomSet(RemoteState.display(props.id))
  const send = useAtomSet(RemoteState.send(props.id))
  const [soundReady, setSoundReady] = useState(Chime.unlocked)
  const [tab, setTab] = useState<StripCard["section"]>("Live")
  useAtomSubscribe(RemoteState.promptKey(props.id), (key) => {
    if (key !== undefined) Chime.play()
  })
  useAtomSubscribe(RemoteState.offline, (count) => {
    if (count > 0) toast.warning("The Display is offline")
  })
  const press = (hotkey: Hotkey) => send({ _tag: "Pressed", hotkey })

  return (
    <div
      className="min-h-dvh bg-background pb-[env(safe-area-inset-bottom)]"
      // A tap's pointerup is what iOS counts as a gesture that may start audio; a touch's pointerdown is not.
      onPointerUp={() => {
        Chime.unlock()
        setSoundReady(true)
      }}
    >
      {Followed.$match(followed, {
        Connecting: () => <Waiting cards={StripCard.of(Screen.initial, live.slate, live.classifications)} />,
        Offline: () => <Waiting cards={StripCard.of(Screen.initial, live.slate, live.classifications)} />,
        Reported: ({ report }) => {
          const cards = StripCard.of(report.screen, live.slate, live.classifications)
          const shown = Arr.dedupe(cards.map((card) => card.section))
          const open = shown.includes(tab) ? tab : shown[0]
          return (
            <>
              <div className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-background/95 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
                <RemotePrompt
                  prompt={report.prompt}
                  slate={live.slate}
                  soundReady={soundReady}
                  onAccept={() => press({ _tag: "AcceptPrompt" })}
                  onDismiss={() => press({ _tag: "DismissPrompt" })}
                />
                <header className="flex flex-wrap items-center gap-2">
                  <BrandMark />
                  <ConnectionPill connection={live.connection} />
                  <AutopilotToggle
                    autopilot={report.autopilot}
                    slate={live.slate}
                    classifications={live.classifications}
                    screen={report.screen}
                    onToggle={() => press({ _tag: "ToggleAutopilot" })}
                  />
                  <PromptsToggle
                    prompts={report.prompts}
                    prompt={report.prompt}
                    slate={live.slate}
                    onToggle={() => press({ _tag: "TogglePrompts" })}
                  />
                  {Option.isSome(report.screen.solo) && (
                    <button
                      type="button"
                      onClick={() => send({ _tag: "Commanded", command: { _tag: "Unsolo" } })}
                      className="label-caps ml-auto flex min-h-9 items-center gap-1 rounded-sm border px-2 text-[11px]"
                    >
                      <Shrink className="size-3.5" />
                      Unsolo
                    </button>
                  )}
                </header>
                <LayoutPicker
                  current={report.screen.layout}
                  fill
                  onChoose={(layout) => send({ _tag: "Commanded", command: { _tag: "SetLayout", layout } })}
                />
                <ScreenMap
                  screen={report.screen}
                  slate={live.slate}
                  selected={display.selectedOn(report.screen)}
                  onSelect={(slot) => input(DisplayInput.Selected({ slot }))}
                  onCommand={(command) => send({ _tag: "Commanded", command })}
                />
              </div>
              <SlateList
                cards={cards}
                open={open}
                onTab={setTab}
                onDrop={(card) => input(DisplayInput.Dropped({ card }))}
              />
            </>
          )
        }
      })}
      <Toaster position="bottom-center" />
    </div>
  )
}

/** While the Display is not reporting: say so, and keep the slate readable with nothing to tap. */
function Waiting(props: { cards: ReadonlyArray<StripCard> }) {
  const [tab, setTab] = useState<StripCard["section"]>("Live")
  const shown = Arr.dedupe(props.cards.map((card) => card.section))
  return (
    <>
      <p className="px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-1 text-muted-foreground text-sm">
        Display offline, waiting…
      </p>
      <SlateList
        cards={props.cards}
        open={shown.includes(tab) ? tab : shown[0]}
        onTab={setTab}
        onDrop={undefined}
      />
    </>
  )
}

/** The slate in tabs, one per section with games; a row's tap drops its game, or nothing without `onDrop`. */
function SlateList(props: {
  cards: ReadonlyArray<StripCard>
  open: StripCard["section"] | undefined
  onTab: (section: StripCard["section"]) => void
  onDrop: ((card: StripCard) => void) | undefined
}) {
  const { cards, open, onDrop } = props
  const shown = Arr.dedupe(cards.map((card) => card.section))
  return (
    <>
      <nav className="flex gap-1 px-3 pt-3" aria-label="Slate">
        {shown.map((section) => (
          <button
            key={section}
            type="button"
            aria-pressed={open === section}
            onClick={() => props.onTab(section)}
            className={`label-caps min-h-9 flex-1 rounded-sm text-[11px] ${
              open === section ? "bg-accent text-foreground" : "text-muted-foreground"
            }`}
          >
            {section}{" "}
            <span className="font-mono">{cards.filter((card) => card.section === section).length}</span>
          </button>
        ))}
      </nav>
      {cards.length === 0 && (
        <p className="px-3 py-4 text-muted-foreground text-sm">No games in the slate.</p>
      )}
      <ul className="flex flex-col px-1.5 py-2">
        {cards
          .filter((card) => card.section === open)
          .map((card) => (
            <li key={card.id}>
              <button
                type="button"
                disabled={onDrop === undefined || !card.pickable()}
                onClick={() => onDrop?.(card)}
                className={`grid min-h-14 w-full grid-cols-[20px_1fr_2.5rem_7.5rem] items-center gap-x-2 rounded-sm px-1.5 py-1.5 text-left font-mono text-sm tabular-nums active:bg-accent disabled:opacity-60 ${
                  card.game?.progress() === "over" ? "opacity-70" : ""
                }`}
              >
                {card.game === undefined ? (
                  <span className="col-span-4 text-muted-foreground">Off the slate</span>
                ) : (
                  <>
                    <Score game={card.game} side="away" />
                    <GameStatus game={card.game} className="text-right text-[11px]" />
                    <Score game={card.game} side="home" />
                    <span className="flex items-center justify-end gap-1.5">
                      <span className="max-w-28 truncate font-sans text-[11px] text-muted-foreground">
                        {card.game.networks()}
                      </span>
                      <PlaceBadge place={card.place} className="text-[10px]" />
                    </span>
                  </>
                )}
              </button>
            </li>
          ))}
      </ul>
    </>
  )
}
