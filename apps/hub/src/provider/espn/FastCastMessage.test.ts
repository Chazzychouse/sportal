import { deflateSync } from "node:zlib"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as FastCastMessage from "./FastCastMessage.ts"

describe("FastCastMessage.Message", () => {
  it.effect("should read the patches of a message whose patches are zlib-deflated", () =>
    Effect.gen(function* () {
      const patches = [{ op: "remove", path: "s:20~l:28~e:401" }]
      const compressed = deflateSync(JSON.stringify(patches)).toString("base64")
      const text = patchMessage(compressed)

      const message = yield* decodeMessage(text)

      assert.deepStrictEqual("pl" in message ? message.pl : undefined, [
        { op: "remove", path: { uid: "s:20~l:28~e:401", pointer: "" } }
      ])
    })
  )

  it.effect("should not decode a message whose patches are base64 but not zlib-deflated", () =>
    Effect.gen(function* () {
      const text = patchMessage(Buffer.from("not deflated").toString("base64"))

      const error = yield* Effect.flip(decodeMessage(text))

      assert.include(error.message, "Not zlib-deflated")
    })
  )
})

/** A patch message on NFL's scoreboard topic whose inner `pl` is `pl`. */
function patchMessage(pl: string): string {
  return JSON.stringify({ op: "P", tc: "event-football-nfl", mid: 2, pl: JSON.stringify({ ts: 0, pl }) })
}

const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(FastCastMessage.Message))
