import { assert, describe, it } from "@effect/vitest"
import { Stage } from "@sportal/domain/Stage"
import { disconnected, reduce } from "./LiveStream.ts"

describe("Live.reduce", () => {
  it("replaces the stage and keeps the slate", () => {
    const stage = new Stage({ ...Stage.initial, layout: "Pair" })
    const next = reduce(disconnected, { _tag: "StageChanged", stage })
    assert.strictEqual(next.stage.layout, "Pair")
    assert.strictEqual(next.slate, disconnected.slate)
  })

  it("replaces the slate and keeps the stage", () => {
    const next = reduce(disconnected, { _tag: "SlateChanged", slate: [] })
    assert.deepStrictEqual(next.slate, [])
    assert.strictEqual(next.watchability.size, 0)
    assert.strictEqual(next.stage, disconnected.stage)
  })
})
