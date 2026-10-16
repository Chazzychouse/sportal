import { GamesQuery } from "@sportal/api/GamesQuery"
import type { ListedGame } from "@sportal/api/ListedGame"
import { LeagueId } from "@sportal/domain/League"
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
 * The guide over today's `games`. Its entries: All live, then each league with a game today, in league order. Its
 * shelves, each in watch order. All live: every league's live games, on one shelf at either level. A league: in the
 * ribbon its live then upcoming games; in the full guide three shelves, always, live now, later today, and final.
 * Custom has one empty shelf until there are custom streams.
 */
export function guideShelves(games: ReadonlyArray<ListedGame>): GuideShelves {
  const leagues = LeagueId.literals.filter((league) =>
    games.some(({ snapshot }) => snapshot.league === league)
  )
  return {
    entries: ["AllLive", ...leagues],
    shelves: (entry, level) => {
      if (entry === "Custom") return [[]]
      if (entry === "AllLive") return [items({ progress: ["live"] }, games)]
      const league = [entry]
      if (level === "Ribbon") return [items({ league, progress: ["live", "upcoming"] }, games)]
      return [
        items({ league, progress: ["live"] }, games),
        items({ league, progress: ["upcoming"] }, games),
        items({ league, progress: ["over"] }, games)
      ]
    }
  }
}

function items(query: Omit<GamesQuery, "date">, games: ReadonlyArray<ListedGame>): ReadonlyArray<GuideItem> {
  return GamesQuery.answer(query, games).map(({ snapshot }) => GuideItem.Game({ game: snapshot.id }))
}
