import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { Option, Result } from "effect"
import { tileActions } from "./TileActions.tsx"

const bama = GameId.make("401856707")
const irish = GameId.make("401858250")
const fox = {
  name: "FOX",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" }
}

describe("tileActions", () => {
  it("offers nothing for an empty tile", () => {
    assert.deepStrictEqual(tileActions(Stage.initial, 0, true), [])
  })

  it("offers hear, solo, and clear for the main tile, with no promote", () => {
    assert.deepStrictEqual(
      tileActions(streaming(), 0, true).map((action) => action.id),
      ["hear", "solo", "clear"]
    )
  })

  it("offers promote for any other tile, and sends it that tile", () => {
    const promote = tileActions(streaming(), 1, true).find((action) => action.id === "promote")
    assert.deepStrictEqual(promote?.command, { _tag: "Promote", tile: 1 })
    assert.strictEqual(promote?.key, "Shift+2")
  })

  it("swaps solo for unsolo on the soloed tile", () => {
    const stage = Result.getOrThrow(streaming().apply({ _tag: "Solo", tile: 1 }, none))
    const actions = tileActions(stage, 1, true)
    assert.deepStrictEqual(
      actions.map((action) => action.id),
      ["hear", "promote", "unsolo", "clear"]
    )
    assert.deepStrictEqual(actions[2]?.command, { _tag: "Unsolo" })
  })

  it("gives solo its key only on the selected tile", () => {
    const soloKey = (slot: number, selected: boolean) =>
      tileActions(streaming(), slot, selected).find((action) => action.id === "solo")?.key
    assert.strictEqual(soloKey(1, true), "F")
    assert.strictEqual(soloKey(1, false), undefined)
  })

  it("words hear by whether the tile's sound is already on", () => {
    const stage = streaming()
    const labels = (slot: number) =>
      tileActions(stage, slot, true).find((action) => action.id === "hear")?.label
    assert.deepStrictEqual(
      [labels(0), labels(1)],
      [stage.hears(bama) ? "Sound on" : "Hear this game", stage.hears(irish) ? "Sound on" : "Hear this game"]
    )
  })
})

function streaming() {
  const one = Result.getOrThrow(Stage.initial.apply({ _tag: "Assign", tile: 0, game: bama }, carriedOnFox))
  return Result.getOrThrow(one.apply({ _tag: "Assign", tile: 1, game: irish }, carriedOnFox))
}

function carriedOnFox() {
  return ChannelAvailability.Carried({ channel: fox, learnedFor: Option.none() })
}

function none() {
  return ChannelAvailability.NotCarried({ why: "NoStream" })
}
