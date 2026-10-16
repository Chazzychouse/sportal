import { useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react"
import type { DisplayId } from "@sportal/api/DisplayId"
import type { ListedGame } from "@sportal/api/ListedGame"
import type { GameId, Progress } from "@sportal/domain/Game"
import { Array as Arr, Option } from "effect"
import { Shrink } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Toaster } from "@/design/sonner"
import { BrandMark, ConnectionPill } from "../display/Brand.tsx"
import { DisplayInput } from "../display/Display.ts"
import { GameStatus } from "../game/GameStatus.tsx"
import { Score } from "../game/Score.tsx"
import * as Games from "../hub/Games.ts"
import { LayoutPicker } from "../layout/LayoutPicker.tsx"
import { Screen } from "../screen/Screen.ts"
import * as RemoteState from "./RemoteState.ts"
import { Followed } from "./RemoteState.ts"
import { ScreenMap } from "./ScreenMap.tsx"

/**
 * The Remote: a phone's view of one Display. Its layout and tiles in miniature on top, then today's games in tabs;
 * tapping a game puts it in the selected tile and selects the next empty one.
 */
export function RemoteView(props: { id: DisplayId }) {
  const today = useAtomValue(Games.today)
  const games = Option.match(today.value, { onNone: () => [], onSome: ({ games }) => games })
  const followed = useAtomValue(RemoteState.followed(props.id))
  const display = useAtomValue(RemoteState.display(props.id))
  const input = useAtomSet(RemoteState.display(props.id))
  const send = useAtomSet(RemoteState.send(props.id))
  useAtomSubscribe(RemoteState.offline, (count) => {
    if (count > 0) toast.warning("The Display is offline")
  })

  return (
    <div className="min-h-dvh bg-background pb-[env(safe-area-inset-bottom)]">
      {Followed.$match(followed, {
        Connecting: () => <Waiting games={games} />,
        Offline: () => <Waiting games={games} />,
        Reported: ({ report }) => (
          <>
            <div className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-background/95 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
              <header className="flex flex-wrap items-center gap-2">
                <BrandMark />
                <ConnectionPill connection={today.connection} />
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
                games={games}
                selected={display.selectedOn(report.screen)}
                onSelect={(slot) => input(DisplayInput.Selected({ slot }))}
                onCommand={(command) => send({ _tag: "Commanded", command })}
              />
            </div>
            <GameTabs
              games={games}
              screen={report.screen}
              onChoose={(game) => input(DisplayInput.Chosen({ game }))}
            />
          </>
        )
      })}
      <Toaster position="bottom-center" />
    </div>
  )
}

/** While the Display is not reporting: say so, and keep today's games readable with nothing to tap. */
function Waiting(props: { games: ReadonlyArray<ListedGame> }) {
  return (
    <>
      <p className="px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-1 text-muted-foreground text-sm">
        Display offline, waiting…
      </p>
      <GameTabs games={props.games} screen={Screen.initial} onChoose={undefined} />
    </>
  )
}

/**
 * Today's games in tabs by progress, Live open first, or the first shown while the chosen one has none. A game on
 * screen shows its tile and cannot be tapped; any other row's tap chooses its game, or nothing without `onChoose`.
 */
function GameTabs(props: {
  games: ReadonlyArray<ListedGame>
  screen: Screen
  onChoose: ((game: GameId) => void) | undefined
}) {
  const { games, screen, onChoose } = props
  const [tab, setTab] = useState<Section>("Live")
  const shown = Arr.dedupe(games.map(({ snapshot }) => sections[snapshot.progress()]))
  const open = shown.includes(tab) ? tab : shown[0]
  return (
    <>
      <nav className="flex gap-1 px-3 pt-3" aria-label="Games">
        {shown.map((section) => (
          <button
            key={section}
            type="button"
            aria-pressed={open === section}
            onClick={() => setTab(section)}
            className={`label-caps min-h-9 flex-1 rounded-sm text-[11px] ${
              open === section ? "bg-accent text-foreground" : "text-muted-foreground"
            }`}
          >
            {section}{" "}
            <span className="font-mono">
              {games.filter(({ snapshot }) => sections[snapshot.progress()] === section).length}
            </span>
          </button>
        ))}
      </nav>
      {games.length === 0 && <p className="px-3 py-4 text-muted-foreground text-sm">No games today.</p>}
      <ul className="flex flex-col px-1.5 py-2">
        {games
          .filter(({ snapshot }) => sections[snapshot.progress()] === open)
          .map(({ snapshot }) => {
            const slot = screen.slotOf(snapshot.id)
            return (
              <li key={snapshot.id}>
                <button
                  type="button"
                  disabled={onChoose === undefined || slot !== undefined}
                  onClick={() => onChoose?.(snapshot.id)}
                  className={`grid min-h-14 w-full grid-cols-[20px_1fr_2.5rem_7.5rem] items-center gap-x-2 rounded-sm px-1.5 py-1.5 text-left font-mono text-sm tabular-nums active:bg-accent disabled:opacity-60 ${
                    snapshot.progress() === "over" ? "opacity-70" : ""
                  }`}
                >
                  <Score game={snapshot} side="away" />
                  <GameStatus game={snapshot} className="text-right text-[11px]" />
                  <Score game={snapshot} side="home" />
                  <span className="flex items-center justify-end gap-1.5">
                    <span className="max-w-28 truncate font-sans text-[11px] text-muted-foreground">
                      {snapshot.networks()}
                    </span>
                    {slot !== undefined && (
                      <span className="label-caps shrink-0 rounded-sm border border-on-air/50 px-1 text-[10px] text-on-air">
                        T{slot + 1}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
      </ul>
    </>
  )
}

/** A tab of the Remote's games. */
type Section = (typeof sections)[Progress]

const sections = { live: "Live", upcoming: "Next", over: "Final" } as const
