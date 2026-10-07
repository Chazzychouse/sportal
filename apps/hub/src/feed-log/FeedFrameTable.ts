import { type Data, DateTime, Effect, Schema } from "effect"
import { Model } from "effect/schema"
import { SqlClient, SqlSchema } from "effect/sql"
import { Frame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"
import type { Writer } from "./FeedLogWriter.ts"

/**
 * A row of `feed_frame`: a frame with its body gzip'd, or with no body for an unchanged poll (a poll response that
 * repeats its channel's last), or the gap a failed write left. Only a gap has no feed or channel.
 */
export class FeedFrameRow extends Model.Class<FeedFrameRow>("sportal/hub/feed-log/FeedFrameRow")({
  seq: Schema.Int,
  received_at: Schema.Int,
  sent_at: Schema.NullOr(Schema.Int),
  source_id: Schema.NullOr(Schema.Int),
  feed: Schema.NullOr(Frame.fields.feed),
  channel: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["response", "message", "checkpoint", "unchanged", "gap"]),
  body: Schema.NullOr(Schema.Uint8Array),
  body_hash: Schema.NullOr(Schema.String)
}) {
  static readonly columns = Object.keys(FeedFrameRow.fields)

  /** The frame a row other than a gap holds, its body read as `body`; an unchanged poll reads as a response. */
  static frame(row: FeedFrameRow, body: string): Effect.Effect<Frame, Schema.SchemaError> {
    return decodeFrame({
      seq: row.seq,
      receivedAt: row.received_at,
      ...(row.sent_at === null ? {} : { sentAt: row.sent_at }),
      ...(row.source_id === null ? {} : { sourceId: row.source_id }),
      feed: row.feed,
      channel: row.channel,
      kind: row.kind === "unchanged" ? "response" : row.kind,
      body
    })
  }

  /** `frame`'s row, hashed `hash`, its body gzip'd as `body`, or none when it is an `unchanged` poll. */
  static of(frame: Frame, hash: string, body: Uint8Array | null, unchanged: boolean): FeedFrameRow {
    return new FeedFrameRow({
      seq: frame.seq,
      received_at: DateTime.toEpochMillis(frame.receivedAt),
      sent_at: frame.sentAt === undefined ? null : DateTime.toEpochMillis(frame.sentAt),
      source_id: frame.sourceId ?? null,
      feed: frame.feed,
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
  static gap({ from, to, count, receivedAt }: Data.TaggedEnum.Value<Writer, "Behind">) {
    return Schema.encodeEffect(Gap)({ from, to, count }).pipe(
      Effect.flatMap(Gzip.compress),
      Effect.map(
        (body) =>
          new FeedFrameRow({
            seq: to,
            received_at: DateTime.toEpochMillis(receivedAt),
            sent_at: null,
            source_id: null,
            feed: null,
            channel: null,
            kind: "gap",
            body,
            body_hash: null
          })
      )
    )
  }
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
          WHERE feed = 'poll' AND kind IN ('response', 'unchanged') GROUP BY channel
        )
      `
    }),
    firstAt: SqlSchema.findOne({
      Request: Schema.Int,
      Result: Schema.Struct({ seq: Schema.NullOr(Schema.Int) }),
      execute: (at) => sql`SELECT MIN(seq) AS seq FROM feed_frame WHERE received_at >= ${at}`
    }),
    // Each topic's latest checkpoint before `before`, and that topic's frames after it and before `before`.
    lookback: SqlSchema.findAll({
      Request: Schema.Int,
      Result: FeedFrameRow,
      execute: (before) => sql`
        SELECT ${sql.csv(FeedFrameRow.columns)}
        FROM feed_frame JOIN (
          SELECT channel AS topic, MAX(seq) AS since FROM feed_frame
          WHERE kind = 'checkpoint' AND seq < ${before} GROUP BY channel
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
        SELECT body FROM feed_frame WHERE channel = ${channel} AND kind = 'response' AND seq < ${seq}
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
  })
}

const decodeFrame = Schema.decodeUnknownEffect(Frame)
