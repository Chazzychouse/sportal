import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { Frame } from "../Frame.ts"
import { FeedFrameRow } from "./FeedFrameTable.ts"
import { Writer } from "./FeedLogWriter.ts"

describe("FeedFrameRow", () => {
  it.effect("should read an unchanged row as a poll response", () =>
    Effect.gen(function* () {
      const row = new FeedFrameRow({
        seq: 2,
        received_at: 1_000,
        sent_at: null,
        source_id: null,
        feed: "poll",
        channel: "nfl",
        kind: "unchanged",
        body: null,
        body_hash: "abc"
      })

      const frame = yield* FeedFrameRow.frame(row, "slate")

      assert.deepStrictEqual(
        frame,
        new Frame({
          seq: 2,
          receivedAt: DateTime.makeUnsafe(1_000),
          feed: "poll",
          channel: "nfl",
          kind: "response",
          body: "slate"
        })
      )
    })
  )

  it.effect("should round-trip a frame with no sentAt or sourceId as null columns", () =>
    Effect.gen(function* () {
      const frame = new Frame({
        seq: 1,
        receivedAt: DateTime.makeUnsafe(1_000),
        feed: "poll",
        channel: "nfl",
        kind: "response",
        body: "{}"
      })

      const row = FeedFrameRow.of(frame, "abc", new Uint8Array([1]), false)
      const back = yield* FeedFrameRow.frame(row, "{}")

      assert.deepStrictEqual([row.sent_at, row.source_id], [null, null])
      assert.deepStrictEqual(back, frame)
      assert.notProperty(back, "sentAt")
      assert.notProperty(back, "sourceId")
    })
  )

  it.effect("should write a gap row at the last lost seq with no feed or channel", () =>
    Effect.gen(function* () {
      const behind = Writer.Behind({
        hashes: new Map(),
        from: 3,
        to: 5,
        count: 3,
        receivedAt: DateTime.makeUnsafe(1_000)
      })

      const row = yield* FeedFrameRow.gap(behind)

      assert.deepStrictEqual(
        [row.seq, row.received_at, row.feed, row.channel, row.kind, row.body_hash],
        [5, 1_000, null, null, "gap", null]
      )
      assert.instanceOf(row.body, Uint8Array)
    })
  )
})
