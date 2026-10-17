import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { useEffect } from "react"
import { AddCustomCard, CustomCard } from "../custom/CustomCard.tsx"
import { CustomStreamsChange } from "../custom/CustomStreams.ts"
import { Display, DisplayInput, type GuideEntry, type GuideFocus } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { useOverlayRef } from "../display/OverlayRef.ts"
import { GameCard } from "../game/GameCard.tsx"
import * as Games from "../hub/Games.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { HighlightCard } from "../stats/HighlightCard.tsx"
import { Shelf } from "../ui/Shelf.tsx"
import { ChannelCard } from "./ChannelCard.tsx"
import { GuideItem } from "./GuideItem.ts"
import { GuideRail } from "./GuideRail.tsx"
import * as GuideShelves from "./GuideShelves.ts"

interface FullGuideProps {
  entry: GuideEntry
  focus: GuideFocus
}

/**
 * The guide's second level, over the whole Display: the rail at the left, and the entry's shelves at the right (live
 * now, later today, final, then highlights for a league; live now for All live; On now for Channels; YouTube for Custom, the saved streams
 * and the card that adds one). A league's highlights are asked for once its guide shows. It covers every video, which
 * hides under it, and fades in.
 */
export function FullGuide({ entry, focus }: FullGuideProps) {
  const ref = useOverlayRef()
  const input = useAtomSet(DisplayState.display)
  const edit = useAtomSet(DisplayState.editCustom)
  const display = useAtomValue(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const shelves = useAtomValue(DisplayState.shelves).shelves(entry, "Full")
  const games = useAtomValue(Games.byId)
  const titles =
    entry === "AllLive"
      ? ["Live now"]
      : entry === "Channels"
        ? ["On now"]
        : entry === "Custom"
          ? ["YouTube"]
          : shelfTitles
  const empty = shelves.every((shelf) => shelf.length === 0)
  const showHighlights = useAtomSet(GuideShelves.highlightsShown)
  useEffect(() => {
    if (entry === "AllLive" || entry === "Channels" || entry === "Custom") return
    showHighlights((shown) => (shown.has(entry) ? shown : new Set([...shown, entry])))
  }, [entry, showHighlights])
  const showChannels = useAtomSet(GuideShelves.channelsShown)
  useEffect(() => {
    if (entry === "Channels") showChannels(true)
  }, [entry, showChannels])

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
            {entry === "AllLive"
              ? "Nothing live right now"
              : entry === "Channels"
                ? "No sports channels: the guide has not been read yet"
                : `No ${Display.entryName(entry)} games today`}
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
                {shelf.map((item, at) => {
                  const focused = !focus.rail && focus.shelf === index && focus.item === at
                  const choose = () => input(DisplayInput.GuideItemChosen({ shelf: index, item: at }))
                  return GuideItem.$match(item, {
                    Game: ({ game }) => {
                      const listed = games.get(game)
                      return listed === undefined ? null : (
                        <GameCard key={game} game={listed.snapshot} focused={focused} onChoose={choose} />
                      )
                    },
                    Clip: ({ highlight }) => (
                      <HighlightCard
                        key={highlight.id}
                        highlight={highlight}
                        focused={focused}
                        onChoose={choose}
                      />
                    ),
                    Custom: ({ stream }) => (
                      <CustomCard
                        key={stream.id}
                        stream={stream}
                        focused={focused}
                        compact={false}
                        onChoose={choose}
                        onRemove={() => edit(CustomStreamsChange.Removed({ id: stream.id }))}
                      />
                    ),
                    Channel: ({ member }) => (
                      <ChannelCard
                        key={member.channel.name}
                        member={member}
                        focused={focused}
                        compact={false}
                        onChoose={choose}
                      />
                    ),
                    AddCustom: () => (
                      <AddCustomCard key="add" focused={focused} compact={false} onChoose={choose} />
                    )
                  })
                })}
              </Shelf>
            )
          )
        )}
      </div>
    </div>
  )
}

/** A league's shelves' titles, in `guideShelves`' order. */
const shelfTitles = ["Live now", "Later today", "Final", "Highlights"]
