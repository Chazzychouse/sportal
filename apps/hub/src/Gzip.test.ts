import { gzipSync } from "node:zlib"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Gzip from "./Gzip.ts"

describe("Gzip.decompress", () => {
  it.effect("should give back the text gzip'd bytes hold", () =>
    Effect.gen(function* () {
      const bytes = gzipSync("first line\nsecond line\n")

      const text = yield* Gzip.decompress(bytes, "gzip")

      assert.strictEqual(text, "first line\nsecond line\n")
    })
  )

  it.effect("should fail for bytes that are not gzip", () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode("not gzip")

      const error = yield* Effect.flip(Gzip.decompress(bytes, "gzip"))

      assert.strictEqual(error._tag, "UnknownError")
    })
  )
})
