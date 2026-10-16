import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Screen } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import { StripCard } from "./StripCard.ts"

describe("StripCard.of", () => {
  it("should order the slate live, upcoming by kickoff, then over", () => {
    const cards = StripCard.of(Screen.initial, TestWeb.slate)

    assert.deepStrictEqual(ids(cards), ["live", "soon", "later", "done"])
  })

  it("should put benched games first, once, with their tile, marking games on screen with their slot", () => {
    const screen = TestWeb.withTiles(["soon", undefined, undefined, undefined, "done"])

    const cards = StripCard.of(screen, TestWeb.slate)

    assert.deepStrictEqual(ids(cards), ["done", "live", "soon", "later"])
    assert.deepStrictEqual(cards[0]?.place, { _tag: "Bench", tile: 4 })
    assert.deepStrictEqual(cards[2]?.place, { _tag: "Slot", slot: 0 })
    assert.isUndefined(cards[1]?.place)
    assert.deepStrictEqual(
      cards.map((card) => card.section),
      ["Bench", "Live", "Next", "Next"]
    )
  })

  it("should keep a benched game that left the slate, with no snapshot", () => {
    const screen = TestWeb.withTiles([undefined, undefined, undefined, undefined, "gone"])

    const [first] = StripCard.of(screen, TestWeb.slate)

    assert.strictEqual(first?.id, "gone")
    assert.isUndefined(first?.game)
  })

  it("should make StripCards", () => {
    const [card] = StripCard.of(Screen.initial, TestWeb.slate)

    assert.instanceOf(card, StripCard)
  })

  it("should make cards equal by value to the same cards made again", () => {
    const [card] = StripCard.of(Screen.initial, TestWeb.slate)

    const [again] = StripCard.of(Screen.initial, TestWeb.slate)

    assert.deepStrictEqual(again, card)
  })
})

describe("StripCard#pickable", () => {
  it("should be true for a free game and a benched one, false for a game on screen", () => {
    const cards = StripCard.of(
      TestWeb.withTiles(["soon", undefined, undefined, undefined, "done"]),
      TestWeb.slate
    )

    const pickable = cards.map((card) => card.pickable())

    assert.deepStrictEqual(pickable, [true, true, false, true])
  })
})

describe("StripCard.nextPick", () => {
  it.each([1, -1] as const)("should start on the first live game nobody is watching, stepping %d", (step) => {
    const cards = StripCard.of(
      TestWeb.withTiles([undefined, undefined, undefined, undefined, "done"]),
      TestWeb.slate
    )

    const pick = StripCard.nextPick(cards, undefined, step)

    assert.strictEqual(pick, "live")
  })

  it("should start on the first pickable card when nothing is live and free", () => {
    const cards = StripCard.of(TestWeb.withTiles(["live"]), TestWeb.slate)

    const pick = StripCard.nextPick(cards, undefined, 1)

    assert.strictEqual(pick, "soon")
  })

  it("should step over a game on screen", () => {
    const cards = benchedAndOnScreen()

    const pick = StripCard.nextPick(cards, GameId.make("live"), 1)

    assert.strictEqual(pick, "later")
  })

  it("should wrap from the last card onto a bench card", () => {
    const cards = benchedAndOnScreen()

    const pick = StripCard.nextPick(cards, GameId.make("later"), 1)

    assert.strictEqual(pick, "done")
  })

  it("should wrap back from the first card to the last", () => {
    const cards = benchedAndOnScreen()

    const pick = StripCard.nextPick(cards, GameId.make("done"), -1)

    assert.strictEqual(pick, "later")
  })

  it("should step on from a pick that was just placed", () => {
    const cards = StripCard.of(TestWeb.withTiles(["live"]), TestWeb.slate)

    const pick = StripCard.nextPick(cards, GameId.make("live"), 1)

    assert.strictEqual(pick, "soon")
  })

  it("should start over when the pick has left the strip", () => {
    const cards = StripCard.of(Screen.initial, TestWeb.slate)

    const pick = StripCard.nextPick(cards, GameId.make("gone"), 1)

    assert.strictEqual(pick, "live")
  })

  it("should have no pick when nothing is pickable", () => {
    const cards = StripCard.of(TestWeb.withTiles(["live", "soon", "later", "done"]), TestWeb.slate)

    const pick = StripCard.nextPick(cards, undefined, 1)

    assert.isUndefined(pick)
  })
})

function ids(cards: ReadonlyArray<StripCard>) {
  return cards.map((card) => card.id)
}

/** The cards done (bench), live, soon (on tile 0), later. */
function benchedAndOnScreen() {
  return StripCard.of(TestWeb.withTiles(["soon", undefined, undefined, undefined, "done"]), TestWeb.slate)
}
