import { LayoutName } from "@sportal/domain/Layout"
import { Array as Arr } from "effect"
import { Shrink } from "lucide-react"
import { useState } from "react"
import { Toaster } from "@/design/sonner"
import { useDisplay } from "../display/DisplayView.tsx"
import { statusText } from "../game/GameStatus.tsx"
import { TeamLogo } from "../game/TeamLogo.tsx"
import { dispatch } from "../hub/HubClient.ts"
import { useLive } from "../hub/LiveStream.ts"
import { LayoutGlyph, layoutLabel } from "../layout/LayoutGlyph.tsx"
import { StripCard } from "../slate/StripCards.ts"
import { useRejectionToasts } from "../stage/Rejections.ts"
import { StageMap } from "./StageMap.tsx"

/**
 * The Remote: a phone's view of the Stage. The layout in miniature on top, the slate below in tabs; tapping a
 * game puts it in the selected tile and selects the next empty one.
 */
export function RemoteView() {
  const live = useLive()
  // The phone's own, like each desk's. Its inputs are taps, which React renders before the next one, so each
  // handler's `display` is current.
  const { display, run } = useDisplay()
  const [tab, setTab] = useState<StripCard["section"]>("Live")
  useRejectionToasts()

  const cards = StripCard.of(live.stage, live.slate)
  const shown = Arr.dedupe(cards.map((card) => card.section))
  // A tab with no games is hidden; if it was the open one, the first with games opens instead.
  const open = shown.includes(tab) ? tab : shown[0]

  return (
    <div className="min-h-dvh bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-background/95 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <header className="flex items-center gap-2">
          <span className="label-caps flex items-center gap-2 text-sm tracking-[0.22em]">
            <span className="size-2 rounded-full bg-on-air" />
            Sportal
          </span>
          <span
            className={`label-caps ml-1 flex items-center gap-1 text-[10px] ${live.connected ? "text-live" : "text-warn"}`}
          >
            <span
              className={`size-1.5 rounded-full ${live.connected ? "bg-live" : "animate-pulse bg-warn"}`}
            />
            {live.connected ? "Live" : "Reconnecting"}
          </span>
          {live.stage.solo !== undefined && (
            <button
              type="button"
              onClick={() => dispatch({ _tag: "Unsolo" })}
              className="label-caps ml-auto flex min-h-9 items-center gap-1 rounded-sm border px-2 text-[11px]"
            >
              <Shrink className="size-3.5" />
              Unsolo
            </button>
          )}
        </header>
        <fieldset className="flex justify-between" aria-label="Layout">
          {LayoutName.literals.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={live.stage.layout === name}
              aria-label={layoutLabel(name)}
              onClick={() => dispatch({ _tag: "SetLayout", layout: name })}
              className={`grid min-h-10 flex-1 place-items-center rounded-sm ${
                live.stage.layout === name ? "bg-accent text-on-air" : "text-muted-foreground"
              }`}
            >
              <LayoutGlyph name={name} />
            </button>
          ))}
        </fieldset>
        <StageMap
          stage={live.stage}
          slate={live.slate}
          selected={display.selectedOn(live.stage)}
          onSelect={(slot) => run(display.select(slot, live.stage))}
        />
      </div>

      <nav className="flex gap-1 px-3 pt-3" aria-label="Slate">
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
          .map((card) => {
            const { game, place } = card
            const dropped = display.drop(card, live.stage)
            const networks = game?.networks()
            const scored = game?.scored() === true
            return (
              <li key={card.id}>
                <button
                  type="button"
                  disabled={dropped.commands.length === 0}
                  onClick={() => run(dropped)}
                  className={`grid min-h-14 w-full grid-cols-[20px_1fr_2.5rem_7.5rem] items-center gap-x-2 rounded-sm px-1.5 py-1.5 text-left font-mono text-sm tabular-nums active:bg-accent disabled:opacity-60 ${
                    game?.progress() === "over" ? "opacity-70" : ""
                  }`}
                >
                  {game === undefined ? (
                    <span className="col-span-4 text-muted-foreground">Off the slate</span>
                  ) : (
                    [game.away, game.home].map((side, row) => {
                      const trailing = scored && side.score < (row === 0 ? game.home : game.away).score
                      return (
                        <span key={side.team.id} className="contents">
                          <TeamLogo team={side.team} size={20} />
                          <span
                            className={`truncate font-semibold ${trailing ? "text-muted-foreground" : ""}`}
                          >
                            {side.ranking !== undefined && (
                              <span className="mr-1 font-normal text-[10px] text-muted-foreground">
                                {side.ranking}
                              </span>
                            )}
                            {side.team.abbreviation}
                          </span>
                          <span className={`text-right ${trailing ? "text-muted-foreground" : ""}`}>
                            {scored ? side.score : ""}
                          </span>
                          {row === 0 ? (
                            <span
                              className={`label-caps text-right text-[11px] ${game.progress() === "live" ? "text-live" : "text-muted-foreground"}`}
                            >
                              {statusText(game)}
                            </span>
                          ) : (
                            <span className="flex items-center justify-end gap-1.5">
                              <span className="max-w-28 truncate font-sans text-[11px] text-muted-foreground">
                                {networks}
                              </span>
                              {place !== undefined && (
                                <span
                                  className={`label-caps rounded-sm border px-1 text-[10px] ${
                                    place._tag === "Slot"
                                      ? "border-on-air/50 text-on-air"
                                      : "text-muted-foreground"
                                  }`}
                                >
                                  {place._tag === "Slot" ? `T${place.slot + 1}` : "Bench"}
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                      )
                    })
                  )}
                </button>
              </li>
            )
          })}
      </ul>
      <Toaster position="bottom-center" />
    </div>
  )
}
