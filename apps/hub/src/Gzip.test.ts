import { gzipSync } from "node:zlib"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as Gzip from "./Gzip.ts"

describe("Gzip.decompressStream", () => {
  it.effect("should give back the text a chunked gzip stream holds", () =>
    Effect.gen(function* () {
      const bytes = gzipSync("first line\nsecond line\n")
      const chunks = Stream.fromIterable([bytes.subarray(0, 5), bytes.subarray(5, 12), bytes.subarray(12)])

      const text = yield* Stream.mkString(Gzip.decompressStream(chunks, "gzip"))

      assert.strictEqual(text, "first line\nsecond line\n")
    })
  )

  it.effect("should fail for bytes that are not gzip", () =>
    Effect.gen(function* () {
      const chunks = Stream.make(new TextEncoder().encode("not gzip"))

      const error = yield* Stream.mkString(Gzip.decompressStream(chunks, "gzip")).pipe(Effect.flip)

      assert.strictEqual(error._tag, "UnknownError")
    })
  )
})
