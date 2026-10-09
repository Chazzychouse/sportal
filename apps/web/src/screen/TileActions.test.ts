import { assert, describe, it } from "@effect/vitest"
import type { GameId } from "@sportal/domain/Game"
import { Screen } from "./Screen.ts"
import { bama, fill, irish, soloed } from "./TestScreen.ts"
import { tileActions } from "./TileActions.tsx"

describe("tileActions", () => {
  it("should offer nothing for an empty tile", () => {
    const actions = tileActions(Screen.initial, 0, true)

    assert.deepStrictEqual(actions, [])
  })

  it("should offer hear, solo, and clear for the main tile, with no promote", () => {
    const screen = fill([bama, irish])

    const actions = tileActions(screen, 0, true)

    assert.deepStrictEqual(
      actions.map((action) => action.id),
      ["hear", "solo", "clear"]
    )
  })

  it("should offer promote for any other tile, sending it that tile", () => {
    const screen = fill([bama, irish])

    const promote = tileActions(screen, 1, true).find((action) => action.id === "promote")

    assert.deepStrictEqual(promote?.command, { _tag: "Promote", tile: 1 })
    assert.strictEqual(promote?.key, "Shift+2")
  })

  it("should swap solo for unsolo on the soloed tile", () => {
    const screen = soloed([bama, irish], 1)

    const actions = tileActions(screen, 1, true)

    assert.deepStrictEqual(
      actions.map((action) => action.id),
      ["hear", "promote", "unsolo", "clear"]
    )
    assert.deepStrictEqual(actions[2]?.command, { _tag: "Unsolo" })
  })

  it("should give solo its key on the selected tile", () => {
    const screen = fill([bama, irish])

    const key = actionOf(screen, 1, true, "solo")?.key

    assert.strictEqual(key, "F")
  })

  it("should give solo no key on a tile that is not selected", () => {
    const screen = fill([bama, irish])

    const key = actionOf(screen, 1, false, "solo")?.key

    assert.strictEqual(key, undefined)
  })

  it("should show unsolo's key on the soloed tile whether or not it is selected", () => {
    const screen = soloed([bama, irish], 1)

    const key = actionOf(screen, 1, false, "unsolo")?.key

    assert.strictEqual(key, "Escape")
  })

  it("should word hear by whether the tile's sound is already on", () => {
    const screen = fill([bama, irish])
    const wording = (game: GameId) => (screen.hears(game) ? "Sound on" : "Hear this game")

    const labels = [actionOf(screen, 0, true, "hear")?.label, actionOf(screen, 1, true, "hear")?.label]

    assert.deepStrictEqual(labels, [wording(bama), wording(irish)])
  })
})

function actionOf(screen: Screen, slot: number, selected: boolean, id: string) {
  return tileActions(screen, slot, selected).find((action) => action.id === id)
}
