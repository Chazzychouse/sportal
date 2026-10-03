import { assert, describe, it } from "@effect/vitest"
import { Option, Result } from "effect"
import { GameId } from "./Game.ts"
import * as Stage from "./Stage.ts"

const bama = GameId.make("401856707")
const irish = GameId.make("401858250")
const onFox = () => Option.some({ _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" })
const nowhere = () => Option.none()

describe("Stage.apply", () => {
  it("assigns a streamable game as a stream tile", () => {
    const stage = Result.getOrThrow(
      Stage.apply(Stage.initial, { _tag: "Assign", tile: 1, game: bama }, onFox)
    )
    assert.deepStrictEqual(stage.tiles[1], {
      _tag: "StreamTile",
      game: bama,
      locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/fox" }
    })
  })

  it("assigns a game with no stream as a data tile", () => {
    const stage = Result.getOrThrow(
      Stage.apply(Stage.initial, { _tag: "Assign", tile: 0, game: bama }, nowhere)
    )
    assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: bama })
  })

  it("moves a game rather than showing it twice", () => {
    const first = Result.getOrThrow(
      Stage.apply(Stage.initial, { _tag: "Assign", tile: 0, game: bama }, onFox)
    )
    const second = Result.getOrThrow(Stage.apply(first, { _tag: "Assign", tile: 2, game: bama }, onFox))
    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.strictEqual(second.tiles[2]?._tag, "StreamTile")
  })

  it("clears a tile and leaves the others", () => {
    const a = Result.getOrThrow(Stage.apply(Stage.initial, { _tag: "Assign", tile: 0, game: bama }, onFox))
    const b = Result.getOrThrow(Stage.apply(a, { _tag: "Assign", tile: 1, game: irish }, onFox))
    const c = Result.getOrThrow(Stage.apply(b, { _tag: "Clear", tile: 0 }, onFox))
    assert.strictEqual(c.tiles[0]?._tag, "Empty")
    assert.strictEqual(c.tiles[1]?._tag, "StreamTile")
  })

  it("moves audio focus", () => {
    const stage = Result.getOrThrow(Stage.apply(Stage.initial, { _tag: "FocusAudio", tile: 3 }, nowhere))
    assert.strictEqual(stage.audioFocus, 3)
  })

  it("rejects a tile that does not exist", () => {
    const result = Stage.apply(Stage.initial, { _tag: "FocusAudio", tile: 4 }, nowhere)
    assert.isTrue(Result.isFailure(result))
  })
})
