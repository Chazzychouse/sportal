import { assert, describe, it } from "@effect/vitest"
import type { GameId } from "@sportal/domain/Game"
import { Result } from "effect"
import * as TestWeb from "../TestWeb.ts"
import { Screen } from "./Screen.ts"
import * as TileRects from "./TileRects.ts"

describe("tileRects", () => {
  it("should lay a Quad out in whole pixels with a gap between tiles", () => {
    const [main, right] = TileRects.tileRects(Screen.initial, area)

    assert.deepStrictEqual(main, { x: 3, y: 3, width: 794, height: 444 })
    assert.deepStrictEqual(right, { x: 803, y: 3, width: 794, height: 444 })
  })

  it("should give neighbouring tiles the same gap when the split falls between pixels", () => {
    const screen = Result.getOrThrow(
      Screen.initial.apply({ _tag: "SetSplit", split: { x: 0.3333, y: 0.5 } }, TestWeb.nowhere)
    )

    const [main, right] = TileRects.tileRects(screen, { width: 1001, height: 600 })

    const gap = (right?.x ?? 0) - ((main?.x ?? 0) + (main?.width ?? 0))
    assert.strictEqual(gap, 6)
  })

  it("should give a soloed game the whole area and the others nothing", () => {
    const screen = TestWeb.soloed([TestWeb.bama, TestWeb.irish], 1)

    const rects = TileRects.tileRects(screen, area)

    assert.deepStrictEqual(rects[1], { x: 3, y: 3, width: 1594, height: 894 })
    assert.strictEqual(rects[0]?.width, 0)
  })
})

describe("placements", () => {
  it("should place a stream tile's video below its header, offset by the Screen area's position", () => {
    const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])

    const [placement] = placed(screen, undefined, { x: 352, y: 48 })

    assert.deepStrictEqual(placement?.bounds, { x: 355, y: 79, width: 794, height: 416 })
    assert.strictEqual(placement?.game, TestWeb.bama)
    assert.isFalse(placement?.muted)
  })

  it("should mute every stream but the one with audio focus", () => {
    const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])

    const muted = placed(screen).map((placement) => placement.muted)

    assert.deepStrictEqual(muted, [false, true])
  })

  it("should give the mouse only to the interacting game's stream", () => {
    const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])

    const interactive = placed(screen, TestWeb.irish).map((placement) => placement.interactive)

    assert.deepStrictEqual(interactive, [false, true])
  })

  it("should give the mouse to no stream while no game is interacting", () => {
    const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])

    const interactive = placed(screen).map((placement) => placement.interactive)

    assert.deepStrictEqual(interactive, [false, false])
  })

  it("should place nothing for a tile with no size", () => {
    const screen = TestWeb.soloed([TestWeb.bama, TestWeb.irish], 1)

    const games = placed(screen).map((placement) => placement.game)

    assert.deepStrictEqual(games, [TestWeb.irish])
  })
})

describe("coveredGames", () => {
  it.each([
    { overlay: { x: 250, y: 150, width: 200, height: 200 }, shares: "a corner" },
    { overlay: { x: 0, y: 0, width: 1000, height: 1000 }, shares: "all" }
  ])("should cover a video an overlay shares area with: $shares", ({ overlay }) => {
    const video = videoOf(TestWeb.bama)

    const covered = TileRects.coveredGames([overlay], [video])

    assert.deepStrictEqual(covered, [TestWeb.bama])
  })

  it.each([
    { overlay: { x: 300, y: 100, width: 50, height: 50 }, is: "touching its edge" },
    { overlay: { x: 0, y: 0, width: 50, height: 50 }, is: "apart from it" }
  ])("should leave a video an overlay shares no area with: $is", ({ overlay }) => {
    const video = videoOf(TestWeb.bama)

    const covered = TileRects.coveredGames([overlay], [video])

    assert.deepStrictEqual(covered, [])
  })

  it("should leave a video shown under an overlay flush against its top edge", () => {
    const videos = [videoOf(TestWeb.bama), belowOf(TestWeb.irish)]

    const covered = TileRects.coveredGames([sheet()], videos)

    assert.deepStrictEqual(covered, [])
  })

  it("should cover every video an overlay reaches", () => {
    const videos = [videoOf(TestWeb.bama), belowOf(TestWeb.irish)]

    const covered = TileRects.coveredGames([{ ...sheet(), height: 301 }], videos)

    assert.deepStrictEqual(covered, [TestWeb.bama, TestWeb.irish])
  })
})

const area = { width: 1600, height: 900 }

/** The placements of `screen`'s streams in the Screen area, on the dev server's origin. */
function placed(screen: Screen, interacting?: GameId, offset = { x: 0, y: 0 }) {
  return TileRects.placements(screen, TileRects.tileRects(screen, area), offset, interacting)
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
