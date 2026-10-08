import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../Database.ts"
import { LoggedFrame } from "../Frame.ts"
import { FeedFrameRow, migrations } from "./FeedFrameTable.ts"

describe("FeedFrameRow", () => {
  it.effect("should read an unchanged row as a poll response", () =>
    Effect.gen(function* () {
      const row = new FeedFrameRow({
        seq: 2,
        received_at: 1_000,
        sent_at: null,
        number: null,
        source: "poll",
        channel: "nfl",
        kind: "unchanged",
        body: null,
        body_hash: "abc"
      })

      const frame = yield* FeedFrameRow.frame(row, "slate")

      assert.deepStrictEqual(
        frame,
        new LoggedFrame({
          seq: 2,
          receivedAt: DateTime.makeUnsafe(1_000),
          source: "poll",
          channel: "nfl",
          kind: "whole",
          body: "slate"
        })
      )
    })
  )

  it.effect("should round-trip a frame with no sentAt or number as null columns", () =>
    Effect.gen(function* () {
      const frame = new LoggedFrame({
        seq: 1,
        receivedAt: DateTime.makeUnsafe(1_000),
        source: "poll",
        channel: "nfl",
        kind: "whole",
        body: "{}"
      })

      const row = FeedFrameRow.of(frame, "abc", new Uint8Array([1]), false)
      const back = yield* FeedFrameRow.frame(row, "{}")

      assert.deepStrictEqual([row.sent_at, row.number], [null, null])
      assert.deepStrictEqual(back, frame)
      assert.notProperty(back, "sentAt")
      assert.notProperty(back, "number")
    })
  )

  it.effect("should write a gap row at the last lost seq with no source or channel", () =>
    Effect.gen(function* () {
      const behind = {
        from: 3,
        to: 5,
        count: 3,
        receivedAt: DateTime.makeUnsafe(1_000)
      }

      const row = yield* FeedFrameRow.gap(behind)

      assert.deepStrictEqual(
        [row.seq, row.received_at, row.source, row.channel, row.kind, row.body_hash],
        [5, 1_000, null, null, "gap", null]
      )
      assert.instanceOf(row.body, Uint8Array)
    })
  )

  it.effect("should migrate a version-2 table's feed and kind to source and kind", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Database.migrate("feed", versionTwo)
      yield* sql`
        INSERT INTO feed_frame (seq, received_at, source_id, feed, channel, kind, body_hash) VALUES
          (1, 1000, NULL, 'poll', 'nfl', 'response', 'a'),
          (2, 2000, NULL, 'poll', 'nfl', 'unchanged', 'a'),
          (3, 3000, 7, 'fastcast', 'socket', 'message', 'b'),
          (4, 4000, NULL, 'fastcast', 'topic', 'checkpoint', 'c'),
          (5, 5000, NULL, 'snapshot', 'nfl', 'checkpoint', 'd')
      `

      yield* Database.migrate("feed", migrations)

      const rows = yield* sql`SELECT seq, source, kind, number FROM feed_frame ORDER BY seq`
      assert.deepStrictEqual(rows, [
        { seq: 1, source: "poll", kind: "whole", number: null },
        { seq: 2, source: "poll", kind: "unchanged", number: null },
        { seq: 3, source: "push", kind: "change", number: 7 },
        { seq: 4, source: "push", kind: "whole", number: null },
        { seq: 5, source: "push", kind: "whole", number: null }
      ])
    }).pipe(Effect.provide(Database.layerMemory))
  )

  it.effect("should keep a gap row a gap through the migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Database.migrate("feed", versionTwo)
      yield* sql`
        INSERT INTO feed_frame (seq, received_at, feed, channel, kind) VALUES (4, 1000, NULL, NULL, 'gap')
      `

      yield* Database.migrate("feed", migrations)

      const rows = yield* sql`SELECT seq, source, channel, kind FROM feed_frame`
      assert.deepStrictEqual(rows, [{ seq: 4, source: null, channel: null, kind: "gap" }])
    }).pipe(Effect.provide(Database.layerMemory))
  )
})

const versionTwo = {
  "1_create_feed_frame": migrations["1_create_feed_frame"],
  "2_allow_snapshot_feed": migrations["2_allow_snapshot_feed"]
}
