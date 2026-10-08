import { LiveMessage, type SlateChanged } from "@sportal/api/LiveMessage"
import { GameDay } from "@sportal/domain/GameDay"
import { type GameEvent, GameEventKind } from "@sportal/domain/GameEvent"
import { LeagueId } from "@sportal/domain/League"
import {
  Clock,
  Context,
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
  Ref,
  Stream,
  SubscriptionRef
} from "effect"
import { Following } from "./Following.ts"
import { FeedLog } from "./feed-log/FeedLog.ts"
import * as HubStopping from "./HubStopping.ts"
import * as LiveSlateTelemetry from "./LiveSlateTelemetry.ts"
import { type Decoded, Provider } from "./provider/Provider.ts"
import { Slate, type Taken } from "./slate/Slate.ts"

/**
 * The live slate: the domain slate taking every frame in the feed log, in order, with its timer, its telemetry, and its
 * game events. It follows the log on its own, from the game day's start: nothing writes to it.
 */
export class LiveSlate extends Context.Service<
  LiveSlate,
  {
    readonly latest: Effect.Effect<Slate>
    /** The latest first, then each change. `seq` or `reached` alone changing is not a change. */
    readonly changes: Stream.Stream<Slate>
    readonly events: Stream.Stream<GameEvent>
    /**
     * The slate once it has taken frame `seq`, or the latest once it has halted following the log, so a slate that takes
     * no more frames never keeps its caller waiting.
     */
    through(seq: number): Effect.Effect<Slate>
    /** The listed games and their recent plays, debounced 250 ms: what the live stream sends. */
    readonly published: Effect.Effect<SlateChanged>
    /** `published` first, then each new one. */
    readonly publishedChanges: Stream.Stream<SlateChanged>
  }
>()("sportal/hub/LiveSlate") {
  /**
   * Follows the feed log from the start of the game day: replays it quietly, and is built once every frame logged before
   * it started is taken, so nothing is served from a slate still catching up. Then it takes each frame as it is appended,
   * and its timer runs. A decode defect during the replay fails the build; one after it halts the following, and the
   * slate keeps serving what it has. Each burst of changes settles after 250 ms with no further change, on the layer's
   * clock, and is then published: changes arriving more often than that, without a pause, publish nothing until they
   * pause.
   */
  static readonly layer: Layer.Layer<LiveSlate, never, FeedLog | Provider | DateTime.CurrentTimeZone> =
    Layer.effect(
      LiveSlate,
      Effect.gen(function* () {
        const feedLog = yield* FeedLog
        const provider = yield* Provider
        const now = yield* DateTime.nowInCurrentZone
        const from = GameDay.dayStart(now)
        const started = yield* Clock.currentTimeMillis
        const state = yield* SubscriptionRef.make<{
          readonly slate: Slate
          readonly following: Following
        }>({ slate: Slate.empty, following: Following.Replaying() })
        const latest = Effect.map(SubscriptionRef.get(state), ({ slate }) => slate)
        const events = yield* PubSub.unbounded<GameEvent>()
        // What the replay took, for its summary.
        const replayed = yield* Ref.make({ frames: 0, deliveries: 0, plays: 0 })
        // The last `seq` the replay has read, and once it has read them all, that `seq` for good. A frame at or before it
        // is replayed, whatever a decode that reads ahead has handed on so far.
        const readTo = yield* Ref.make(0)
        const replayRead = yield* Deferred.make<number>()
        const caughtUp = yield* Deferred.make<{ readonly frames: number; readonly deliveries: number }>()

        // Takes or ticks the slate and tells what it did as the following stands, all under the state's lock; publishes
        // whenever the slate or its watermarks moved, so `through` sees every frame. Uninterruptible, so an interrupted
        // caller never leaves telemetry without its state; an observation that dies leaves the state as it was.
        const step = Effect.fnUntraced(function* (
          frame: Option.Option<Decoded>,
          run: (slate: Slate) => Effect.Effect<Taken>
        ) {
          return yield* SubscriptionRef.modifySomeEffect(state, ({ slate, following }) =>
            Effect.gen(function* () {
              const taken = yield* run(slate)
              const { next } = taken
              yield* LiveSlateTelemetry.told(following, frame, slate, taken)
              if (!Following.$is("Replaying")(following)) {
                yield* PubSub.publishAll(events, taken.events)
              }
              const moved =
                !next.publishesSameAs(slate) ||
                !Equal.equals(next.seq, slate.seq) ||
                !Equal.equals(next.reached, slate.reached)
              return [taken, moved ? Option.some({ slate: next, following }) : Option.none()] as const
            })
          )
        }, Effect.uninterruptible)

        const takeReplayed = (decoded: Decoded) =>
          step(Option.some(decoded), (slate) => slate.take(decoded)).pipe(
            Effect.flatMap(({ events }) =>
              Ref.update(replayed, ({ frames, deliveries, plays }) => ({
                frames: frames + 1,
                deliveries: deliveries + decoded.deliveries.length,
                plays: plays + events.filter(({ what }) => GameEventKind.$is("Played")(what)).length
              }))
            )
          )

        const take = Effect.fn("LiveSlate.take")(function* (decoded: Decoded) {
          yield* Effect.annotateCurrentSpan({
            "sportal.seq": decoded.seq,
            "sportal.deliveries": decoded.deliveries.length
          })
          yield* step(Option.some(decoded), (slate) => slate.take(decoded))
        }, LiveSlateTelemetry.timedTake)

        // The boundary, once: sets every held game's gauges, logs the summary, and goes live.
        const goLive = SubscriptionRef.modifySomeEffect(state, (followed) =>
          Following.$is("Replaying")(followed.following)
            ? Effect.gen(function* () {
                yield* LiveSlateTelemetry.wentLive(followed.slate)
                const { frames, deliveries, plays } = yield* Ref.get(replayed)
                const finished = yield* Clock.currentTimeMillis
                const took = Duration.millis(finished - started)
                yield* Effect.logInfo(
                  `LiveSlate: replayed ${frames} frames: ${deliveries} deliveries, ${plays} plays; ${followed.slate.games.size} live games, in ${Duration.format(took)}`
                )
                yield* Deferred.succeed(caughtUp, { frames, deliveries })
                return [undefined, Option.some({ ...followed, following: Following.Live() })] as const
              })
            : Effect.succeed([undefined, Option.none()] as const)
        )

        // Goes live once the replay is read and the slate has taken its last frame: at once for an empty replay.
        const caughtUpIfTaken = Effect.all([Deferred.isDone(replayRead), Ref.get(readTo), latest]).pipe(
          Effect.flatMap(([read, last, slate]) =>
            read && Option.getOrElse(slate.seq, () => 0) >= last ? goLive : Effect.void
          )
        )

        // Subscribed before the replay is read, so a frame appended any time after it ends is in `appended`.
        const appended = yield* feedLog.subscribe
        // The day's log and then every frame appended after its last `seq`, read by one decode, so each topic's document
        // carries over from replay to live.
        const dayThenAppended = feedLog.replay(from).pipe(
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
        const follower = yield* provider.decode(dayThenAppended).pipe(
          Stream.runForEach((decoded) =>
            Effect.flatMap(Ref.get(readTo), (last) =>
              decoded.seq <= last
                ? takeReplayed(decoded).pipe(Effect.andThen(caughtUpIfTaken))
                : take(decoded)
            )
          ),
          // A decode defect, or the log's stream ending, halts the following, logged first if it was live.
          Effect.onExitIf(
            (exit) => !HubStopping.isStopping(exit),
            (exit) =>
              SubscriptionRef.get(state).pipe(
                Effect.flatMap(({ following }) =>
                  Following.$is("Live")(following)
                    ? Effect.logError(
                        "LiveSlate: frames are no longer taken into the slate until the Hub restarts",
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
        const replay = Effect.fn("LiveSlate.replay")(function* () {
          const { frames, deliveries } = yield* Effect.raceFirst(
            Deferred.await(caughtUp),
            Fiber.join(follower).pipe(Effect.andThen(Effect.never))
          )
          yield* Effect.annotateCurrentSpan({ "sportal.frames": frames, "sportal.deliveries": deliveries })
        })
        yield* replay()

        const through = (seq: number) =>
          SubscriptionRef.changes(state).pipe(
            Stream.filter(
              ({ slate, following }) =>
                Following.$is("Halted")(following) || Option.exists(slate.seq, (at) => at >= seq)
            ),
            Stream.runHead,
            Effect.flatMap(
              Option.match({ onNone: () => latest, onSome: ({ slate }) => Effect.succeed(slate) })
            )
          )

        // The timer, from the end of the replay, so nothing ticks a replayed game between two recorded frames: on each
        // change, sleeps until the earliest game is due, then ticks to the clock's now. A tick that changes nothing (a
        // sleep that ended early, or a verdict that stayed) loops; a change restarts it. A defect is logged and counted,
        // and the timer tries again after a moment.
        const wake = Effect.gen(function* () {
          const { slate } = yield* SubscriptionRef.get(state)
          const due = slate.earliestDue()
          if (Option.isNone(due)) {
            return yield* Effect.never
          }
          const sleeping = yield* DateTime.now
          yield* Effect.sleep(Duration.max(DateTime.distance(sleeping, due.value), Duration.zero))
          const woke = yield* DateTime.now
          yield* step(Option.none(), (held) => held.tick(woke))
        }).pipe(
          Effect.catchDefect((defect) =>
            LiveSlateTelemetry.timerDefect(defect).pipe(Effect.andThen(Effect.sleep(timerBackoff)))
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
          Stream.map(({ slate }) => slate),
          Stream.changesWith((a, b) => a.publishesSameAs(b))
        )
        const publication = yield* SubscriptionRef.make(
          LiveMessage.cases.SlateChanged.make({ games: [], recentPlays: {} })
        )
        yield* Effect.forkScoped(
          changes.pipe(
            Stream.debounce("250 millis"),
            Stream.runForEach((slate) => {
              const games = slate.listedGames(LeagueId.literals)
              const recentPlays = slate.recentPlays(games)
              return SubscriptionRef.set(
                publication,
                LiveMessage.cases.SlateChanged.make({ games, recentPlays })
              )
            })
          ),
          { startImmediately: true }
        )

        return LiveSlate.of({
          latest,
          changes,
          events: Stream.fromPubSub(events),
          through,
          published: SubscriptionRef.get(publication),
          publishedChanges: SubscriptionRef.changes(publication)
        })
      })
    )
}

// How long the timer waits after a defect before it tries again.
const timerBackoff = Duration.seconds(1)
