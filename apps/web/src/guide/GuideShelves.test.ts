import { assert, describe, it } from "@effect/vitest"
import type { ListedGame } from "@sportal/api/ListedGame"
import { GameId, type GameStatus } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { snapshot } from "@sportal/domain/TestGame"
import { DateTime } from "effect"
import { GuideItem } from "./GuideItem.ts"
import * as GuideShelves from "./GuideShelves.ts"

describe("GuideShelves.guideShelves", () => {
  it("should list All live, then each league with games today in league order, and no league without", () => {
    const fbsFirst = [listed("osu", "fbs", "live"), listed("kc", "nfl", "final")]

    const shelves = GuideShelves.guideShelves(fbsFirst)

    assert.deepStrictEqual(shelves.entries, ["AllLive", "nfl", "fbs"])
  })

  it("should list only All live before there are games", () => {
    const shelves = GuideShelves.guideShelves([])

    assert.deepStrictEqual(shelves.entries, ["AllLive"])
  })

  it("should shelve every league's live games for All live in the ribbon, and nothing else", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves.shelves("AllLive", "Ribbon"), [[item("kc"), item("osu")]])
  })

  it("should shelve All live the same in the full guide", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves.shelves("AllLive", "Full"), [[item("kc"), item("osu")]])
  })

  it("should give a league's live then upcoming games in the ribbon, without its final ones", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves.shelves("nfl", "Ribbon"), [[item("kc"), item("gb"), item("sf")]])
  })

  it("should shelve a league's games as live now, later today and final in the full guide", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves.shelves("nfl", "Full"), [
      [item("kc")],
      [item("gb"), item("sf")],
      [item("nyj")]
    ])
  })

  it("should order upcoming games by their start", () => {
    const shelves = GuideShelves.guideShelves(today)

    const [, later] = shelves.shelves("nfl", "Full")

    assert.deepStrictEqual(later, [item("gb"), item("sf")])
  })

  it("should give a league with no games today empty shelves at either level", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves.shelves("nba", "Ribbon"), [[]])
    assert.deepStrictEqual(shelves.shelves("nba", "Full"), [[], [], []])
  })

  it("should give Custom one empty shelf for now", () => {
    const shelves = GuideShelves.guideShelves(today)

    assert.deepStrictEqual(shelves.shelves("Custom", "Full"), [[]])
  })
})

// Listed out of order on purpose: sf starts after gb.
const today: ReadonlyArray<ListedGame> = [
  listed("sf", "nfl", "scheduled", "2026-10-03T20:00:00Z"),
  listed("nyj", "nfl", "final"),
  listed("kc", "nfl", "live"),
  listed("gb", "nfl", "scheduled", "2026-10-03T17:00:00Z"),
  listed("osu", "fbs", "live")
]

function listed(
  id: string,
  league: LeagueId,
  status: GameStatus,
  startsAt = "2026-10-03T16:00:00Z"
): ListedGame {
  const at = DateTime.makeUnsafe(startsAt)
  return { snapshot: snapshot({ id: GameId.make(id), league, status, startsAt: at }), availability: [] }
}

function item(id: string): GuideItem {
  return GuideItem.Game({ game: GameId.make(id) })
}
