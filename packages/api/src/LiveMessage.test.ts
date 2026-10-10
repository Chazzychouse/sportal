import { assert, describe, it } from "@effect/vitest"
import { Slate } from "@sportal/domain/Slate"
import { Schema } from "effect"
import { type LiveMessage, LiveMessageJson } from "./LiveMessage.ts"

describe("LiveMessage", () => {
  it("should encode SlateChanged as {_tag, slate, availability}", () => {
    const message: LiveMessage = { _tag: "SlateChanged", slate: Slate.empty, availability: {} }

    const json = Schema.encodeSync(LiveMessageJson)(message)

    assert.strictEqual(json, '{"_tag":"SlateChanged","slate":{"games":[]},"availability":{}}')
  })
})
