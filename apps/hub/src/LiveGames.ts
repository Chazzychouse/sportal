import * as Fold from "@sportal/domain/LiveGames"
import {
  Array as Arr,
  Clock,
  Context,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Equal,
  Equivalence,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
  SubscriptionRef
} from "effect"
import { FeedLog } from "./FeedLog.ts"
import { isStopping } from "./HubStopping.ts"
import { countByState, gaugeHeld, takeDuration, timerDefect, told } from "./LiveGamesTelemetry.ts"
import { Decoder } from "./provider/Decoder.ts"
import { type Decoded, LiveFeedDemand } from "./provider/Provider.ts"

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
     * The fold once it has taken frame `seq`, or the latest once it has halted following the log, so a fold that takes
     * no more frames never keeps its caller waiting.
     */
    through(seq: number): Effect.Effect<Fold.LiveGames>
    /**
     * What the live feed should follow, afresh on each run: the current games first, then each change of which games
     * they are, and each channel whose document a live frame's decode dropped.
     */
    readonly demand: Stream.Stream<LiveFeedDemand>
  }
>()("sportal/hub/LiveGames") {
  /**
   * Follows the feed log from the start of the game day: replays it quietly, and is built once every frame logged before
   * it started is taken, so nothing is served from a fold still catching up. Then it takes each frame as it is appended,
   * and its timer runs. A decode defect during the replay fails the build; one after it halts the following, and the
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
        const latest = Effect.map(SubscriptionRef.get(state), ({ folded }) => folded)
        const events = yield* PubSub.unbounded<Data.TaggedEnum.Value<Fold.FoldReport, "Happened">>()
        const resyncs = yield* PubSub.unbounded<string>()
        // What the replay took, for its summary.
        const replayed = yield* Ref.make({ frames: 0, deliveries: 0, plays: 0 })
        // The last `seq` the replay has read, and once it has read them all, that `seq` for good. A frame at or before it
        // is replayed, whatever a decode that reads ahead has handed on so far.
        const readTo = yield* Ref.make(0)
        const replayRead = yield* Deferred.make<number>()
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
              if (!Following.$is("Replaying")(following)) {
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

        // The boundary, once: sets every held game's gauges, logs the summary, and goes live.
        const goLive = SubscriptionRef.modifySomeEffect(state, (followed) =>
          Following.$is("Replaying")(followed.following)
            ? Effect.gen(function* () {
                yield* Effect.forEach(followed.folded.live.values(), gaugeHeld, { discard: true })
                yield* countByState(followed.folded.live)
                const { frames, deliveries, plays } = yield* Ref.get(replayed)
                const took = Duration.millis((yield* Clock.currentTimeMillis) - started)
                yield* Effect.logInfo(
                  `LiveGames: replayed ${frames} frames: ${deliveries} deliveries, ${plays} plays; ${followed.folded.live.size} live games, in ${Duration.format(took)}`
                )
                yield* Deferred.succeed(caughtUp, { frames, deliveries })
                return [undefined, Option.some({ ...followed, following: Following.Live() })] as const
              })
            : Effect.succeed([undefined, Option.none()] as const)
        )

        // Goes live once the replay is read and the fold has taken its last frame: at once for an empty replay.
        const caughtUpIfTaken = Effect.all([Deferred.isDone(replayRead), Ref.get(readTo), latest]).pipe(
          Effect.flatMap(([read, last, folded]) =>
            read && Option.getOrElse(folded.seq, () => 0) >= last ? goLive : Effect.void
          )
        )

        // Subscribed before the replay is read, so a frame appended any time after it ends is in `appended`.
        const appended = yield* feedLog.subscribe
        // One decode over the day's log and then every frame appended after its last `seq`, so each topic's document
        // carries over from replay to live.
        const follower = yield* decoder
          .decode(
            feedLog.replay(from).pipe(
              Stream.tap((frame) => Ref.set(readTo, frame.seq)),
              Stream.concat(
                Stream.unwrap(
                  Effect.gen(function* () {
                    const last = yield* Ref.get(readTo)
                    yield* Deferred.succeed(replayRead, last)
                    yield* caughtUpIfTaken
                    return Stream.filter(appended, (frame) => frame.seq > last)
                  })
                )
              )
            )
          )
          .pipe(
            Stream.runForEach((decoded) =>
              Effect.flatMap(Ref.get(readTo), (last) =>
                decoded.seq <= last ? replay(decoded).pipe(Effect.andThen(caughtUpIfTaken)) : take(decoded)
              )
            ),
            // A decode defect, or the log's stream ending, halts the following, logged first if it was live.
            Effect.onExitIf(
              (exit) => !isStopping(exit),
              (exit) =>
                SubscriptionRef.get(state).pipe(
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
                      following: Following.Halted()
                    }))
                  )
                )
            ),
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

        const changes = SubscriptionRef.changes(state).pipe(
          Stream.map(({ folded }) => folded),
          Stream.changesWith((a, b) => a.publishesSameAs(b))
        )

        // The current games, again on each change of which games they are.
        const currentGames = changes.pipe(
          Stream.mapEffect((folded) =>
            Effect.map(DateTime.now, (now) =>
              [...folded.live.values()]
                .filter((liveGame) => liveGame.isCurrent(now))
                .map((liveGame) => liveGame.snapshot)
            )
          ),
          Stream.changesWith((self, that) =>
            sameIds(
              self.map((game) => game.id),
              that.map((game) => game.id)
            )
          ),
          Stream.map((games) => LiveFeedDemand.Games({ games }))
        )

        return LiveGames.of({
          latest,
          changes,
          events: Stream.fromPubSub(events),
          through: (seq) =>
            SubscriptionRef.changes(state).pipe(
              Stream.filter(
                ({ folded, following }) =>
                  Following.$is("Halted")(following) || Option.exists(folded.seq, (at) => at >= seq)
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({ onNone: () => latest, onSome: ({ folded }) => Effect.succeed(folded) })
              )
            ),
          // Subscribed to the resyncs before the first games are given, so every resync after them is in the demand.
          demand: Stream.unwrap(
            Effect.map(PubSub.subscribe(resyncs), (subscription) =>
              Stream.merge(
                currentGames,
                Stream.fromSubscription(subscription).pipe(
                  Stream.map((channel) => LiveFeedDemand.Resync({ channel }))
                )
              )
            )
          )
        })
      })
    )
}

/**
 * Where the live games are in following the feed log: catching up on the day before the Hub serves, live, or halted by a
 * decode defect, when no new frame is taken but the timer still runs and is told.
 */
export type Following = Data.TaggedEnum<{ Replaying: object; Live: object; Halted: object }>
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

const sameIds = Arr.makeEquivalence(Equivalence.String)
