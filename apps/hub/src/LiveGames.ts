import * as Fold from "@sportal/domain/LiveGames"
import {
  Cause,
  Clock,
  Context,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Pull,
  Ref,
  Stream,
  SubscriptionRef
} from "effect"
import { FeedLog } from "./FeedLog.ts"
import { countByState, gaugeHeld, takeDuration, timerDefect, told } from "./LiveGamesTelemetry.ts"
import { Decoder } from "./provider/Decoder.ts"
import type { Decoded } from "./provider/Provider.ts"

/**
 * The live games, run: the domain fold of every frame in the feed log, in order, with its timer, its telemetry, and its
 * game events. It follows the log on its own, from the game day's start: nothing writes to it.
 */
export class LiveGames extends Context.Service<
  LiveGames,
  {
    readonly latest: Effect.Effect<Fold.LiveGames>
    /** The latest first, then each change. `seq` or `reached` alone changing is not a change. */
    readonly changes: Stream.Stream<Fold.LiveGames>
    readonly events: Stream.Stream<Data.TaggedEnum.Value<Fold.FoldReport, "Happened">>
    /**
     * The fold once it has taken frame `seq`, or the latest once it has stopped following the log, so a fold that takes
     * no more frames never keeps its caller waiting.
     */
    through(seq: number): Effect.Effect<Fold.LiveGames>
    /**
     * Each live feed channel whose document a live frame's decode dropped, to be read again from a checkpoint. Task 7
     * folds it into the live feed's demand.
     */
    readonly resyncs: Stream.Stream<string>
  }
>()("sportal/hub/LiveGames") {
  /**
   * Follows the feed log from the start of the game day: replays it quietly, and is built once every frame logged before
   * it started is taken, so nothing is served from a fold still catching up. Then it takes each frame as it is appended,
   * and its timer runs. A decode defect during the replay fails the build; one after it stops the following, and the
   * fold keeps serving what it has.
   */
  static readonly layer: Layer.Layer<LiveGames, never, FeedLog | Decoder | DateTime.CurrentTimeZone> =
    Layer.effect(
      LiveGames,
      Effect.gen(function* () {
        const feedLog = yield* FeedLog
        const decoder = yield* Decoder
        const from = dayStart(yield* DateTime.nowInCurrentZone)
        const started = yield* Clock.currentTimeMillis
        const state = yield* SubscriptionRef.make<{
          readonly folded: Fold.LiveGames
          readonly following: Following
        }>({ folded: Fold.LiveGames.empty, following: Following.Replaying() })
        const events = yield* PubSub.unbounded<Data.TaggedEnum.Value<Fold.FoldReport, "Happened">>()
        const resyncs = yield* PubSub.unbounded<string>()
        // What the replay took, for its summary.
        const replayed = yield* Ref.make({ frames: 0, deliveries: 0, plays: 0 })
        const caughtUp = yield* Deferred.make<{ readonly frames: number; readonly deliveries: number }>()

        // Takes or ticks the fold and tells what it did as the following stands, all under the state's lock; publishes
        // whenever the fold or its watermarks moved, so `through` sees every frame. Uninterruptible, so an interrupted
        // caller never leaves telemetry without its state; a report that dies leaves the state as it was.
        const step = (
          frame: Option.Option<Decoded>,
          run: (folded: Fold.LiveGames) => Effect.Effect<{
            readonly next: Fold.LiveGames
            readonly reports: ReadonlyArray<Fold.FoldReport>
          }>
        ) =>
          SubscriptionRef.modifySomeEffect(state, ({ folded, following }) =>
            Effect.gen(function* () {
              const { next, reports } = yield* run(folded)
              yield* told(following, frame, reports)
              if (Following.$is("Live")(following)) {
                yield* PubSub.publishAll(events, reports.filter(Fold.FoldReport.$is("Happened")))
                if (next.live !== folded.live) yield* countByState(next.live)
              }
              const moved =
                !next.publishesSameAs(folded) ||
                !Equal.equals(next.seq, folded.seq) ||
                !Equal.equals(next.reached, folded.reached)
              return [reports, moved ? Option.some({ folded: next, following }) : Option.none()] as const
            })
          ).pipe(Effect.uninterruptible)

        const replay = (decoded: Decoded) =>
          step(Option.some(decoded), (folded) => folded.take(decoded)).pipe(
            Effect.flatMap((reports) =>
              Ref.update(replayed, ({ frames, deliveries, plays }) => ({
                frames: frames + 1,
                deliveries: deliveries + decoded.deliveries.length,
                plays:
                  plays +
                  reports.filter((report) => report._tag === "Happened" && report.event._tag === "Played")
                    .length
              }))
            )
          )

        const take = Effect.fn("LiveGames.take")(function* (decoded: Decoded) {
          yield* Effect.annotateCurrentSpan({
            "sportal.seq": decoded.seq,
            "sportal.deliveries": decoded.deliveries.length
          })
          yield* step(Option.some(decoded), (folded) => folded.take(decoded))
          yield* PubSub.publishAll(resyncs, decoded.resyncs)
        }, Effect.trackDuration(takeDuration))

        // The boundary: sets every held game's gauges once, logs the summary, and goes live. Gives the replay's last
        // `seq`, which is the fold's, since every replayed frame is taken by then.
        const caughtUpTo = Effect.gen(function* () {
          const { folded } = yield* SubscriptionRef.get(state)
          yield* Effect.forEach(folded.live.values(), gaugeHeld, { discard: true })
          yield* countByState(folded.live)
          const { frames, deliveries, plays } = yield* Ref.get(replayed)
          const took = Duration.millis((yield* Clock.currentTimeMillis) - started)
          yield* Effect.logInfo(
            `LiveGames: replayed ${frames} frames: ${deliveries} deliveries, ${plays} plays; ${folded.live.size} live games, in ${Duration.format(took)}`
          )
          yield* SubscriptionRef.update(state, (followed) => ({ ...followed, following: Following.Live() }))
          yield* Deferred.succeed(caughtUp, { frames, deliveries })
          return Option.getOrElse(folded.seq, () => 0)
        })

        // Stops the following on a decode defect, or should the log's stream end, logged first if it was live. An
        // interruption, or the end the log's stream fails with when its subscription is shut down, is the Hub stopping.
        const stopped = (exit: Exit.Exit<void>) =>
          Exit.isFailure(exit) && (Cause.hasInterruptsOnly(exit.cause) || Pull.isDoneCause(exit.cause))
            ? Effect.void
            : SubscriptionRef.get(state).pipe(
                Effect.flatMap(({ following }) =>
                  Following.$is("Live")(following)
                    ? Effect.logError(
                        "LiveGames: frames are no longer taken into the fold until the Hub restarts",
                        Exit.isFailure(exit) ? exit.cause : "the log's stream ended"
                      )
                    : Effect.void
                ),
                Effect.andThen(
                  SubscriptionRef.update(state, (followed) => ({
                    ...followed,
                    following: Following.Stopped()
                  }))
                )
              )

        // Subscribed before the replay is read, so a frame appended any time after it ends is in `appended`.
        const appended = yield* feedLog.subscribe
        // One decode over the day's log and then every frame appended after it, so each topic's document carries over
        // from replay to live. Decoding pulls the next frame only once it has handed on what the last one said, so the
        // replay's end is reached once every replayed frame is taken.
        const follower = yield* decoder
          .decode(
            feedLog
              .replay(from)
              .pipe(
                Stream.concat(
                  Stream.unwrap(
                    Effect.map(caughtUpTo, (last) => Stream.filter(appended, (frame) => frame.seq > last))
                  )
                )
              )
          )
          .pipe(
            Stream.runForEach((decoded) =>
              Effect.flatMap(SubscriptionRef.get(state), ({ following }) =>
                Following.$match(following, {
                  Replaying: () => replay(decoded),
                  Live: () => take(decoded),
                  Stopped: () => Effect.void
                })
              )
            ),
            Effect.onExit(stopped),
            Effect.forkScoped
          )

        // A decode that dies during the replay fails the build, rather than leaving it waiting.
        yield* Effect.raceFirst(
          Deferred.await(caughtUp),
          Fiber.join(follower).pipe(Effect.andThen(Effect.never))
        ).pipe(
          Effect.flatMap(({ frames, deliveries }) =>
            Effect.annotateCurrentSpan({ "sportal.frames": frames, "sportal.deliveries": deliveries })
          ),
          Effect.withSpan("LiveGames.replay")
        )

        // The timer, from the end of the replay, so nothing ticks a replayed game between two recorded frames: on each
        // change, sleeps until the earliest game is due, then ticks to the clock's now. A tick that changes nothing (a
        // sleep that ended early, or a verdict that stayed) loops; a change restarts it. A defect is logged and counted,
        // and the timer tries again after a moment.
        const wake = Effect.gen(function* () {
          const { folded } = yield* SubscriptionRef.get(state)
          yield* Option.match(folded.earliestDue(), {
            onNone: () => Effect.never,
            onSome: (due) =>
              sleepUntil(due).pipe(
                Effect.andThen(DateTime.now),
                Effect.flatMap((now) => step(Option.none(), (folded) => folded.tick(now)))
              )
          })
        }).pipe(
          Effect.catchDefect((defect) =>
            timerDefect(defect).pipe(Effect.andThen(Effect.sleep(timerBackoff)))
          ),
          Effect.forever
        )
        yield* Effect.forkScoped(
          SubscriptionRef.changes(state).pipe(
            Stream.switchMap(() => Stream.fromEffect(wake)),
            Stream.runDrain
          ),
          { startImmediately: true }
        )

        const latest = Effect.map(SubscriptionRef.get(state), ({ folded }) => folded)
        return LiveGames.of({
          latest,
          changes: SubscriptionRef.changes(state).pipe(
            Stream.map(({ folded }) => folded),
            Stream.changesWith((a, b) => a.publishesSameAs(b))
          ),
          events: Stream.fromPubSub(events),
          through: (seq) =>
            SubscriptionRef.changes(state).pipe(
              Stream.filter(
                ({ folded, following }) =>
                  Following.$is("Stopped")(following) || Option.exists(folded.seq, (at) => at >= seq)
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({ onNone: () => latest, onSome: ({ folded }) => Effect.succeed(folded) })
              )
            ),
          resyncs: Stream.fromPubSub(resyncs)
        })
      })
    )
}

/**
 * Where the live games are in following the feed log: catching up on the day before the Hub serves, live, or stopped by a
 * decode defect.
 */
export type Following = Data.TaggedEnum<{ Replaying: object; Live: object; Stopped: object }>
export const Following = Data.taggedEnum<Following>()

/** The start of the game day `now` is in: 04:00 in its zone, or the day before's when it is earlier than that. */
function dayStart(now: DateTime.Zoned): DateTime.Utc {
  const today = DateTime.setParts(now, { hour: 4, minute: 0, second: 0, millisecond: 0 })
  return DateTime.toUtc(DateTime.isLessThan(now, today) ? DateTime.subtract(today, { days: 1 }) : today)
}

function sleepUntil(at: DateTime.Utc): Effect.Effect<void> {
  return DateTime.now.pipe(
    Effect.flatMap((now) => Effect.sleep(Duration.max(DateTime.distance(now, at), Duration.zero)))
  )
}

// How long the timer waits after a defect before it tries again.
const timerBackoff = Duration.seconds(1)
