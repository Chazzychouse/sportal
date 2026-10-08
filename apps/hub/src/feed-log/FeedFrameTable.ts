import { DateTime, Effect, Schema } from "effect"
import { Model } from "effect/schema"
import { SqlClient, SqlSchema } from "effect/sql"
import { LoggedFrame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"

/**
 * A row of `feed_frame`: a frame with its body gzip'd, or with no body for an unchanged poll (a poll response that
 * repeats its channel's last), or the gap a failed write left. Only a gap has no source or channel.
 */
export class FeedFrameRow extends Model.Class<FeedFrameRow>("sportal/hub/feed-log/FeedFrameRow")({
  seq: Schema.Int,
  received_at: Schema.Int,
  sent_at: Schema.NullOr(Schema.Int),
  number: Schema.NullOr(Schema.Int),
  source: Schema.NullOr(LoggedFrame.fields.source),
  channel: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["whole", "change", "unchanged", "gap"]),
  body: Schema.NullOr(Schema.Uint8Array),
  body_hash: Schema.NullOr(Schema.String)
}) {
  static readonly columns = Object.keys(FeedFrameRow.fields)

  /** The frame a row other than a gap holds, its body read as `body`; an unchanged poll reads as a whole. */
  static readonly frame = Effect.fnUntraced(function* (row: FeedFrameRow, body: string) {
    return yield* decodeFrame({
      seq: row.seq,
      receivedAt: row.received_at,
      ...(row.sent_at === null ? {} : { sentAt: row.sent_at }),
      ...(row.number === null ? {} : { number: row.number }),
      source: row.source,
      channel: row.channel,
      kind: row.kind === "unchanged" ? "whole" : row.kind,
      body
    })
  })

  /** `frame`'s row, hashed `hash`, its body gzip'd as `body`, or none when it is an `unchanged` poll. */
  static of(frame: LoggedFrame, hash: string, body: Uint8Array | null, unchanged: boolean): FeedFrameRow {
    return new FeedFrameRow({
      seq: frame.seq,
      received_at: DateTime.toEpochMillis(frame.receivedAt),
      sent_at: frame.sentAt === undefined ? null : DateTime.toEpochMillis(frame.sentAt),
      number: frame.number ?? null,
      source: frame.source,
      channel: frame.channel,
      kind: unchanged ? "unchanged" : frame.kind,
      body,
      body_hash: hash
    })
  }

  /**
   * The row that stands for the frames a failed write lost, at the last lost `seq`, so a log reopened after it
   * continues past them.
   */
  static readonly gap = Effect.fnUntraced(function* ({
    from,
    to,
    count,
    receivedAt
  }: {
    readonly from: number
    readonly to: number
    readonly count: number
    readonly receivedAt: DateTime.Utc
  }) {
    const json = yield* Schema.encodeEffect(Gap)({ from, to, count })
    const body = yield* Gzip.compress(json)
    return new FeedFrameRow({
      seq: to,
      received_at: DateTime.toEpochMillis(receivedAt),
      sent_at: null,
      number: null,
      source: null,
      channel: null,
      kind: "gap",
      body,
      body_hash: null
    })
  })
}

/** What a gap row's body holds: the `seq` range and number of frames a failed write lost. */
export const Gap = Schema.fromJsonString(
  Schema.Struct({ from: Schema.Int, to: Schema.Int, count: Schema.Int })
)

/** The feed log's queries over `sql`, each built once. */
export function queries(sql: SqlClient.SqlClient) {
  return {
    lastSeq: SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ seq: Schema.NullOr(Schema.Int) }),
      execute: () => sql`SELECT MAX(seq) AS seq FROM feed_frame`
    }),
    // Each poll channel's last stored hash, so an unchanged response after a restart is still known as one.
    lastHashes: SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ channel: Schema.String, body_hash: Schema.String }),
      execute: () => sql`
        SELECT channel, body_hash FROM feed_frame WHERE seq IN (
          SELECT MAX(seq) FROM feed_frame
          WHERE source = 'poll' AND kind IN ('whole', 'unchanged') GROUP BY channel
        )
      `
    }),
    firstAt: SqlSchema.findOne({
      Request: Schema.Int,
      Result: Schema.Struct({ seq: Schema.NullOr(Schema.Int) }),
      execute: (at) => sql`SELECT MIN(seq) AS seq FROM feed_frame WHERE received_at >= ${at}`
    }),
    // The last frame's seq, a gap aside, from the first received at or after `at` on: what a replay from `at` reads to.
    lastFrom: SqlSchema.findOne({
      Request: Schema.Int,
      Result: Schema.Struct({ seq: Schema.NullOr(Schema.Int) }),
      execute: (at) => sql`
        SELECT MAX(seq) AS seq FROM feed_frame
        WHERE kind != 'gap' AND seq >= (SELECT MIN(seq) FROM feed_frame WHERE received_at >= ${at})
      `
    }),
    // Each topic's latest checkpoint before `before`, and that topic's frames after it and before `before`.
    lookback: SqlSchema.findAll({
      Request: Schema.Int,
      Result: FeedFrameRow,
      execute: (before) => sql`
        SELECT ${sql.csv(FeedFrameRow.columns)}
        FROM feed_frame JOIN (
          SELECT channel AS topic, MAX(seq) AS since FROM feed_frame
          WHERE kind = 'whole' AND source = 'push' AND seq < ${before} GROUP BY channel
        ) ON channel = topic AND seq >= since
        WHERE seq < ${before} ORDER BY seq
      `
    }),
    page: SqlSchema.findAll({
      Request: Schema.Struct({ after: Schema.Int, size: Schema.Int }),
      Result: FeedFrameRow,
      execute: ({ after, size }) => sql`
        SELECT ${sql.csv(FeedFrameRow.columns)} FROM feed_frame WHERE seq > ${after} ORDER BY seq LIMIT ${size}
      `
    }),
    lastBody: SqlSchema.findOne({
      Request: Schema.Struct({ channel: Schema.String, seq: Schema.Int }),
      Result: Schema.Struct({ body: Schema.Uint8Array }),
      execute: ({ channel, seq }) => sql`
        SELECT body FROM feed_frame WHERE channel = ${channel} AND kind = 'whole' AND seq < ${seq}
        ORDER BY seq DESC LIMIT 1
      `
    }),
    firstReceived: SqlSchema.findOne({
      Request: Schema.Int,
      Result: Schema.Struct({ received: Schema.NullOr(Schema.Int) }),
      execute: (at) =>
        sql`SELECT MIN(received_at) AS received FROM feed_frame WHERE received_at >= ${at} AND kind != 'gap'`
    })
  }
}

/** The feed log's migrations, recorded in `feed_migrations`. */
export const migrations = {
  "1_create_feed_frame": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE feed_frame (
        seq INTEGER PRIMARY KEY,
        received_at INTEGER NOT NULL,
        sent_at INTEGER,
        source_id INTEGER,
        feed TEXT CHECK (feed IN ('poll', 'fastcast')),
        channel TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('response', 'message', 'checkpoint', 'unchanged', 'gap')),
        body BLOB,
        body_hash TEXT,
        CHECK ((kind = 'gap') = (feed IS NULL AND channel IS NULL))
      )
    `
    yield* sql`CREATE INDEX feed_frame_channel_seq ON feed_frame (channel, seq)`
    yield* sql`CREATE INDEX feed_frame_received_at ON feed_frame (received_at)`
  }),
  // SQLite cannot change a CHECK in place, so the table is rebuilt to let the snapshot feed's frames in.
  "2_allow_snapshot_feed": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE feed_frame RENAME TO feed_frame_before`
    yield* sql`DROP INDEX feed_frame_channel_seq`
    yield* sql`DROP INDEX feed_frame_received_at`
    yield* sql`
      CREATE TABLE feed_frame (
        seq INTEGER PRIMARY KEY,
        received_at INTEGER NOT NULL,
        sent_at INTEGER,
        source_id INTEGER,
        feed TEXT CHECK (feed IN ('poll', 'fastcast', 'snapshot')),
        channel TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('response', 'message', 'checkpoint', 'unchanged', 'gap')),
        body BLOB,
        body_hash TEXT,
        CHECK ((kind = 'gap') = (feed IS NULL AND channel IS NULL))
      )
    `
    yield* sql`INSERT INTO feed_frame SELECT * FROM feed_frame_before`
    yield* sql`DROP TABLE feed_frame_before`
    yield* sql`CREATE INDEX feed_frame_channel_seq ON feed_frame (channel, seq)`
    yield* sql`CREATE INDEX feed_frame_received_at ON feed_frame (received_at)`
  }),
  // The frame's own words: `feed` becomes `source` (`push` or `poll`), and `kind` is `whole` or `change`.
  "3_frame_source": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE feed_frame RENAME TO feed_frame_before`
    yield* sql`DROP INDEX feed_frame_channel_seq`
    yield* sql`DROP INDEX feed_frame_received_at`
    yield* sql`
      CREATE TABLE feed_frame (
        seq INTEGER PRIMARY KEY,
        received_at INTEGER NOT NULL,
        sent_at INTEGER,
        number INTEGER,
        source TEXT CHECK (source IN ('push', 'poll')),
        channel TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('whole', 'change', 'unchanged', 'gap')),
        body BLOB,
        body_hash TEXT,
        CHECK ((kind = 'gap') = (source IS NULL AND channel IS NULL))
      )
    `
    yield* sql`
      INSERT INTO feed_frame
      SELECT
        seq,
        received_at,
        sent_at,
        source_id,
        CASE feed WHEN 'poll' THEN 'poll' WHEN 'fastcast' THEN 'push' WHEN 'snapshot' THEN 'push' END,
        channel,
        CASE kind WHEN 'response' THEN 'whole' WHEN 'checkpoint' THEN 'whole' WHEN 'message' THEN 'change' ELSE kind END,
        body,
        body_hash
      FROM feed_frame_before
    `
    yield* sql`DROP TABLE feed_frame_before`
    yield* sql`CREATE INDEX feed_frame_channel_seq ON feed_frame (channel, seq)`
    yield* sql`CREATE INDEX feed_frame_received_at ON feed_frame (received_at)`
  })
}

const decodeFrame = Schema.decodeUnknownEffect(LoggedFrame)
