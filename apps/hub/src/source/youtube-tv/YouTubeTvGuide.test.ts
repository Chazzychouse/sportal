import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"
import { Guide } from "../Guide.ts"
import { recordedAt, recordedGuide } from "./TestYouTubeTv.ts"
import * as YouTubeTvGuide from "./YouTubeTvGuide.ts"

describe("YouTubeTvGuide.decode", () => {
  it.effect("should return a complete guide stamped by the Effect clock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recordedAt)

      const guide = yield* YouTubeTvGuide.decode(recordedGuide)

      assert.isTrue(guide instanceof Guide)
      assert.strictEqual(guide.source, "YouTube TV")
      assert.strictEqual(DateTime.toEpochMillis(guide.readAt), recordedAt)
      assert.isAbove(guide.channels.length, 0)
      assert.isAbove(guide.airings.length, 0)
    })
  )

  it.effect("should reject a response with no channels as GuideUnreadable", () =>
    Effect.gen(function* () {
      const response = JSON.stringify({
        contents: { epgRenderer: { paginationRenderer: { epgPaginationRenderer: { contents: [] } } } }
      })

      const error = yield* YouTubeTvGuide.decode(response).pipe(Effect.flip)

      assert.strictEqual(error._tag, "GuideUnreadable")
    })
  )

  it.effect("should reject malformed JSON as GuideUnreadable", () =>
    Effect.gen(function* () {
      const error = yield* YouTubeTvGuide.decode("not json").pipe(Effect.flip)

      assert.strictEqual(error._tag, "GuideUnreadable")
    })
  )
})
