import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { ChannelAvailability } from "@sportal/domain/Source"
import { Stage } from "@sportal/domain/Stage"
import { Option, Result } from "effect"
import { placements, tileRects } from "./TileRects.ts"

const area = { width: 1600, height: 900 }
const bama = GameId.make("401856707")
const irish = GameId.make("401858250")
const fox = {
  name: "FOX",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" }
}

describe("tileRects", () => {
  it("lays a Quad out in whole pixels with a gap between tiles", () => {
    const [main, right] = tileRects(Stage.initial, area)
    assert.deepStrictEqual(main, { x: 3, y: 3, width: 794, height: 444 })
    assert.deepStrictEqual(right, { x: 803, y: 3, width: 794, height: 444 })
  })

  it("gives neighbouring tiles the same gap when the split falls between pixels", () => {
    const stage = Result.getOrThrow(
      Stage.initial.apply({ _tag: "SetSplit", split: { x: 0.3333, y: 0.5 } }, none)
    )
    const [main, right] = tileRects(stage, { width: 1001, height: 600 })
    assert.strictEqual((right?.x ?? 0) - ((main?.x ?? 0) + (main?.width ?? 0)), 6)
  })

  it("gives a soloed game the whole area and the others nothing", () => {
    const rects = tileRects(soloed(), area)
    assert.deepStrictEqual(rects[1], { x: 3, y: 3, width: 1594, height: 894 })
    assert.strictEqual(rects[0]?.width, 0)
  })
})

describe("placements", () => {
  it("places a stream tile's video below its header, offset by the Stage area's position", () => {
    const stage = streaming()
    const [placement] = placements(stage, tileRects(stage, area), { x: 352, y: 48 })
    assert.deepStrictEqual(placement?.bounds, { x: 355, y: 79, width: 794, height: 416 })
    assert.strictEqual(placement?.game, bama)
    assert.isFalse(placement?.muted)
  })

  it("mutes every stream but the one with audio focus", () => {
    const stage = streaming()
    assert.deepStrictEqual(
      placements(stage, tileRects(stage, area), { x: 0, y: 0 }).map((placement) => placement.muted),
      [false, true]
    )
  })

  it("places nothing for a tile with no size", () => {
    const stage = soloed()
    assert.deepStrictEqual(
      placements(stage, tileRects(stage, area), { x: 0, y: 0 }).map((placement) => placement.game),
      [irish]
    )
  })
})

function streaming() {
  const one = Result.getOrThrow(Stage.initial.apply({ _tag: "Assign", tile: 0, game: bama }, carriedOnFox))
  return Result.getOrThrow(one.apply({ _tag: "Assign", tile: 1, game: irish }, carriedOnFox))
}

function soloed() {
  return Result.getOrThrow(streaming().apply({ _tag: "Solo", tile: 1 }, none))
}

function carriedOnFox() {
  return ChannelAvailability.Carried({ channel: fox, learnedFor: Option.none() })
}

function none() {
  return ChannelAvailability.NotCarried({ why: "NoStream" })
}
