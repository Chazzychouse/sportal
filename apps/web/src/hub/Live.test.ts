import { assert, describe, it } from "@effect/vitest"
import { Stage } from "@sportal/domain/Stage"
import { disconnected, reduce } from "./Live.ts"

describe("Live.reduce", () => {
  it("replaces the stage and keeps the slate", () => {
    const stage = new Stage({ tiles: Stage.initial.tiles, audioFocus: 2 })
    const next = reduce(disconnected, { _tag: "StageChanged", stage })
    assert.strictEqual(next.stage.audioFocus, 2)
    assert.strictEqual(next.slate, disconnected.slate)
  })

  it("replaces the slate and keeps the stage", () => {
    const next = reduce(disconnected, { _tag: "SlateChanged", slate: [] })
    assert.deepStrictEqual(next.slate, [])
    assert.strictEqual(next.stage, disconnected.stage)
  })
})
