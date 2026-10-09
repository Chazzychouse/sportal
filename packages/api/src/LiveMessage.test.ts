import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { LiveMessage, LiveMessageJson } from "./LiveMessage.ts"

describe("LiveMessage", () => {
  it("should encode SlateChanged as {_tag, games}", () => {
    const message = LiveMessage.cases.SlateChanged.make({ games: [] })

    const json = Schema.encodeSync(LiveMessageJson)(message)

    assert.strictEqual(json, '{"_tag":"SlateChanged","games":[]}')
  })
})
