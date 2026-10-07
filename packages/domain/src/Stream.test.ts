import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { StreamLocator } from "./Stream.ts"

describe("StreamLocator", () => {
  it("should decode what it encodes", () => {
    const json = { _tag: "WebView", url: "https://tv.example/abc" } as const
    const locator = Schema.decodeSync(StreamLocator)(json)

    const encoded = Schema.encodeSync(StreamLocator)(locator)

    assert.deepStrictEqual(encoded, json)
  })

  it("should encode a WebView as today", () => {
    const locator = Schema.decodeSync(StreamLocator)({
      _tag: "WebView",
      url: "https://tv.example/abc"
    })

    const encoded = JSON.stringify(Schema.encodeSync(StreamLocator)(locator))

    assert.strictEqual(encoded, '{"_tag":"WebView","url":"https://tv.example/abc"}')
  })
})
