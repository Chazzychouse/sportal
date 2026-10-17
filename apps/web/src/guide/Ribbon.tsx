import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { TileKey } from "@sportal/api/TileKey"
import { ChevronUp } from "lucide-react"
import { useEffect } from "react"
import { Button } from "@/design/button"
import { cn } from "@/design/ClassName"
import { AddCustomCard, CustomCard } from "../custom/CustomCard.tsx"
import { CustomStreamsChange } from "../custom/CustomStreams.ts"
import { Display, DisplayInput, type GuideEntry, type GuideFocus } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { GameChip } from "../game/GameChip.tsx"
import * as Games from "../hub/Games.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { Shelf } from "../ui/Shelf.tsx"
import { ChannelCard } from "./ChannelCard.tsx"
import { GuideItem } from "./GuideItem.ts"
import * as GuideShelves from "./GuideShelves.ts"

interface RibbonProps {
  entry: GuideEntry
  focus: GuideFocus
}

/**
 * The guide's first level, docked under the Screen: the entries as tabs, which tile a pick goes to, and one row of the
 * entry's live then upcoming games (under Custom, the saved streams and the card that adds one). It slides up as it
 * opens.
 */
export function Ribbon({ entry, focus }: RibbonProps) {
  const input = useAtomSet(DisplayState.display)
  const edit = useAtomSet(DisplayState.editCustom)
  const display = useAtomValue(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const shelves = useAtomValue(DisplayState.shelves)
  const games = useAtomValue(Games.byId)
  const [row = []] = shelves.shelves(entry, "Ribbon")
  const showChannels = useAtomSet(GuideShelves.channelsShown)
  useEffect(() => {
    if (entry === "Channels") showChannels(true)
  }, [entry, showChannels])

  return (
    <section
      aria-label="Guide"
      className="flex min-h-0 animate-in flex-col gap-2 border-t bg-guide px-4 pt-2.5 pb-3 backdrop-blur-[var(--guide-blur)] duration-150 slide-in-from-bottom motion-reduce:animate-none"
    >
      <div className="flex items-center gap-1">
        {shelves.entries.map((each) => (
          <button
            key={each}
            type="button"
            tabIndex={-1}
            onClick={() => input(DisplayInput.GuideEntryChosen({ entry: each }))}
            className={cn(
              "label-caps rounded-sm px-2.5 py-1 text-xs",
              each === entry ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {Display.entryName(each)}
          </button>
        ))}
        <span className="label-caps ml-auto text-[11px] text-muted-foreground">
          Puts the pick in tile {display.selectedOn(screen) + 1}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="label-caps text-[11px] text-muted-foreground"
          aria-keyshortcuts="G"
          onClick={() => input(DisplayInput.GuideOpened({ entry }))}
        >
          <ChevronUp />
          Full guide
        </Button>
      </div>
      {row.length === 0 ? (
        <p className="m-auto text-muted-foreground text-sm">
          {entry === "AllLive"
            ? "Nothing live right now"
            : entry === "Channels"
              ? "No sports channels: no fresh guide"
              : `Nothing live or later in ${Display.entryName(entry)} today`}
        </p>
      ) : (
        <Shelf focus={focus.item}>
          {row.map((item, index) => {
            const focused = focus.item === index
            const choose = () => input(DisplayInput.GuideItemChosen({ shelf: 0, item: index }))
            return GuideItem.$match(item, {
              Game: ({ game }) => {
                const listed = games.get(game)
                return listed === undefined ? null : (
                  <GameChip key={game} game={listed.snapshot} focused={focused} onChoose={choose} />
                )
              },
              // Highlights are only ever on the full guide's shelves.
              Clip: () => null,
              Custom: ({ stream }) => (
                <CustomCard
                  key={stream.id}
                  stream={stream}
                  focused={focused}
                  compact={true}
                  onChoose={choose}
                  onRemove={() => edit(CustomStreamsChange.Removed({ id: stream.id }))}
                />
              ),
              Channel: ({ member }) => (
                <ChannelCard
                  key={TileKey.channel(member.channel)}
                  member={member}
                  focused={focused}
                  compact={true}
                  onChoose={choose}
                />
              ),
              AddCustom: () => <AddCustomCard key="add" focused={focused} compact={true} onChoose={choose} />
            })
          })}
        </Shelf>
      )}
    </section>
  )
}
