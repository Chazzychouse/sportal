import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { StripCard } from "./StripCards.ts"
import { slate } from "./TestSlate.ts"

describe("StripCard.of", () => {
  it("orders the slate live, upcoming by kickoff, then over", () => {
    assert.deepStrictEqual(ids(StripCard.of(Stage.initial, slate)), ["live", "soon", "later", "done"])
  })

  it("puts benched games first, once, with their tile, and marks games on stage with their slot", () => {
    const stage = withTiles(["soon", undefined, undefined, undefined, "done"])
    const cards = StripCard.of(stage, slate)
    assert.deepStrictEqual(ids(cards), ["done", "live", "soon", "later"])
    assert.deepStrictEqual(cards[0]?.place, { _tag: "Bench", tile: 4 })
    assert.deepStrictEqual(cards[2]?.place, { _tag: "Slot", slot: 0 })
    assert.isUndefined(cards[1]?.place)
    assert.deepStrictEqual(
      cards.map((card) => card.section),
      ["Bench", "Live", "Next", "Next"]
    )
  })

  it("keeps a benched game that left the slate, with no snapshot", () => {
    const stage = withTiles([undefined, undefined, undefined, undefined, "gone"])
    const [first] = StripCard.of(stage, slate)
    assert.strictEqual(first?.id, "gone")
    assert.isUndefined(first?.game)
  })
})

describe("StripCard.pickable", () => {
  it("is true for a free game and a benched one, false for a game on stage", () => {
    const cards = StripCard.of(withTiles(["soon", undefined, undefined, undefined, "done"]), slate)
    assert.deepStrictEqual(
      cards.map((card) => card.pickable()),
      [true, true, false, true]
    )
  })

  it("is a StripCard with value equality", () => {
    const [card] = StripCard.of(Stage.initial, slate)
    assert.instanceOf(card, StripCard)
    assert.deepStrictEqual(StripCard.of(Stage.initial, slate)[0], card)
  })
})

describe("StripCard.nextPick", () => {
  it("starts on the first live game nobody is watching, whichever way it steps", () => {
    const cards = StripCard.of(withTiles([undefined, undefined, undefined, undefined, "done"]), slate)
    assert.strictEqual(StripCard.nextPick(cards, undefined, 1), "live")
    assert.strictEqual(StripCard.nextPick(cards, undefined, -1), "live")
  })

  it("starts on the first pickable card when nothing is live and free", () => {
    const cards = StripCard.of(withTiles(["live"]), slate)
    assert.strictEqual(StripCard.nextPick(cards, undefined, 1), "soon")
  })

  it("steps over games on stage, onto bench cards, and wraps", () => {
    const cards = StripCard.of(withTiles(["soon", undefined, undefined, undefined, "done"]), slate)
    // Cards: done (bench), live, soon (T1), later.
    assert.strictEqual(StripCard.nextPick(cards, GameId.make("live"), 1), "later")
    assert.strictEqual(StripCard.nextPick(cards, GameId.make("later"), 1), "done")
    assert.strictEqual(StripCard.nextPick(cards, GameId.make("done"), -1), "later")
  })

  it("steps on from a pick that was just placed", () => {
    const cards = StripCard.of(withTiles(["live"]), slate)
    assert.strictEqual(StripCard.nextPick(cards, GameId.make("live"), 1), "soon")
  })

  it("starts over when the pick has left the strip, and has nothing when nothing is pickable", () => {
    assert.strictEqual(StripCard.nextPick(StripCard.of(Stage.initial, slate), GameId.make("gone"), 1), "live")
    assert.isUndefined(
      StripCard.nextPick(StripCard.of(withTiles(["live", "soon", "later", "done"]), slate), undefined, 1)
    )
  })
})

function ids(cards: ReadonlyArray<StripCard>) {
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
