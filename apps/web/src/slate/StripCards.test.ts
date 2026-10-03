import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { snapshot } from "@sportal/domain/TestGame"
import { DateTime } from "effect"
import { dropCommand, nextPick, stripCards } from "./StripCards.ts"

const live = snapshot({ id: GameId.make("live"), status: "live" })
const later = snapshot({
  id: GameId.make("later"),
  kickoff: DateTime.makeUnsafe("2026-10-03T20:00:00Z")
})
const soon = snapshot({ id: GameId.make("soon") })
const done = snapshot({ id: GameId.make("done"), status: "final" })
const slate = [done, later, live, soon]

describe("stripCards", () => {
  it("orders the slate live, upcoming by kickoff, then over", () => {
    assert.deepStrictEqual(ids(stripCards(Stage.initial, slate)), ["live", "soon", "later", "done"])
  })

  it("puts benched games first, once, with their tile, and marks games on stage with their slot", () => {
    const stage = withTiles(["soon", undefined, undefined, undefined, "done"])
    const cards = stripCards(stage, slate)
    assert.deepStrictEqual(ids(cards), ["done", "live", "soon", "later"])
    assert.deepStrictEqual(cards[0]?.place, { _tag: "Bench", tile: 4 })
    assert.deepStrictEqual(cards[2]?.place, { _tag: "Slot", slot: 0 })
    assert.isUndefined(cards[1]?.place)
  })

  it("keeps a benched game that left the slate, with no snapshot", () => {
    const stage = withTiles([undefined, undefined, undefined, undefined, "gone"])
    const [first] = stripCards(stage, slate)
    assert.strictEqual(first?.id, "gone")
    assert.isUndefined(first?.game)
  })
})

describe("nextPick", () => {
  it("starts on the first live game nobody is watching, whichever way it steps", () => {
    const cards = stripCards(withTiles([undefined, undefined, undefined, undefined, "done"]), slate)
    assert.strictEqual(nextPick(cards, undefined, 1), "live")
    assert.strictEqual(nextPick(cards, undefined, -1), "live")
  })

  it("starts on the first pickable card when nothing is live and free", () => {
    const cards = stripCards(withTiles(["live"]), slate)
    assert.strictEqual(nextPick(cards, undefined, 1), "soon")
  })

  it("steps over games on stage, onto bench cards, and wraps", () => {
    const cards = stripCards(withTiles(["soon", undefined, undefined, undefined, "done"]), slate)
    // Cards: done (bench), live, soon (T1), later.
    assert.strictEqual(nextPick(cards, GameId.make("live"), 1), "later")
    assert.strictEqual(nextPick(cards, GameId.make("later"), 1), "done")
    assert.strictEqual(nextPick(cards, GameId.make("done"), -1), "later")
  })

  it("steps on from a pick that was just placed", () => {
    const cards = stripCards(withTiles(["live"]), slate)
    assert.strictEqual(nextPick(cards, GameId.make("live"), 1), "soon")
  })

  it("starts over when the pick has left the strip, and has nothing when nothing is pickable", () => {
    assert.strictEqual(nextPick(stripCards(Stage.initial, slate), GameId.make("gone"), 1), "live")
    assert.isUndefined(
      nextPick(stripCards(withTiles(["live", "soon", "later", "done"]), slate), undefined, 1)
    )
  })
})

describe("dropCommand", () => {
  it("assigns a free game, swaps a benched one in, and does nothing with a game on stage", () => {
    const [bench, free, onStage] = stripCards(
      withTiles(["soon", undefined, undefined, undefined, "done"]),
      slate
    )
    assert.deepStrictEqual(free && dropCommand(free, 2), {
      _tag: "Assign",
      tile: 2,
      game: GameId.make("live")
    })
    assert.deepStrictEqual(bench && dropCommand(bench, 2), { _tag: "Swap", a: 4, b: 2 })
    assert.isUndefined(onStage && dropCommand(onStage, 2))
  })
})

function ids(cards: ReturnType<typeof stripCards>) {
  return cards.map((card) => card.id)
}

/** A Quad with these games in its tiles, in order; past the fourth they are benched. */
function withTiles(games: ReadonlyArray<string | undefined>) {
  const tiles = games.map((game) =>
    game === undefined
      ? { _tag: "Empty" as const }
      : { _tag: "DataTile" as const, game: GameId.make(game), why: { _tag: "NoStream" as const } }
  )
  return new Stage({ ...Stage.initial, tiles: [...tiles, ...Stage.initial.tiles.slice(tiles.length)] })
}
