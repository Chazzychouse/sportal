import { Delivery } from "@sportal/domain/Delivery"
import { Slate } from "@sportal/domain/Slate"
import { Array as Arr, DateTime, Effect, Option, Schema, Stream } from "effect"
import { FeedLog } from "../FeedLog.ts"
import { Decoder } from "../provider/Decoder.ts"
import { DecodeObservation } from "../provider/Provider.ts"
import { CorpusDay, CorpusDays } from "./CorpusDay.ts"
import { CorpusLine, Had } from "./CorpusInput.ts"

/**
 * Builds the captured day `date` (YYYY-MM-DD) from the feed log: its frames through the decoder, split by feed. The
 * day runs from 04:00 local on `date` to 04:00 the next day, and keeps each topic's checkpoint from before it, as the
 * Hub's replay does. Its frames are threaded in the corpus day's order, by arrival then `seq`, the order `CorpusDays`
 * reads them back in. A frame that does not decode fails the build: a day is never built from a partial decode.
 */
export function captured(
  date: string
): Effect.Effect<CorpusDay, CorpusBuildFailed, FeedLog | Decoder | CorpusDays | DateTime.CurrentTimeZone> {
  return Effect.gen(function* () {
    const noon = yield* Option.match(
      DateTime.makeZoned(DateTime.makeUnsafe(`${date}T12:00:00Z`), {
        timeZone: yield* DateTime.CurrentTimeZone,
        adjustForTimeZone: true
      }),
      { onSome: Effect.succeed, onNone: () => Effect.die(new Error(`${date} is not a day in this zone`)) }
    )
    const from = Slate.dayStart(noon)
    const until = Slate.dayStart(DateTime.add(noon, { days: 1 }))
    const decoder = yield* Decoder
    const decoded = yield* decoder
      .decode(
        (yield* FeedLog)
          .replay(from)
          .pipe(Stream.takeWhile((frame) => DateTime.isLessThan(frame.receivedAt, until)))
      )
      .pipe(
        Stream.mapEffect((said) =>
          Option.match(Arr.findFirst(said.observations, DecodeObservation.$is("FrameUndecoded")), {
            onNone: () => Effect.succeed(said),
            onSome: ({ cause }) => Effect.fail(new CorpusBuildFailed({ date, reason: "Undecodable", cause }))
          })
        ),
        Stream.runCollect
      )
    if (!decoded.some(({ at }) => DateTime.isGreaterThanOrEqualTo(at, from))) {
      return yield* new CorpusBuildFailed({
        date,
        reason: "NoFrames",
        cause: `no frame received from ${DateTime.formatIso(from)} to ${DateTime.formatIso(until)}`
      })
    }

    // The log is in seq order, and `receivedAt` need not rise with it (two feeds append concurrently), so the lines
    // are threaded in the order the day reads back in, or an unchanged listing would name another predecessor.
    const frames = yield* Stream.fromIterable(decoded.toSorted(CorpusLine.byArrival)).pipe(
      Stream.mapAccumEffect(
        () => Had.empty,
        (had, said) => Effect.map(CorpusLine.of(said, had), (lines) => [lines.had, [lines]] as const)
      ),
      Stream.runCollect
    )
    const deliveries = decoded.flatMap(({ deliveries }) => deliveries)
    const day = new CorpusDay({
      date,
      kind: "captured",
      format: CorpusLine.format,
      leagues: [
        ...new Set(
          deliveries.flatMap((delivery) =>
            Delivery.match(delivery, {
              Listing: ({ league }) => [league],
              Snapshot: ({ snapshot }) => [snapshot.league],
              Plays: () => []
            })
          )
        )
      ].toSorted(),
      games: new Set(
        deliveries.flatMap((delivery) =>
          Delivery.match(delivery, {
            Listing: ({ games }) => games.map(({ id }) => id),
            Snapshot: ({ snapshot }) => [snapshot.id],
            Plays: ({ game }) => [game]
          })
        )
      ).size,
      built: yield* DateTime.now
    })
    // A corpus directory that cannot be written is the machine's fault, not the day's: the CLI stops on it.
    yield* (yield* CorpusDays)
      .write(day, {
        poll: Stream.fromIterable(frames.flatMap(({ poll }) => poll)),
        push: Stream.fromIterable(frames.flatMap(({ push }) => push))
      })
      .pipe(Effect.orDie)
    return day
  })
}

/**
 * Corpus day `date` could not be built: the feed log has no frame received in it, or a frame of it did not decode,
 * which `cause` holds.
 */
export class CorpusBuildFailed extends Schema.TaggedError<CorpusBuildFailed>()("CorpusBuildFailed", {
  date: Schema.String,
  reason: Schema.Literals(["NoFrames", "Undecodable"]),
  cause: Schema.Defect()
}) {
  override get message() {
    return {
      NoFrames: `The feed log has no frames of ${this.date}`,
      Undecodable: `A frame of ${this.date} does not decode; the day is not built`
    }[this.reason]
  }
}
