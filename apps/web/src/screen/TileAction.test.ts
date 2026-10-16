import { assert, describe, it } from "@effect/vitest"
import { TileKey } from "@sportal/api/TileKey"
import type { GameId } from "@sportal/domain/Game"
import * as TestWeb from "../TestWeb.ts"
import { Screen } from "./Screen.ts"
import { TileAction } from "./TileAction.ts"

describe("TileAction.of", () => {
  it("should offer nothing for an empty tile", () => {
    const actions = TileAction.of(Screen.initial, 0, true)

    assert.deepStrictEqual(actions, [])
  })

  it("should offer hear, solo, and clear for the main tile, with no promote", () => {
    const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])

    const actions = TileAction.of(screen, 0, true)

    assert.deepStrictEqual(
      actions.map((action) => action.id),
      ["hear", "solo", "clear"]
    )
  })

  it("should offer promote for any other tile, sending it that tile", () => {
    const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])

    const promote = TileAction.of(screen, 1, true).find((action) => action.id === "promote")

    assert.deepStrictEqual(promote?.command, { _tag: "Promote", tile: 1 })
    assert.strictEqual(promote?.key, "Shift+2")
  })

  it("should swap solo for unsolo on the soloed tile", () => {
    const screen = TestWeb.soloed([TestWeb.bama, TestWeb.irish], 1)

    const actions = TileAction.of(screen, 1, true)

    assert.deepStrictEqual(
      actions.map((action) => action.id),
      ["hear", "promote", "unsolo", "clear"]
    )
    assert.deepStrictEqual(actions[2]?.command, { _tag: "Unsolo" })
  })

  it("should give solo its key on the selected tile", () => {
    const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])

    const key = actionOf(screen, 1, true, "solo")?.key

    assert.strictEqual(key, "F")
  })

  it("should give solo no key on a tile that is not selected", () => {
    const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])

    const key = actionOf(screen, 1, false, "solo")?.key

    assert.strictEqual(key, undefined)
  })

  it("should show unsolo's key on the soloed tile whether or not it is selected", () => {
    const screen = TestWeb.soloed([TestWeb.bama, TestWeb.irish], 1)

    const key = actionOf(screen, 1, false, "unsolo")?.key

    assert.strictEqual(key, "Escape")
  })

  it("should word hear by whether the tile's sound is already on", () => {
    const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])
    const wording = (game: GameId) => (screen.hears(TileKey.game(game)) ? "Sound on" : "Hear this game")

    const labels = [actionOf(screen, 0, true, "hear")?.label, actionOf(screen, 1, true, "hear")?.label]

    assert.deepStrictEqual(labels, [wording(TestWeb.bama), wording(TestWeb.irish)])
  })
})

describe("TileAction#shortcut", () => {
  it("should read a shifted digit with the shift sign", () => {
    const promote = actionOf(TestWeb.fill([TestWeb.bama, TestWeb.irish]), 1, true, "promote")

    const shortcut = promote?.shortcut()

    assert.strictEqual(shortcut, "⇧2")
  })

  it("should read Escape as Esc", () => {
    const unsolo = actionOf(TestWeb.soloed([TestWeb.bama, TestWeb.irish], 1), 1, true, "unsolo")

    const shortcut = unsolo?.shortcut()

    assert.strictEqual(shortcut, "Esc")
  })

  it("should have none for an action with no key", () => {
    const clear = actionOf(TestWeb.fill([TestWeb.bama]), 0, true, "clear")

    const shortcut = clear?.shortcut()

    assert.isUndefined(shortcut)
  })
})

function actionOf(screen: Screen, slot: number, selected: boolean, id: string) {
  return TileAction.of(screen, slot, selected).find((action) => action.id === id)
}
