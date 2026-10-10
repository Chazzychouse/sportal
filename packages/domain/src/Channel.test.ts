import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { StreamLocator } from "./Channel.ts"

describe("StreamLocator", () => {
  it("should encode a WebView as its tag and address", () => {
    const json = { _tag: "WebView", url: "https://tv.example/abc" } as const
    const locator = Schema.decodeSync(StreamLocator)(json)

    const encoded = JSON.stringify(Schema.encodeSync(StreamLocator)(locator))

    assert.strictEqual(encoded, '{"_tag":"WebView","url":"https://tv.example/abc"}')
  })
})
