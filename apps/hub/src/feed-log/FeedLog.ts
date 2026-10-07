import { Slate } from "@sportal/domain/Slate"
import {
  Array as Arr,
  type Cause,
  Context,
  type Crypto,
  DateTime,
  Effect,
  Fiber,
  type FileSystem,
  Layer,
  Option,
  type Path,
  PubSub,
  Queue,
  Ref,
  Schema,
  type Scope,
  Semaphore,
  Stream
} from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../Database.ts"
import { type FeedFrame, Frame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"
import type { HubConfig } from "../HubConfig.ts"
import { FeedFrameRow, Gap, migrations, queries } from "./FeedFrameTable.ts"
import * as FeedLogWriter from "./FeedLogWriter.ts"

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
>()("sportal/hub/feed-log/FeedLog") {
  static readonly layer: Layer.Layer<FeedLog, never, SqlClient.SqlClient | Crypto.Crypto> = Layer.effect(
    FeedLog,
    Effect.gen(function* () {
      yield* Database.migrate("feed", migrations).pipe(Effect.orDie)
      const sql = yield* SqlClient.SqlClient
      const table = queries(sql)
      const last = yield* table.lastSeq().pipe(Effect.orDie)
      const next = yield* Ref.make((last.seq ?? 0) + 1)
      const permit = yield* Semaphore.make(1)
      const published = yield* PubSub.unbounded<Frame>()
      const pending = yield* Queue.unbounded<Frame, Cause.Done>()

      const writer = yield* FeedLogWriter.start(pending, table)
      // Added after the writer is forked, so it runs first on close: the frames still queued are written before the
      // writer would be interrupted, for at most `shutdownBound`, the feed log's share of the Hub's shutdown bound.
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

      // Uninterruptible, so a seq once assigned is always published and queued; every step is non-blocking.
      const append = Effect.fnUntraced(function* (received: FeedFrame) {
        return yield* permit.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const seq = yield* Ref.getAndUpdate(next, (seq) => seq + 1)
              const frame = new Frame({ ...received, seq })
              yield* PubSub.publish(published, frame)
              yield* Queue.offer(pending, frame)
              return frame
            })
          )
        )
      })

      return FeedLog.of({
        append,
        subscribe: Effect.map(PubSub.subscribe(published), Stream.fromSubscription),
        replay: (from) => replay(table, from),
        days: days(table)
      })
    })
  )

  /** On `feed.sqlite` in the data directory, its own client. */
  static readonly layerInDataDir: Layer.Layer<
    FeedLog,
    never,
    HubConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  > = FeedLog.layer.pipe(Layer.provide(Database.layerFile("feed.sqlite")), Layer.orDie)

  /** In memory, its own client. */
  static readonly layerMemory: Layer.Layer<FeedLog, never, Crypto.Crypto> = FeedLog.layer.pipe(
    Layer.provide(Database.layerMemory),
    Layer.orDie
  )

  /**
   * The feed log on the provided database, once `frames` are appended in order through a log of their own and that log
   * is closed, so every one is written before the layer is built, and a later log on the same database has them too.
   */
  static layerTest(
    frames: ReadonlyArray<FeedFrame>
  ): Layer.Layer<FeedLog, never, SqlClient.SqlClient | Crypto.Crypto> {
    const logged = FeedLog.use((log) => Effect.forEach(frames, log.append, { discard: true })).pipe(
      Effect.provide(FeedLog.layer),
      Effect.scoped
    )
    return FeedLog.layer.pipe(Layer.provide(Layer.effectDiscard(logged)))
  }
}

const shutdownBound = "1 second"
const pageSize = 512

function replay(table: ReturnType<typeof queries>, from: DateTime.Utc): Stream.Stream<Frame> {
  return Stream.unwrap(
    Effect.map(table.firstAt(DateTime.toEpochMillis(from)), ({ seq }) =>
      seq === null
        ? Stream.empty
        : Stream.fromIterableEffect(table.lookback(seq)).pipe(
            Stream.concat(
              Stream.paginate(seq - 1, (after) =>
                Effect.map(table.page({ after, size: pageSize }), (rows) => [
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
      (bodies, row) => readBack(table, bodies, row)
    ),
    // A row the log wrote and cannot read back is a defect, not something a replay could go on past.
    Stream.orDie
  )
}

// A row as replayed: a gap warned of and passed, or its frame, with the bodies an unchanged poll would repeat.
const readBack = Effect.fnUntraced(function* (
  table: ReturnType<typeof queries>,
  bodies: ReadonlyMap<string, string>,
  row: FeedFrameRow
) {
  if (row.kind === "gap") {
    const gap = yield* Effect.fromNullishOr(row.body)
    yield* warnOfGap(gap)
    return [bodies, []] as const
  }

  const channel = yield* Effect.fromNullishOr(row.channel)
  const body = yield* row.body === null
    ? repeated(table, bodies, channel, row.seq)
    : Gzip.decompress(row.body, "gzip")
  const frame = yield* FeedFrameRow.frame(row, body)

  return [Frame.isPollResponse(frame) ? new Map(bodies).set(channel, body) : bodies, [frame]] as const
})

// The body an unchanged poll repeats: its channel's last one in this replay, or else the last one stored.
function repeated(
  table: ReturnType<typeof queries>,
  bodies: ReadonlyMap<string, string>,
  channel: string,
  seq: number
) {
  return Option.match(Option.fromNullishOr(bodies.get(channel)), {
    onSome: Effect.succeed,
    onNone: () =>
      table.lastBody({ channel, seq }).pipe(Effect.flatMap(({ body }) => Gzip.decompress(body, "gzip")))
  })
}

function warnOfGap(body: Uint8Array) {
  return Gzip.decompress(body, "gzip").pipe(
    Effect.flatMap(decodeGap),
    Effect.flatMap((gap) =>
      Effect.logWarning(
        `FeedLog: replay passes ${gap.count} frames that were never written (seq ${gap.from} to ${gap.to})`
      ).pipe(Effect.annotateLogs(gap))
    )
  )
}

// Skips from one game day to the next through the received_at index: one query a day, never a scan of the frames.
const days = Effect.fn("FeedLog.days")(function* (table: ReturnType<typeof queries>) {
  const zone = yield* DateTime.CurrentTimeZone

  return yield* Stream.paginate(0, (after) =>
    Effect.map(table.firstReceived(after), ({ received }) =>
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
}, Effect.orDie)

const decodeGap = Schema.decodeEffect(Gap)
