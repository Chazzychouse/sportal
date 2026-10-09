import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { type LiveMessage, LiveMessageJson } from "./LiveMessage.ts"

describe("LiveMessage", () => {
  it("should encode SlateChanged as {_tag, games}", () => {
    const message: LiveMessage = { _tag: "SlateChanged", games: [] }

    const json = Schema.encodeSync(LiveMessageJson)(message)

    assert.strictEqual(json, '{"_tag":"SlateChanged","games":[]}')
  })
})
