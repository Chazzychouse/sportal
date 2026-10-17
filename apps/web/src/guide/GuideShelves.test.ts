import { assert, describe, it } from "@effect/vitest"
import type { ListedGame } from "@sportal/api/ListedGame"
import { GameId, type GameStatus } from "@sportal/domain/Game"
import { HighlightId } from "@sportal/domain/Highlight"
import type { LeagueId } from "@sportal/domain/League"
import { highlight, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Option } from "effect"
import * as TestWeb from "../TestWeb.ts"
import { GuideItem } from "./GuideItem.ts"
import * as GuideShelves from "./GuideShelves.ts"

describe("GuideShelves.guideShelves Channels", () => {
  const member = (name: string) => ({
    channel: {
      name,
      source: "YouTube TV" as const,
      locator: { _tag: "WebView" as const, url: `https://example.test/${name}` }
    },
    now: Option.none(),
    next: Option.none()
  })

  it("should give one channel item per lineup member, in order, in the full guide", () => {
    const lineup = [member("ESPN"), member("FS1")]

    const shelves = GuideShelves.guideShelves([], [], new Map(), lineup)

    assert.deepStrictEqual(shelves.shelves("Channels", "Full"), [
      lineup.map((each) => GuideItem.Channel({ member: each }))
    ])
  })

  it("should give the same channel items in the ribbon", () => {
    const lineup = [member("ESPN")]

    const shelves = GuideShelves.guideShelves([], [], new Map(), lineup)

    assert.deepStrictEqual(shelves.shelves("Channels", "Ribbon"), [
      lineup.map((each) => GuideItem.Channel({ member: each }))
    ])
  })
})

describe("GuideShelves.guideShelves", () => {
  it("should list All live, then each league with games today in league order, no league without, then Channels, then Custom", () => {
    const fbsFirst = [listed("osu", "fbs", "live"), listed("kc", "nfl", "final")]

    const shelves = GuideShelves.guideShelves(fbsFirst, [])

    assert.deepStrictEqual(shelves.entries, ["AllLive", "nfl", "fbs", "Channels", "Custom"])
  })

  it("should list only All live, Channels and Custom before there are games", () => {
    const shelves = GuideShelves.guideShelves([], [])

    assert.deepStrictEqual(shelves.entries, ["AllLive", "Channels", "Custom"])
  })

  it("should shelve every league's live games for All live in the ribbon, and nothing else", () => {
    const shelves = GuideShelves.guideShelves(today, [])

    assert.deepStrictEqual(shelves.shelves("AllLive", "Ribbon"), [[item("kc"), item("osu")]])
  })

  it("should shelve All live the same in the full guide", () => {
    const shelves = GuideShelves.guideShelves(today, [])

    assert.deepStrictEqual(shelves.shelves("AllLive", "Full"), [[item("kc"), item("osu")]])
  })

  it("should give a league's live then upcoming games in the ribbon, without its final ones", () => {
    const shelves = GuideShelves.guideShelves(today, [])

    assert.deepStrictEqual(shelves.shelves("nfl", "Ribbon"), [[item("kc"), item("gb"), item("sf")]])
  })

  it("should shelve a league's games as live now, later today and final in the full guide", () => {
    const shelves = GuideShelves.guideShelves(today, [])

    assert.deepStrictEqual(shelves.shelves("nfl", "Full"), [
      [item("kc")],
      [item("gb"), item("sf")],
      [item("nyj")]
    ])
  })

  it("should order upcoming games by their start", () => {
    const shelves = GuideShelves.guideShelves(today, [])

    const [, later] = shelves.shelves("nfl", "Full")

    assert.deepStrictEqual(later, [item("gb"), item("sf")])
  })

  it("should give a league with no games today empty shelves at either level", () => {
    const shelves = GuideShelves.guideShelves(today, [])

    assert.deepStrictEqual(shelves.shelves("nba", "Ribbon"), [[]])
    assert.deepStrictEqual(shelves.shelves("nba", "Full"), [[], [], []])
  })
})

describe("GuideShelves.highlightShelf", () => {
  it("should list today's highlights before yesterday's", () => {
    const today = highlight({ id: HighlightId.make("today") })
    const yesterday = highlight({ id: HighlightId.make("yesterday") })

    const shelf = GuideShelves.highlightShelf([today], [yesterday])

    assert.deepStrictEqual(shelf, [
      GuideItem.Clip({ highlight: today }),
      GuideItem.Clip({ highlight: yesterday })
    ])
  })

  it("should list a highlight both days have once, as today's", () => {
    const both = highlight({ id: HighlightId.make("both") })

    const shelf = GuideShelves.highlightShelf([both], [both])

    assert.deepStrictEqual(shelf, [GuideItem.Clip({ highlight: both })])
  })
})

describe("GuideShelves.guideShelves highlights", () => {
  it("should put a league's highlights last in its full guide", () => {
    const clips = [GuideItem.Clip({ highlight: highlight() })]

    const shelves = GuideShelves.guideShelves(TestWeb.todayList.games, [], new Map([["fbs", clips]]))

    assert.deepStrictEqual(shelves.shelves("fbs", "Full").at(-1), clips)
  })

  it("should leave highlights out of the ribbon", () => {
    const clips = [GuideItem.Clip({ highlight: highlight() })]

    const shelves = GuideShelves.guideShelves(TestWeb.todayList.games, [], new Map([["fbs", clips]]))

    assert.notDeepInclude(shelves.shelves("fbs", "Ribbon"), clips)
  })
})

describe("GuideShelves.guideShelves Custom", () => {
  it("should list the saved streams in order, then the add card", () => {
    const shelves = GuideShelves.guideShelves([], [TestWeb.video, TestWeb.playlist])

    const custom = shelves.shelves("Custom", "Full")

    assert.deepStrictEqual(custom, [
      [
        GuideItem.Custom({ stream: TestWeb.video }),
        GuideItem.Custom({ stream: TestWeb.playlist }),
        GuideItem.AddCustom()
      ]
    ])
  })

  it("should list only the add card while no stream is saved", () => {
    const shelves = GuideShelves.guideShelves([], [])

    const custom = shelves.shelves("Custom", "Ribbon")

    assert.deepStrictEqual(custom, [[GuideItem.AddCustom()]])
  })

  it("should keep the saved streams out of every league's shelves", () => {
    const shelves = GuideShelves.guideShelves(today, [TestWeb.video])

    const nfl = shelves.shelves("nfl", "Full")

    assert.isFalse(nfl.flat().some(GuideItem.$is("Custom")))
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
