import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { Option, Result } from "effect"
import { coveredGames, placements, tileRects } from "./TileRects.ts"

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
  it("resolves a scenario stream's path against the page's origin and leaves full addresses alone", () => {
    const scenario = {
      name: "CBS",
      source: "Scenario" as const,
      locator: { _tag: "WebView" as const, url: "/scenario-stream/401856707" }
    }
    const carriedOnScenario = () =>
      ChannelAvailability.Carried({ channel: scenario, learnedFor: Option.none() })
    const stage = Result.getOrThrow(
      Result.getOrThrow(
        Stage.initial.apply({ _tag: "Assign", tile: 0, game: bama }, carriedOnScenario)
      ).apply({ _tag: "Assign", tile: 1, game: irish }, carriedOnFox)
    )
    assert.deepStrictEqual(
      placements(stage, tileRects(stage, area), { x: 0, y: 0 }, "http://127.0.0.1:4401", undefined).map(
        (p) => p.url
      ),
      ["http://127.0.0.1:4401/scenario-stream/401856707", "https://tv.youtube.com/watch/fox"]
    )
  })

  it("places a stream tile's video below its header, offset by the Stage area's position", () => {
    const stage = streaming()
    const [placement] = placements(
      stage,
      tileRects(stage, area),
      { x: 352, y: 48 },
      "http://127.0.0.1:4401",
      undefined
    )
    assert.deepStrictEqual(placement?.bounds, { x: 355, y: 79, width: 794, height: 416 })
    assert.strictEqual(placement?.game, bama)
    assert.isFalse(placement?.muted)
  })

  it("mutes every stream but the one with audio focus", () => {
    const stage = streaming()
    assert.deepStrictEqual(
      placements(stage, tileRects(stage, area), { x: 0, y: 0 }, "http://127.0.0.1:4401", undefined).map(
        (placement) => placement.muted
      ),
      [false, true]
    )
  })

  it("gives the mouse only to the interacting game's stream", () => {
    const stage = streaming()
    assert.deepStrictEqual(
      placements(stage, tileRects(stage, area), { x: 0, y: 0 }, "http://127.0.0.1:4401", irish).map(
        (placement) => placement.interactive
      ),
      [false, true]
    )
    assert.deepStrictEqual(
      placements(stage, tileRects(stage, area), { x: 0, y: 0 }, "http://127.0.0.1:4401", undefined).map(
        (placement) => placement.interactive
      ),
      [false, false]
    )
  })

  it("places nothing for a tile with no size", () => {
    const stage = soloed()
    assert.deepStrictEqual(
      placements(stage, tileRects(stage, area), { x: 0, y: 0 }, "http://127.0.0.1:4401", undefined).map(
        (placement) => placement.game
      ),
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

describe("coveredGames", () => {
  const video = { game: bama, bounds: { x: 100, y: 100, width: 200, height: 100 } }

  it("covers a video an overlay shares area with", () => {
    assert.deepStrictEqual(coveredGames([{ x: 250, y: 150, width: 200, height: 200 }], [video]), [bama])
    assert.deepStrictEqual(coveredGames([{ x: 0, y: 0, width: 1000, height: 1000 }], [video]), [bama])
  })

  it("leaves a video an overlay only touches, or is apart from", () => {
    assert.deepStrictEqual(coveredGames([{ x: 300, y: 100, width: 50, height: 50 }], [video]), [])
    assert.deepStrictEqual(coveredGames([{ x: 0, y: 0, width: 50, height: 50 }], [video]), [])
  })

  it("leaves a video shown under an overlay flush against its top edge, and covers the one it reaches", () => {
    const below = { game: irish, bounds: { x: 100, y: 300, width: 200, height: 100 } }
    const sheet = { x: 0, y: 0, width: 400, height: 100 }
    assert.deepStrictEqual(coveredGames([sheet], [video, below]), [])
    assert.deepStrictEqual(coveredGames([{ ...sheet, height: 301 }], [video, below]), [bama, irish])
  })
})
