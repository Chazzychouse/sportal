import { Delivery } from "@sportal/domain/Delivery"
import type { LeagueId } from "@sportal/domain/League"
import { Array as Arr, DateTime, Effect, Option, Result, Schema, Stream } from "effect"
import { FeedLog } from "../feed-log/FeedLog.ts"
import { Archive, type ArchiveFetchFailed } from "../provider/Archive.ts"
import { DecodeObservation, Decoder } from "../provider/Decoder.ts"
import { CorpusDay, CorpusDays } from "./CorpusDay.ts"
import { CorpusLine, Had } from "./CorpusInput.ts"
import * as Synthesis from "./Synthesis.ts"

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
    const { from, until } = yield* CorpusDay.bounds(date)
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
 * Builds the backfilled day `date` for `leagues` from the archive: fetching what is missing when `fetch`, else from
 * what is archived. A backfilled day already there adds its leagues, so the day is rebuilt for them all; from what is
 * archived, a league the archive has no scoreboard of on `date` is left out, and the day fails `NotArchived` when that
 * is every league. A captured day already there is never overwritten: it is returned as it is, and nothing is fetched.
 */
export function backfilled(
  date: string,
  leagues: ReadonlyArray<LeagueId>,
  how: "fetch" | "archived"
): Effect.Effect<CorpusDay, CorpusBuildFailed | ArchiveFetchFailed, Archive | CorpusDays> {
  return Effect.gen(function* () {
    const days = yield* CorpusDays
    // A day.json that cannot be read is the machine's fault, as a write that fails is; nothing is built over it.
    const existing = yield* days.day(date).pipe(Effect.orDie)
    if (Option.isSome(existing) && existing.value.kind === "captured") return existing.value

    const archive = yield* Archive
    const asked = [
      ...new Set([...leagues, ...Option.match(existing, { onNone: () => [], onSome: (day) => day.leagues })])
    ].toSorted()
    const [read, unarchived] = Arr.partition(
      yield* Effect.forEach(asked, (league) =>
        (how === "fetch" ? archive.games(league, date) : archive.archived(league, date)).pipe(
          Effect.map((games) => Result.succeed({ league, games })),
          Effect.catchIf(
            (failed) => how === "archived" && failed.reason === "NotArchived" && failed.game === undefined,
            (failed) => Effect.succeed(Result.fail(failed))
          )
        )
      ),
      (result) => result
    )
    if (read.length === 0 && Arr.isReadonlyArrayNonEmpty(unarchived))
      return yield* Arr.headNonEmpty(unarchived)
    yield* Effect.forEach(
      unarchived,
      (failed) => Effect.logWarning(`${failed.message}; left out of ${date}`),
      {
        discard: true
      }
    )
    const games = read.flatMap(({ games }) => games)
    if (games.length === 0) {
      return yield* new CorpusBuildFailed({
        date,
        reason: "NoGames",
        cause: `no final game with plays of ${asked.join(", ")} on ${date}`
      })
    }

    const { poll, push } = yield* Synthesis.day(games)
    const day = new CorpusDay({
      date,
      kind: "backfilled",
      format: CorpusLine.format,
      leagues: read.map(({ league }) => league),
      games: games.length,
      built: yield* DateTime.now
    })
    // As a captured day's: a corpus directory that cannot be written stops the CLI.
    yield* days
      .write(day, { poll: Stream.fromIterable(poll), push: Stream.fromIterable(push) })
      .pipe(Effect.orDie)
    return day
  })
}

/**
 * Corpus day `date` could not be built: the feed log has no frame received in it, a frame of it did not decode,
 * which `cause` holds, or the archive has no final game with plays on it.
 */
export class CorpusBuildFailed extends Schema.TaggedError<CorpusBuildFailed>()("CorpusBuildFailed", {
  date: Schema.String,
  reason: Schema.Literals(["NoFrames", "Undecodable", "NoGames"]),
  cause: Schema.Defect()
}) {
  override get message() {
    return {
      NoFrames: `The feed log has no frames of ${this.date}`,
      Undecodable: `A frame of ${this.date} does not decode; the day is not built`,
      NoGames: `The archive has no final game with plays on ${this.date}`
    }[this.reason]
  }
}
