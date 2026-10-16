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
