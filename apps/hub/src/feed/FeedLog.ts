import {
  Array as Arr,
  Cause,
  Context,
  Data,
  DateTime,
  Effect,
  Fiber,
  type FileSystem,
  Layer,
  Metric,
  Option,
  type Path,
  PubSub,
  Queue,
  Ref,
  Schema,
  SchemaTransformation,
  Semaphore,
  Stream
} from "effect"
import { Hex } from "effect/encoding"
import { SqlClient, SqlSchema } from "effect/sql"
import * as Database from "../database/Database.ts"
import type { HubConfig } from "../HubConfig.ts"
import { Frame } from "./Frame.ts"

/**
 * Every frame the feeds delivered, raw, in the order the Hub received it, kept in `feed_frame`. An append numbers a
 * frame and publishes it at once; one writer stores what was appended in batches every 100 ms.
 */
export class FeedLog extends Context.Service<
  FeedLog,
  {
    /** Numbers `frame`, publishes it to `frames`, and queues it to be written. Never waits on disk, never fails. */
    append(frame: Omit<Frame, "seq">): Effect.Effect<Frame>
    /** Every frame appended from now on, in `seq` order. */
    readonly frames: Stream.Stream<Frame>
    /** Every logged frame received at or after `from`, in `seq` order, an unchanged poll with its channel's last body. */
    replay(from: DateTime.Utc): Stream.Stream<Frame>
  }
>()("sportal/hub/FeedLog") {
  static readonly layer: Layer.Layer<FeedLog, never, SqlClient.SqlClient> = Layer.effect(
    FeedLog,
    Effect.gen(function* () {
      yield* Database.migrate("feed", migrations).pipe(Effect.orDie)
      const sql = yield* SqlClient.SqlClient

      const last = yield* SqlSchema.findOne({
        Request: Schema.Void,
        Result: Schema.Struct({ seq: Schema.NullOr(Schema.Int) }),
        execute: () => sql`SELECT MAX(seq) AS seq FROM feed_frame`
      })().pipe(Effect.orDie)
      // Each poll channel's last stored hash, so an unchanged response after a restart is still known as one.
      const polled = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ channel: Schema.String, body_hash: Schema.String }),
        execute: () => sql`
          SELECT channel, body_hash FROM feed_frame WHERE seq IN (
            SELECT MAX(seq) FROM feed_frame
            WHERE feed = 'poll' AND kind IN ('response', 'unchanged') GROUP BY channel
          )
        `
      })().pipe(Effect.orDie)

      const next = yield* Ref.make((last.seq ?? 0) + 1)
      const permit = yield* Semaphore.make(1)
      const published = yield* PubSub.unbounded<Frame>()
      const pending = yield* Queue.unbounded<Frame, Cause.Done>()

      // Uninterruptible, so a seq once assigned is always published and queued; every step is non-blocking.
      const append = Effect.fn("FeedLog.append")((received: Omit<Frame, "seq">) =>
        permit.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const frame = new Frame({ ...received, seq: yield* Ref.getAndUpdate(next, (seq) => seq + 1) })
              yield* PubSub.publish(published, frame)
              yield* Queue.offer(pending, frame)
              return frame
            })
          )
        )
      )

      // Writes `group` in one transaction, after a gap row if frames were lost before it.
      const store = Effect.fn("FeedLog.store")(function* (state: Writer, group: ReadonlyArray<Frame>) {
        const hashed = yield* Effect.forEach(group, (frame) =>
          Effect.gen(function* () {
            const bytes = new TextEncoder().encode(frame.body)
            return { row: yield* Schema.encodeEffect(Row)(frame), bytes, hash: yield* sha256(bytes) }
          })
        )
        const [hashes, decided] = Arr.mapAccum(hashed, state.hashes, (seen, { row, bytes, hash }) => {
          const response = row.feed === "poll" && row.kind === "response"
          const unchanged = response && seen.get(row.channel) === hash
          return [
            response ? new Map(seen).set(row.channel, hash) : seen,
            { row: { ...row, kind: unchanged ? "unchanged" : row.kind, body_hash: hash }, bytes, unchanged }
          ] as const
        })
        const rows = yield* Effect.forEach(decided, ({ row, bytes, unchanged }) =>
          Effect.gen(function* () {
            return { ...row, body: unchanged ? null : yield* gzip(bytes) }
          })
        )
        const gap = yield* Writer.$match(state, {
          Current: () => Effect.succeed([]),
          Behind: (behind) => Effect.map(gapRow(behind), (row) => [row])
        })
        yield* sql
          .withTransaction(sql`INSERT INTO feed_frame ${sql.insert([...gap, ...rows])}`)
          .pipe(Effect.trackDuration(writeDuration))
        yield* Effect.forEach(
          rows,
          ({ feed, kind }) => Metric.update(Metric.withAttributes(framesWritten, { feed, kind }), 1),
          { discard: true }
        )
        return Writer.Current({ hashes })
      })

      // A group that cannot be written is lost, and the writer is behind until the next group is written after a gap.
      const write = (state: Writer, group: Arr.NonEmptyReadonlyArray<Frame>) =>
        store(state, group).pipe(
          Effect.catch((error) =>
            Effect.logError(
              `FeedLog: could not write ${group.length} frames; they are lost, and a gap is logged in their place`,
              error
            ).pipe(
              Effect.andThen(Metric.update(writeFailures, 1)),
              Effect.andThen(Metric.update(framesLost, group.length)),
              Effect.as(
                Writer.$match(state, {
                  Current: ({ hashes }) =>
                    Writer.Behind({
                      hashes,
                      from: Arr.headNonEmpty(group).seq,
                      to: Arr.lastNonEmpty(group).seq,
                      count: group.length,
                      receivedAt: Arr.headNonEmpty(group).receivedAt
                    }),
                  Behind: (behind) =>
                    Writer.Behind({
                      ...behind,
                      to: Arr.lastNonEmpty(group).seq,
                      count: behind.count + group.length
                    })
                })
              )
            )
          )
        )

      const state = yield* Ref.make<Writer>(
        Writer.Current({ hashes: new Map(polled.map(({ channel, body_hash }) => [channel, body_hash])) })
      )

      // Frames lost with no later group to carry their gap row are recorded on their own, as the stream ends.
      const closeGap = Ref.get(state).pipe(
        Effect.flatMap((writer) =>
          Writer.$match(writer, {
            Current: () => Effect.void,
            Behind: (behind) =>
              gapRow(behind).pipe(
                Effect.flatMap((row) => sql.withTransaction(sql`INSERT INTO feed_frame ${sql.insert(row)}`)),
                Effect.catch((error) =>
                  Effect.logError(
                    `FeedLog: ${behind.count} frames were lost (seq ${behind.from} to ${behind.to}) and their gap could not be logged`,
                    error
                  )
                )
              )
          })
        )
      )

      const writer = yield* Stream.fromQueue(pending).pipe(
        Stream.groupedWithin(512, "100 millis"),
        Stream.runForEach((group) =>
          Arr.isReadonlyArrayNonEmpty(group)
            ? Ref.get(state).pipe(
                Effect.flatMap((current) => write(current, group)),
                Effect.flatMap((next) => Ref.set(state, next))
              )
            : Effect.void
        ),
        Effect.andThen(closeGap),
        Effect.forkScoped
      )
      // Added after the writer is forked, so it runs first on close: the frames still queued are written before the
      // writer would be interrupted, as long as that fits the Hub's shutdown bound.
      yield* Effect.addFinalizer(() =>
        Queue.end(pending).pipe(
          Effect.andThen(Fiber.join(writer)),
          Effect.timeout(shutdownBound),
          Effect.catch(() =>
            Effect.logError(
              `FeedLog: the last frames were not written within ${shutdownBound}; they are lost`
            )
          )
        )
      )

      const firstAt = SqlSchema.findOne({
        Request: Schema.Int,
        Result: Schema.Struct({ seq: Schema.NullOr(Schema.Int) }),
        execute: (receivedAt) =>
          sql`SELECT MIN(seq) AS seq FROM feed_frame WHERE received_at >= ${receivedAt}`
      })
      const page = SqlSchema.findAll({
        Request: Schema.Int,
        Result: Stored,
        execute: (after) => sql`
          SELECT seq, received_at, sent_at, source_id, feed, channel, kind, body
          FROM feed_frame WHERE seq > ${after} ORDER BY seq LIMIT ${pageSize}
        `
      })
      const lastResponse = SqlSchema.findOne({
        Request: Schema.Struct({ channel: Schema.String, before: Schema.Int }),
        Result: Schema.Struct({ body: Schema.Uint8Array }),
        execute: ({ channel, before }) => sql`
          SELECT body FROM feed_frame WHERE channel = ${channel} AND kind = 'response' AND seq < ${before}
          ORDER BY seq DESC LIMIT 1
        `
      })

      // The body an unchanged poll repeats: its channel's last one in this replay, or else the last one stored.
      const repeated = (bodies: ReadonlyMap<string, string>, channel: string, seq: number) =>
        Option.match(Option.fromNullishOr(bodies.get(channel)), {
          onSome: Effect.succeed,
          onNone: () =>
            lastResponse({ channel, before: seq }).pipe(Effect.flatMap(({ body }) => gunzip(body)))
        })

      const replay = (from: DateTime.Utc) =>
        Stream.unwrap(
          Effect.map(firstAt(DateTime.toEpochMillis(from)), ({ seq }) =>
            seq === null
              ? Stream.empty
              : Stream.paginate(seq - 1, (after) =>
                  Effect.map(page(after), (rows) => [
                    rows,
                    rows.length < pageSize ? Option.none() : Option.map(Arr.last(rows), (row) => row.seq)
                  ])
                )
          )
        ).pipe(
          Stream.mapAccumEffect(
            (): ReadonlyMap<string, string> => new Map(),
            (bodies, stored) =>
              stored.kind === "gap"
                ? warnOfGap(stored.body).pipe(Effect.as([bodies, []] as const))
                : Effect.gen(function* () {
                    const body =
                      stored.body === null
                        ? yield* repeated(bodies, stored.channel, stored.seq)
                        : yield* gunzip(stored.body)
                    const frame = yield* Schema.decodeEffect(Row)({
                      ...stored,
                      kind: stored.kind === "unchanged" ? "response" : stored.kind,
                      body
                    })
                    const isPoll = frame.feed === "poll" && frame.kind === "response"
                    return [isPoll ? new Map(bodies).set(frame.channel, body) : bodies, [frame]] as const
                  })
          ),
          // A row the log wrote and cannot read back is a defect, not something a replay could go on past.
          Stream.orDie
        )

      return FeedLog.of({ append, frames: Stream.fromPubSub(published), replay })
    })
  )

  /** On `feed.sqlite` in the data directory, its own client so it never shares `sportal.sqlite`'s. */
  static readonly inDataDir: Layer.Layer<FeedLog, never, HubConfig | FileSystem.FileSystem | Path.Path> =
    FeedLog.layer.pipe(Layer.provide(Database.fileInDataDir("feed.sqlite")), Layer.orDie)
}

/** Where the writer is: every group so far written, or behind by the frames failed writes lost. */
type Writer = Data.TaggedEnum<{
  Current: { readonly hashes: ReadonlyMap<string, string> }
  Behind: {
    readonly hashes: ReadonlyMap<string, string>
    readonly from: number
    readonly to: number
    readonly count: number
    readonly receivedAt: DateTime.Utc
  }
}>
const Writer = Data.taggedEnum<Writer>()

const shutdownBound = "3 seconds"
const pageSize = 512

/** A frame as `feed_frame` keeps it, its body still raw. */
const Row = Schema.Struct({
  ...Frame.fields,
  sentAt: absentWhenNull(Schema.DateTimeUtcFromMillis),
  sourceId: absentWhenNull(Schema.Int)
}).pipe(
  Schema.encodeKeys({ receivedAt: "received_at", sentAt: "sent_at", sourceId: "source_id" }),
  Schema.decodeTo(
    Schema.toType(Frame),
    SchemaTransformation.transform({ decode: (fields) => new Frame(fields), encode: (frame) => frame })
  )
)

/** A row of `feed_frame` as read back: a frame, gzip'd or unchanged, or a gap. */
const Stored = Schema.Union([
  Schema.Struct({ seq: Schema.Int, kind: Schema.Literal("gap"), body: Schema.Uint8Array }),
  Schema.Struct({
    seq: Schema.Int,
    received_at: Schema.Int,
    sent_at: Schema.NullOr(Schema.Int),
    source_id: Schema.NullOr(Schema.Int),
    feed: Schema.Literals(["poll", "fastcast"]),
    channel: Schema.String,
    kind: Schema.Literals(["response", "unchanged", "message", "checkpoint"]),
    body: Schema.NullOr(Schema.Uint8Array)
  })
])

/** This log's migrations, recorded in `feed_migrations`. */
const migrations = {
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
  })
}

const framesWritten = Metric.counter("sportal_feed_frames", {
  description: "Frames written to the feed log, by feed and by how they were stored",
  incremental: true
})

const writeDuration = Metric.timer("sportal_feed_write_duration", {
  description: "How long writing one batch of frames to the feed log takes"
})

const writeFailures = Metric.counter("sportal_feed_write_failures", {
  description: "Batches of frames the feed log could not write",
  incremental: true
})

const framesLost = Metric.counter("sportal_feed_frames_lost", {
  description: "Frames appended to the feed log and never written, each a part of a gap",
  incremental: true
})

// A nullable column as an optional field: null reads as absent, absent writes as null.
function absentWhenNull<S extends Schema.Top>(schema: S) {
  return Schema.NullOr(schema).pipe(
    Schema.decodeTo(
      Schema.optional(Schema.toType(schema)),
      SchemaTransformation.transformOptional<S["Type"] | undefined, S["Type"] | null>({
        decode: (value) => Option.filter(value, (present): present is S["Type"] => present !== null),
        encode: (value) =>
          Option.some(
            Option.getOrElse(
              Option.filter(value, (present): present is S["Type"] => present !== undefined),
              () => null
            )
          )
      })
    )
  )
}

/** The row that stands in `feed_frame` for the frames a failed write lost. */
function gapRow({ from, to, count, receivedAt }: Extract<Writer, { _tag: "Behind" }>) {
  return Effect.map(gzip(new TextEncoder().encode(JSON.stringify({ from, to, count }))), (body) => ({
    seq: from,
    received_at: DateTime.toEpochMillis(receivedAt),
    sent_at: null,
    source_id: null,
    feed: null,
    channel: null,
    kind: "gap",
    body,
    body_hash: null
  }))
}

function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return Effect.map(
    Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", bytes),
      catch: (cause) => new Cause.UnknownError(cause, "A feed log body could not be hashed")
    }),
    (digest) => Hex.encode(new Uint8Array(digest))
  )
}

function gzip(bytes: Uint8Array) {
  return Stream.mkUint8Array(through(bytes, () => new CompressionStream("gzip")))
}

function gunzip(bytes: Uint8Array) {
  return through(bytes, () => new DecompressionStream("gzip")).pipe(Stream.decodeText, Stream.mkString)
}

function through(bytes: Uint8Array, transform: () => CompressionStream | DecompressionStream) {
  return Stream.fromReadableStream({
    evaluate: () => Stream.toReadableStream(Stream.make(bytes)).pipeThrough(transform()),
    onError: (cause) => new Cause.UnknownError(cause, "A feed log body could not be gzip'd or read back")
  })
}

function warnOfGap(body: Uint8Array) {
  return gunzip(body).pipe(
    Effect.flatMap(
      Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ from: Schema.Int, to: Schema.Int, count: Schema.Int }))
      )
    ),
    Effect.flatMap((gap) =>
      Effect.logWarning(
        `FeedLog: replay passes ${gap.count} frames that were never written (seq ${gap.from} to ${gap.to})`
      ).pipe(Effect.annotateLogs(gap))
    )
  )
}
