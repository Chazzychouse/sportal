import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import type { GameId } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { assign, bama, fill, irish, nowhere, onFox, soloed } from "@sportal/domain/TestStage"
import { Result } from "effect"
import { coveredGames, placements, tileRects } from "./TileRects.ts"

describe("tileRects", () => {
  it("should lay a Quad out in whole pixels with a gap between tiles", () => {
    const [main, right] = tileRects(Stage.initial, area)

    assert.deepStrictEqual(main, { x: 3, y: 3, width: 794, height: 444 })
    assert.deepStrictEqual(right, { x: 803, y: 3, width: 794, height: 444 })
  })

  it("should give neighbouring tiles the same gap when the split falls between pixels", () => {
    const stage = Result.getOrThrow(
      Stage.initial.apply({ _tag: "SetSplit", split: { x: 0.3333, y: 0.5 } }, nowhere)
    )

    const [main, right] = tileRects(stage, { width: 1001, height: 600 })

    const gap = (right?.x ?? 0) - ((main?.x ?? 0) + (main?.width ?? 0))
    assert.strictEqual(gap, 6)
  })

  it("should give a soloed game the whole area and the others nothing", () => {
    const stage = soloed([bama, irish], 1)

    const rects = tileRects(stage, area)

    assert.deepStrictEqual(rects[1], { x: 3, y: 3, width: 1594, height: 894 })
    assert.strictEqual(rects[0]?.width, 0)
  })
})

describe("placements", () => {
  it("should resolve a scenario stream's path against the page's origin, leaving full addresses alone", () => {
    const scenario = {
      name: "CBS",
      source: "Scenario" as const,
      locator: { _tag: "WebView" as const, url: "/scenario-stream/401856707" }
    }
    const carriedOnScenario = () => ChannelAvailability.Carried({ channel: scenario })
    const stage = assign(assign(Stage.initial, 0, bama, carriedOnScenario), 1, irish, onFox)

    const urls = placed(stage).map((placement) => placement.url)

    assert.deepStrictEqual(urls, [
      "http://127.0.0.1:4401/scenario-stream/401856707",
      "https://tv.youtube.com/watch/fox"
    ])
  })

  it("should place a stream tile's video below its header, offset by the Stage area's position", () => {
    const stage = fill([bama, irish])

    const [placement] = placed(stage, undefined, { x: 352, y: 48 })

    assert.deepStrictEqual(placement?.bounds, { x: 355, y: 79, width: 794, height: 416 })
    assert.strictEqual(placement?.game, bama)
    assert.isFalse(placement?.muted)
  })

  it("should mute every stream but the one with audio focus", () => {
    const stage = fill([bama, irish])

    const muted = placed(stage).map((placement) => placement.muted)

    assert.deepStrictEqual(muted, [false, true])
  })

  it("should give the mouse only to the interacting game's stream", () => {
    const stage = fill([bama, irish])

    const interactive = placed(stage, irish).map((placement) => placement.interactive)

    assert.deepStrictEqual(interactive, [false, true])
  })

  it("should give the mouse to no stream while no game is interacting", () => {
    const stage = fill([bama, irish])

    const interactive = placed(stage).map((placement) => placement.interactive)

    assert.deepStrictEqual(interactive, [false, false])
  })

  it("should place nothing for a tile with no size", () => {
    const stage = soloed([bama, irish], 1)

    const games = placed(stage).map((placement) => placement.game)

    assert.deepStrictEqual(games, [irish])
  })
})

describe("coveredGames", () => {
  it.each([
    { overlay: { x: 250, y: 150, width: 200, height: 200 }, shares: "a corner" },
    { overlay: { x: 0, y: 0, width: 1000, height: 1000 }, shares: "all" }
  ])("should cover a video an overlay shares area with: $shares", ({ overlay }) => {
    const video = videoOf(bama)

    const covered = coveredGames([overlay], [video])

    assert.deepStrictEqual(covered, [bama])
  })

  it.each([
    { overlay: { x: 300, y: 100, width: 50, height: 50 }, is: "touching its edge" },
    { overlay: { x: 0, y: 0, width: 50, height: 50 }, is: "apart from it" }
  ])("should leave a video an overlay shares no area with: $is", ({ overlay }) => {
    const video = videoOf(bama)

    const covered = coveredGames([overlay], [video])

    assert.deepStrictEqual(covered, [])
  })

  it("should leave a video shown under an overlay flush against its top edge", () => {
    const videos = [videoOf(bama), belowOf(irish)]

    const covered = coveredGames([sheet()], videos)

    assert.deepStrictEqual(covered, [])
  })

  it("should cover every video an overlay reaches", () => {
    const videos = [videoOf(bama), belowOf(irish)]

    const covered = coveredGames([{ ...sheet(), height: 301 }], videos)

    assert.deepStrictEqual(covered, [bama, irish])
  })
})

const area = { width: 1600, height: 900 }

/** The placements of `stage`'s streams in the Stage area, on the dev server's origin. */
function placed(stage: Stage, interacting?: GameId, offset = { x: 0, y: 0 }) {
  return placements(stage, tileRects(stage, area), offset, "http://127.0.0.1:4401", interacting)
}

/** `game`'s video, 200 by 100 at 100,100. */
function videoOf(game: GameId) {
  return { game, bounds: { x: 100, y: 100, width: 200, height: 100 } }
}

/** `game`'s video, 200 by 100 at 100,300: below the one `videoOf` places. */
function belowOf(game: GameId) {
  return { game, bounds: { x: 100, y: 300, width: 200, height: 100 } }
}

/** A sheet across the top, 100 tall: it ends at `videoOf`'s top edge. */
function sheet() {
  return { x: 0, y: 0, width: 400, height: 100 }
}
