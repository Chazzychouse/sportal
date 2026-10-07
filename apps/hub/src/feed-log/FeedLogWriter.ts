import {
  Array as Arr,
  type Cause,
  Crypto,
  Data,
  type DateTime,
  Effect,
  Metric,
  type Queue,
  Ref,
  Schema,
  Stream
} from "effect"
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import { Frame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"
import { FeedFrameRow, type queries } from "./FeedFrameTable.ts"

/** Where the writer is: every group so far written, or behind by the frames failed writes lost. */
export type Writer = Data.TaggedEnum<{
  Current: { readonly hashes: ReadonlyMap<string, string> }
  Behind: {
    readonly hashes: ReadonlyMap<string, string>
    readonly from: number
    readonly to: number
    readonly count: number
    readonly receivedAt: DateTime.Utc
  }
}>
export const Writer = Data.taggedEnum<Writer>()

/**
 * Forks the one writer: it writes what `pending` yields in groups every 100 ms, until it ends; the gap of any frames
 * lost is then logged.
 */
export const start = Effect.fn("FeedLog.writer")(function* (
  pending: Queue.Queue<Frame, Cause.Done>,
  table: ReturnType<typeof queries>
) {
  const stored = yield* table.lastHashes().pipe(Effect.orDie)
  const hashes = new Map(stored.map(({ channel, body_hash }) => [channel, body_hash]))
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

// A group that cannot be written is lost, and the writer is behind until the next group is written after a gap.
const write = Effect.fnUntraced(function* (state: Writer, group: Arr.NonEmptyReadonlyArray<Frame>) {
  return yield* store(state, group).pipe(
    Effect.catch((error) =>
      Effect.logError(
        `FeedLog: could not write ${group.length} frames; they are lost, and a gap is logged in their place`,
        error
      ).pipe(
        Effect.andThen(Metric.update(writeFailures, 1)),
        Effect.andThen(Metric.update(framesLost, group.length)),
        Effect.as(behindBy(state, group))
      )
    )
  )
})

// Writes `group` in one transaction, after a gap row if frames were lost before it.
const store = Effect.fn("FeedLog.store")(function* (state: Writer, group: ReadonlyArray<Frame>) {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto

  const hashed = yield* Effect.forEach(group, (frame) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(frame.body))
      .pipe(Effect.map((digest) => ({ frame, hash: Hex.encode(digest) })))
  )
  const [hashes, decided] = Arr.mapAccum(hashed, state.hashes, (seen, { frame, hash }) => {
    const response = Frame.isPollResponse(frame)
    const unchanged = response && seen.get(frame.channel) === hash
    return [response ? new Map(seen).set(frame.channel, hash) : seen, { frame, hash, unchanged }] as const
  })
  const rows = yield* Effect.forEach(decided, ({ frame, hash, unchanged }) =>
    Effect.map(unchanged ? Effect.succeed(null) : Gzip.compress(frame.body), (body) => ({
      feed: frame.feed,
      row: FeedFrameRow.of(frame, hash, body, unchanged)
    }))
  )
  const gap = yield* Writer.$match(state, {
    Current: () => Effect.succeed([]),
    Behind: (behind) => Effect.map(FeedFrameRow.gap(behind), (row) => [row])
  })
  const encoded = yield* Effect.forEach([...gap, ...rows.map(({ row }) => row)], (row) => encodeRow(row))

  yield* sql
    .withTransaction(sql`INSERT INTO feed_frame ${sql.insert(encoded)}`)
    .pipe(Effect.trackDuration(writeDuration))
  yield* Effect.forEach(
    rows,
    ({ feed, row }) => Metric.update(Metric.withAttributes(framesWritten, { feed, kind: row.kind }), 1),
    { discard: true }
  )

  return Writer.Current({ hashes })
})

function behindBy(state: Writer, group: Arr.NonEmptyReadonlyArray<Frame>) {
  return Writer.$match(state, {
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
}

// Frames lost with no later group to carry their gap row are recorded on their own, as the stream ends.
const closeGap = Effect.fnUntraced(function* (state: Ref.Ref<Writer>) {
  const writer = yield* Ref.get(state)

  yield* Writer.$match(writer, {
    Current: () => Effect.void,
    Behind: (behind) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const row = yield* FeedFrameRow.gap(behind)
        const encoded = yield* encodeRow(row)
        yield* sql.withTransaction(sql`INSERT INTO feed_frame ${sql.insert(encoded)}`)
      }).pipe(
        Effect.catch((error) =>
          Effect.logError(
            `FeedLog: ${behind.count} frames were lost (seq ${behind.from} to ${behind.to}) and their gap could not be logged`,
            error
          )
        )
      )
  })
})

const encodeRow = Schema.encodeEffect(FeedFrameRow.insert)

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
