import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Schema } from "effect"
import { TileKey } from "./TileKey.ts"

describe("TileKey", () => {
  it("should send a key as its plain string", () => {
    const key = TileKey.game(GameId.make("401856707"))

    const wire = Schema.encodeSync(TileKey)(key)

    assert.strictEqual(wire, "401856707")
  })
})

describe("TileKey.game", () => {
  it("should key a game's tile by the game's id", () => {
    const key = TileKey.game(GameId.make("401856707"))

    assert.strictEqual(key, "401856707")
  })
})

describe("TileKey.custom", () => {
  it("should key a custom stream's tile by its id, prefixed custom:", () => {
    const key = TileKey.custom("video.dQw4w9WgXcQ")

    assert.strictEqual(key, "custom:video.dQw4w9WgXcQ")
  })
})

describe("TileKey.stats", () => {
  it("should key a game's stats tile by the game's id, prefixed stats:", () => {
    const key = TileKey.stats(GameId.make("401856707"))

    assert.strictEqual(key, "stats:401856707")
  })
})

describe("TileKey.channel", () => {
  const youTubeTv = "YouTube TV" as const

  it("should key a channel by its source and live address, prefixed channel:", () => {
    const key = TileKey.channel({
      source: youTubeTv,
      locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/espn" }
    })

    assert.strictEqual(key, "channel:YouTube TV:https://tv.youtube.com/watch/espn")
  })

  it("should key two same-named channels at different addresses apart", () => {
    const one = TileKey.channel({
      source: youTubeTv,
      locator: { _tag: "WebView", url: "https://tv.youtube.com/a" }
    })
    const other = TileKey.channel({
      source: youTubeTv,
      locator: { _tag: "WebView", url: "https://tv.youtube.com/b" }
    })

    assert.notStrictEqual(one, other)
  })
})
