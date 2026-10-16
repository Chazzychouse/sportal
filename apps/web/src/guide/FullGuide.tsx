import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Display, DisplayInput, type GuideEntry, type GuideFocus } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { useOverlayRef } from "../display/OverlayRef.ts"
import { GameCard } from "../game/GameCard.tsx"
import * as Games from "../hub/Games.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { Shelf } from "../ui/Shelf.tsx"
import { GuideItem } from "./GuideItem.ts"
import { GuideRail } from "./GuideRail.tsx"

interface FullGuideProps {
  entry: GuideEntry
  focus: GuideFocus
}

/**
 * The guide's second level, over the whole Display: the rail at the left, and the entry's shelves at the right (live
 * now, later today, final for a league; live now for All live). It covers every video, which hides under it, and fades
 * in.
 */
export function FullGuide({ entry, focus }: FullGuideProps) {
  const ref = useOverlayRef()
  const input = useAtomSet(DisplayState.display)
  const display = useAtomValue(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const shelves = useAtomValue(DisplayState.shelves).shelves(entry, "Full")
  const games = useAtomValue(Games.byId)
  const titles = entry === "AllLive" ? ["Live now"] : shelfTitles
  const empty = shelves.every((shelf) => shelf.length === 0)

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Guide"
      className="fixed inset-0 z-40 grid animate-in grid-cols-[15rem_minmax(0,1fr)] bg-guide backdrop-blur-[var(--guide-blur)] duration-120 fade-in motion-reduce:animate-none"
    >
      <GuideRail entry={entry} focused={focus.rail} />
      <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-8 py-6">
        <header className="flex items-baseline gap-4">
          <h1 className="label-caps text-2xl">{Display.entryName(entry)}</h1>
          <span className="label-caps text-[11px] text-muted-foreground">
            Puts the pick in tile {display.selectedOn(screen) + 1}
          </span>
          <span className="label-caps ml-auto font-mono text-[11px] text-muted-foreground">Esc · back</span>
        </header>
        {empty ? (
          <p className="m-auto text-lg text-muted-foreground">
            {entry === "AllLive" ? "Nothing live right now" : `No ${Display.entryName(entry)} games today`}
          </p>
        ) : (
          shelves.map((shelf, index) =>
            shelf.length === 0 ? null : (
              <Shelf
                key={titles[index] ?? index}
                title={titles[index]}
                live={index === 0}
                focus={!focus.rail && focus.shelf === index ? focus.item : undefined}
              >
                {shelf.map((item, at) =>
                  GuideItem.$match(item, {
                    Game: ({ game }) => {
                      const listed = games.get(game)
                      return listed === undefined ? null : (
                        <GameCard
                          key={game}
                          game={listed.snapshot}
                          focused={!focus.rail && focus.shelf === index && focus.item === at}
                          onChoose={() => input(DisplayInput.GuideItemChosen({ shelf: index, item: at }))}
                        />
                      )
                    }
                  })
                )}
              </Shelf>
            )
          )
        )}
      </div>
    </div>
  )
}

/** A league's shelves' titles, in `guideShelves`' order. Phase 7 appends "Highlights". */
const shelfTitles = ["Live now", "Later today", "Final"]
