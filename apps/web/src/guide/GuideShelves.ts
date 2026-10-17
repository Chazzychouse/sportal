import { GamesQuery } from "@sportal/api/GamesQuery"
import type { ListedGame } from "@sportal/api/ListedGame"
import type { Lineup } from "@sportal/domain/Guide"
import type { Highlight, HighlightId } from "@sportal/domain/Highlight"
import { LeagueId } from "@sportal/domain/League"
import { Atom } from "effect/reactivity"
import type { CustomStream } from "../custom/CustomStream.ts"
import type { GuideEntry, GuideLevel } from "../display/Display.ts"
import { GuideItem } from "./GuideItem.ts"

/**
 * What the guide shows: its entries, in the rail's order, and for an entry at a level its shelves, each a row of items
 * in order. The ribbon has one.
 */
export interface GuideShelves {
  readonly entries: ReadonlyArray<GuideEntry>
  readonly shelves: (entry: GuideEntry, level: GuideLevel) => ReadonlyArray<ReadonlyArray<GuideItem>>
}

/**
 * The guide over today's `games`, the saved `custom` streams, each league's Highlights shelf in `highlights`, and the
 * lineup's sports channels. Its entries: All live, then each league with a game today, in league order, then Channels,
 * then Custom. Its shelves, each in watch
 * order. All live: every league's live games, on one shelf at either level. A league: in the ribbon its live then
 * upcoming games; in the full guide three shelves, always, live now, later today, and final, then its Highlights shelf
 * when it has one. Under Custom, at either level, one shelf: the saved streams, then the card that adds one. Under Channels, at either level, one shelf: the
 * lineup's channels, in order.
 */
export function guideShelves(
  games: ReadonlyArray<ListedGame>,
  custom: ReadonlyArray<CustomStream>,
  highlights: ReadonlyMap<LeagueId, ReadonlyArray<GuideItem>> = new Map(),
  lineup: Lineup = []
): GuideShelves {
  const leagues = LeagueId.literals.filter((league) =>
    games.some(({ snapshot }) => snapshot.league === league)
  )
  return {
    entries: ["AllLive", ...leagues, "Channels", "Custom"],
    shelves: (entry, level) => {
      if (entry === "Channels") return [lineup.map((member) => GuideItem.Channel({ member }))]
      if (entry === "Custom")
        return [[...custom.map((stream) => GuideItem.Custom({ stream })), GuideItem.AddCustom()]]
      if (entry === "AllLive") return [items({ progress: ["live"] }, games)]
      const league = [entry]
      if (level === "Ribbon") return [items({ league, progress: ["live", "upcoming"] }, games)]
      const clips = highlights.get(entry) ?? []
      return [
        items({ league, progress: ["live"] }, games),
        items({ league, progress: ["upcoming"] }, games),
        items({ league, progress: ["over"] }, games),
        ...(clips.length > 0 ? [clips] : [])
      ]
    }
  }
}

/** A league's Highlights shelf: today's final games' clips, then yesterday's, each clip once. */
export function highlightShelf(
  today: ReadonlyArray<Highlight>,
  yesterday: ReadonlyArray<Highlight>
): ReadonlyArray<GuideItem> {
  const seen = new Set<HighlightId>()
  return [...today, ...yesterday].flatMap((highlight) => {
    if (seen.has(highlight.id)) return []
    seen.add(highlight.id)
    return [GuideItem.Clip({ highlight })]
  })
}

/** The leagues whose Highlights shelf has shown, so their highlights are asked for; the full guide adds to it. */
export const highlightsShown: Atom.Writable<ReadonlySet<LeagueId>> = Atom.make<ReadonlySet<LeagueId>>(
  new Set<LeagueId>()
).pipe(Atom.keepAlive)

/** Whether the Channels entry has shown, so the lineup is asked for; the guide sets it. */
export const channelsShown: Atom.Writable<boolean> = Atom.make(false).pipe(Atom.keepAlive)

function items(query: Omit<GamesQuery, "date">, games: ReadonlyArray<ListedGame>): ReadonlyArray<GuideItem> {
  return GamesQuery.answer(query, games).map(({ snapshot }) => GuideItem.Game({ game: snapshot.id }))
}
