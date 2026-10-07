import { Slate } from "@sportal/domain/Slate"
import {
  Array as Arr,
  type Cause,
  Context,
  Crypto,
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
  type Scope,
  Semaphore,
  Stream
} from "effect"
import { Hex } from "effect/encoding"
import { SqlClient, SqlSchema } from "effect/sql"
import * as Database from "./Database.ts"
import { type FeedFrame, Frame } from "./Frame.ts"
import * as Gzip from "./Gzip.ts"
import { HubConfig } from "./HubConfig.ts"

/**
 * Every frame the feeds delivered, raw, in the order the Hub received it, kept in `feed_frame`. An append numbers a
 * frame and publishes it at once; one writer stores what was appended in batches every 100 ms.
 */
export class FeedLog extends Context.Service<
  FeedLog,
  {
    /** Numbers `frame`, publishes it to subscribers, and queues it to be written. Never waits on disk, never fails. */
    append(frame: FeedFrame): Effect.Effect<Frame>
    /**
     * Subscribes at once, for as long as the scope is open: the stream is every frame appended from then on, in `seq`
     * order, however late it is run.
     */
    readonly subscribe: Effect.Effect<Stream.Stream<Frame>, never, Scope.Scope>
    /**
     * Every logged frame received at or after `from`, in `seq` order, an unchanged poll with its channel's last body.
     * Each topic starts from its latest checkpoint before then: that checkpoint and the topic's frames after it come
     * first, in `seq` order, so a patch after `from` applies to the document it was sent against.
     */
    replay(from: DateTime.Utc): Stream.Stream<Frame>
    /** The game days (YYYY-MM-DD) it has frames received on, each from 04:00 local in the current zone, sorted. */
    readonly days: Effect.Effect<ReadonlyArray<string>, never, DateTime.CurrentTimeZone>
  }
>()("sportal/hub/FeedLog") {
  static readonly layer: Layer.Layer<FeedLog, never, SqlClient.SqlClient | Crypto.Crypto> = Layer.effect(
    FeedLog,
    Effect.gen(function* () {
      yield* Database.migrate("feed", migrations).pipe(Effect.orDie)
      const sql = yield* SqlClient.SqlClient
      const last = yield* lastSeq().pipe(Effect.orDie)
      const intake = {
        next: yield* Ref.make(last + 1),
        permit: yield* Semaphore.make(1),
        published: yield* PubSub.unbounded<Frame>(),
        pending: yield* Queue.unbounded<Frame, Cause.Done>()
      }

      const writer = yield* startWriter(intake.pending)
      // Added after the writer is forked, so it runs first on close: the frames still queued are written before the
      // writer would be interrupted, for at most `shutdownBound`, the feed log's share of the Hub's shutdown bound.
      yield* Effect.addFinalizer(() =>
        Queue.end(intake.pending).pipe(
          Effect.andThen(Fiber.join(writer)),
          Effect.timeout(shutdownBound),
          Effect.catch(() =>
            Effect.logError(
              `FeedLog: the last frames were not written within ${shutdownBound}; they are lost`
            )
          )
        )
      )

      // Uninterruptible, so a seq once assigned is always published and queued; every step is non-blocking.
      const append = Effect.fnUntraced(function* (received: FeedFrame) {
        return yield* intake.permit.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const frame = new Frame({
                ...received,
                seq: yield* Ref.getAndUpdate(intake.next, (seq) => seq + 1)
              })
              yield* PubSub.publish(intake.published, frame)
              yield* Queue.offer(intake.pending, frame)
              return frame
            })
          )
        )
      })

      return FeedLog.of({
        append,
        subscribe: Effect.map(PubSub.subscribe(intake.published), Stream.fromSubscription),
        replay: (from) => replay(from).pipe(Stream.provideService(SqlClient.SqlClient, sql)),
        days: days.pipe(Effect.provideService(SqlClient.SqlClient, sql))
      })
    })
  )

  /** On `feed.sqlite` in the data directory, its own client. */
  static readonly inDataDir: Layer.Layer<
    FeedLog,
    never,
    HubConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  > = FeedLog.layer.pipe(Layer.provide(Database.layerFile("feed.sqlite")), Layer.orDie)

  /**
   * A scenario's feed log: in memory, or on the file `SPORTAL_SCENARIO_FEED_LOG` names in the data directory. Never on
   * the game day's `feed.sqlite`.
   */
  static readonly forScenario: Layer.Layer<
    FeedLog,
    never,
    HubConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  > = Layer.unwrap(
    Effect.gen(function* () {
      const { scenarioFeedLog } = yield* HubConfig
      return FeedLog.layer.pipe(
        Layer.provide(
          Option.match(scenarioFeedLog, {
            onNone: () => Database.layerMemory,
            onSome: (name) => Database.layerFile(name)
          })
        ),
        Layer.orDie
      )
    })
  )
}

const shutdownBound = "1 second"
const pageSize = 512

function lastSeq() {
  return Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ seq: Schema.NullOr(Schema.Int) }),
      execute: () => sql`SELECT MAX(seq) AS seq FROM feed_frame`
    })().pipe(Effect.map(({ seq }) => seq ?? 0))
  )
}

/** Writes what `pending` yields in groups every 100 ms, until it ends; the gap of any frames lost is then logged. */
function startWriter(pending: Queue.Queue<Frame, Cause.Done>) {
  return Effect.gen(function* () {
    // Each poll channel's last stored hash, so an unchanged response after a restart is still known as one.
    const hashes = yield* lastHashes().pipe(Effect.orDie)
    const state = yield* Ref.make<Writer>(Writer.Current({ hashes }))
    return yield* Stream.fromQueue(pending).pipe(
      Stream.groupedWithin(512, "100 millis"),
      Stream.runForEach((group) =>
        Arr.isReadonlyArrayNonEmpty(group)
          ? Ref.get(state).pipe(
              Effect.flatMap((current) => write(current, group)),
              Effect.flatMap((next) => Ref.set(state, next))
            )
          : Effect.void
      ),
      Effect.andThen(closeGap(state)),
      Effect.forkScoped
    )
  })
}

function lastHashes() {
  return Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ channel: Schema.String, body_hash: Schema.String }),
      execute: () => sql`
        SELECT channel, body_hash FROM feed_frame WHERE seq IN (
          SELECT MAX(seq) FROM feed_frame
          WHERE feed = 'poll' AND kind IN ('response', 'unchanged') GROUP BY channel
        )
      `
    })().pipe(Effect.map((rows) => new Map(rows.map(({ channel, body_hash }) => [channel, body_hash]))))
  )
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

// A group that cannot be written is lost, and the writer is behind until the next group is written after a gap.
function write(state: Writer, group: Arr.NonEmptyReadonlyArray<Frame>) {
  return store(state, group).pipe(
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
}

// Writes `group` in one transaction, after a gap row if frames were lost before it.
const store = Effect.fn("FeedLog.store")(function* (state: Writer, group: ReadonlyArray<Frame>) {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const hashed = yield* Effect.forEach(group, (frame) =>
    Effect.all([
      Schema.encodeEffect(Row)(frame),
      crypto.digest("SHA-256", new TextEncoder().encode(frame.body)).pipe(Effect.map(Hex.encode))
    ]).pipe(Effect.map(([row, hash]) => ({ frame, row, hash })))
  )
  const [hashes, decided] = Arr.mapAccum(hashed, state.hashes, (seen, { frame, row, hash }) => {
    const response = Frame.isPollResponse(frame)
    const unchanged = response && seen.get(frame.channel) === hash
    return [
      response ? new Map(seen).set(frame.channel, hash) : seen,
      {
        row: { ...row, kind: unchanged ? "unchanged" : row.kind, body_hash: hash },
        body: frame.body,
        unchanged
      }
    ] as const
  })
  const rows = yield* Effect.forEach(decided, ({ row, body, unchanged }) =>
    Effect.map(unchanged ? Effect.succeed(null) : Gzip.compress(body), (compressed) => ({
      ...row,
      body: compressed
    }))
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

// Frames lost with no later group to carry their gap row are recorded on their own, as the stream ends.
function closeGap(state: Ref.Ref<Writer>) {
  return Ref.get(state).pipe(
    Effect.flatMap((writer) =>
      Writer.$match(writer, {
        Current: () => Effect.void,
        Behind: (behind) =>
          Effect.all([SqlClient.SqlClient, gapRow(behind)]).pipe(
            Effect.flatMap(([sql, row]) =>
              sql.withTransaction(sql`INSERT INTO feed_frame ${sql.insert(row)}`)
            ),
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

function replay(from: DateTime.Utc) {
  return Stream.unwrap(
    Effect.map(firstAt(DateTime.toEpochMillis(from)), (seq) =>
      seq === null
        ? Stream.empty
        : Stream.fromIterableEffect(lookback(seq)).pipe(
            Stream.concat(
              Stream.paginate(seq - 1, (after) =>
                Effect.map(page(after), (rows) => [
                  rows,
                  rows.length < pageSize ? Option.none() : Option.map(Arr.last(rows), (row) => row.seq)
                ])
              )
            )
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
                  : yield* Gzip.decompress(stored.body, "gzip")
              const frame = yield* Schema.decodeEffect(Row)({
                ...stored,
                kind: stored.kind === "unchanged" ? "response" : stored.kind,
                body
              })
              return [
                Frame.isPollResponse(frame) ? new Map(bodies).set(frame.channel, body) : bodies,
                [frame]
              ] as const
            })
    ),
    // A row the log wrote and cannot read back is a defect, not something a replay could go on past.
    Stream.orDie
  )
}

function firstAt(receivedAt: number) {
  return Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOne({
      Request: Schema.Int,
      Result: Schema.Struct({ seq: Schema.NullOr(Schema.Int) }),
      execute: (at) => sql`SELECT MIN(seq) AS seq FROM feed_frame WHERE received_at >= ${at}`
    })(receivedAt).pipe(Effect.map(({ seq }) => seq))
  )
}

// Each topic's latest checkpoint before `first`, and that topic's frames after it and before `first`.
function lookback(first: number) {
  return Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findAll({
      Request: Schema.Int,
      Result: Stored,
      execute: (before) => sql`
        SELECT ${sql.csv(storedColumns)}
        FROM feed_frame JOIN (
          SELECT channel AS topic, MAX(seq) AS since FROM feed_frame
          WHERE kind = 'checkpoint' AND seq < ${before} GROUP BY channel
        ) ON channel = topic AND seq >= since
        WHERE seq < ${before} ORDER BY seq
      `
    })(first)
  )
}

function page(after: number) {
  return Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findAll({
      Request: Schema.Int,
      Result: Stored,
      execute: (seq) => sql`
        SELECT ${sql.csv(storedColumns)} FROM feed_frame WHERE seq > ${seq} ORDER BY seq LIMIT ${pageSize}
      `
    })(after)
  )
}

// The body an unchanged poll repeats: its channel's last one in this replay, or else the last one stored.
function repeated(bodies: ReadonlyMap<string, string>, channel: string, seq: number) {
  return Option.match(Option.fromNullishOr(bodies.get(channel)), {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        SqlSchema.findOne({
          Request: Schema.Void,
          Result: Schema.Struct({ body: Schema.Uint8Array }),
          execute: () => sql`
            SELECT body FROM feed_frame WHERE channel = ${channel} AND kind = 'response' AND seq < ${seq}
            ORDER BY seq DESC LIMIT 1
          `
        })()
      ).pipe(Effect.flatMap(({ body }) => Gzip.decompress(body, "gzip")))
  })
}

function warnOfGap(body: Uint8Array) {
  return Gzip.decompress(body, "gzip").pipe(
    Effect.flatMap(Schema.decodeEffect(Gap)),
    Effect.flatMap((gap) =>
      Effect.logWarning(
        `FeedLog: replay passes ${gap.count} frames that were never written (seq ${gap.from} to ${gap.to})`
      ).pipe(Effect.annotateLogs(gap))
    )
  )
}

// Skips from one game day to the next through the received_at index: one query a day, never a scan of the frames.
const days = Effect.gen(function* () {
  const zone = yield* DateTime.CurrentTimeZone
  return yield* Stream.paginate(0, (after) =>
    Effect.map(firstReceived(after), (received) =>
      Option.match(Option.fromNullishOr(received), {
        onNone: () => [[], Option.none()] as const,
        onSome: (millis) => {
          const start = DateTime.setZone(
            Slate.dayStart(DateTime.makeZonedUnsafe(millis, { timeZone: zone })),
            zone
          )
          return [
            [DateTime.formatIsoDate(start)],
            Option.some(DateTime.toEpochMillis(Slate.dayStart(DateTime.add(start, { days: 1 }))))
          ] as const
        }
      })
    )
  ).pipe(Stream.runCollect)
}).pipe(Effect.orDie)

function firstReceived(atOrAfter: number) {
  return Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOne({
      Request: Schema.Int,
      Result: Schema.Struct({ received: Schema.NullOr(Schema.Int) }),
      execute: (at) =>
        sql`SELECT MIN(received_at) AS received FROM feed_frame WHERE received_at >= ${at} AND kind != 'gap'`
    })(atOrAfter).pipe(Effect.map(({ received }) => received))
  )
}

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
  Schema.Struct({ seq: Frame.fields.seq, kind: Schema.Literal("gap"), body: Schema.Uint8Array }),
  Schema.Struct({
    seq: Frame.fields.seq,
    received_at: Schema.Int,
    sent_at: Schema.NullOr(Schema.Int),
    source_id: Schema.NullOr(Schema.Int),
    feed: Frame.fields.feed,
    channel: Frame.fields.channel,
    kind: Schema.Union([Frame.fields.kind, Schema.Literal("unchanged")]),
    body: Schema.NullOr(Schema.Uint8Array)
  })
])
const storedColumns = ["seq", "received_at", "sent_at", "source_id", "feed", "channel", "kind", "body"]

/** What a gap row's body holds: the `seq` range and number of frames a failed write lost. */
const Gap = Schema.fromJsonString(Schema.Struct({ from: Schema.Int, to: Schema.Int, count: Schema.Int }))

/**
 * The row that stands in `feed_frame` for the frames a failed write lost, at the last lost `seq`, so a log reopened
 * after it continues past them.
 */
function gapRow({ from, to, count, receivedAt }: Extract<Writer, { _tag: "Behind" }>) {
  return Schema.encodeEffect(Gap)({ from, to, count }).pipe(
    Effect.flatMap(Gzip.compress),
    Effect.map((body) => ({
      seq: to,
      received_at: DateTime.toEpochMillis(receivedAt),
      sent_at: null,
      source_id: null,
      feed: null,
      channel: null,
      kind: "gap",
      body,
      body_hash: null
    }))
  )
}

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
