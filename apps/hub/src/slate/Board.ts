import { GameDay } from "@sportal/domain/GameDay"
import { GameEventKind } from "@sportal/domain/GameEvent"
import {
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Stream,
  SubscriptionRef
} from "effect"
import { FeedLog } from "../feed-log/FeedLog.ts"
import * as HubStopping from "../HubStopping.ts"
import { type Decoded, Provider } from "../provider/Provider.ts"
import { BoardTelemetry } from "./BoardTelemetry.ts"
import { Slate, type Taken } from "./Slate.ts"

/** The one holder of the day's slate: it keeps it current from the feed log and the clock. */
export class Board extends Context.Service<
  Board,
  {
    readonly latest: Effect.Effect<Slate>
    /** The latest first, then each change; `reached` alone moving is not a change. */
    readonly changes: Stream.Stream<Slate>
    /** Every take and tick, in order, each marked replayed or not. */
    readonly taken: Stream.Stream<{ readonly taken: Taken; readonly replayed: boolean }>
  }
>()("sportal/hub/slate/Board") {
  /**
   * Follows the feed log from the start of the game day: replays it quietly, and is built once every frame logged before
   * it started is taken, so nothing is served from a slate still catching up. Then it takes each frame as it is appended,
   * and its timer runs. A decode defect during the replay fails the build; one after it stops the following, and the
   * board keeps what it has while its timer runs.
   */
  static readonly layer: Layer.Layer<
    Board,
    never,
    FeedLog | Provider | BoardTelemetry | DateTime.CurrentTimeZone
  > = Layer.effect(
    Board,
    Effect.gen(function* () {
      const feedLog = yield* FeedLog
      const provider = yield* Provider
      const telemetry = yield* BoardTelemetry
      const now = yield* DateTime.nowInCurrentZone
      const slate = yield* SubscriptionRef.make(Slate.empty)
      const takes = yield* PubSub.unbounded<{ readonly taken: Taken; readonly replayed: boolean }>()
      const caughtUp = yield* Deferred.make<Replayed>()

      // Takes or ticks the slate and tells telemetry under the slate's lock, so every take is told in order, then
      // publishes the take once the slate holds it, so a subscriber that reads `latest` reads it taken. Uninterruptible,
      // so an interrupted caller never leaves telemetry without its state or a take unpublished; a telling that dies
      // leaves the slate as it was.
      const step = Effect.fnUntraced(function* (
        frame: Option.Option<Decoded>,
        replayed: boolean,
        run: (slate: Slate) => Effect.Effect<Taken>
      ) {
        const item = yield* SubscriptionRef.modifyEffect(slate, (before) =>
          Effect.gen(function* () {
            const taken = yield* run(before)
            yield* telemetry.told({ taken, replayed }, frame, before)
            return [{ taken, replayed }, taken.next] as const
          })
        )
        yield* PubSub.publish(takes, item)
        return item
      }, Effect.uninterruptible)

      const take = Effect.fn("LiveSlate.take")(
        function* (decoded: Decoded) {
          yield* Effect.annotateCurrentSpan({
            "sportal.seq": decoded.seq,
            "sportal.deliveries": decoded.deliveries.length
          })
          return yield* step(Option.some(decoded), false, (held) => held.take(decoded))
        },
        (taking) => telemetry.timedTake(taking)
      )

      // The boundary, once: telemetry goes live, then the build ends.
      const goLive = Effect.fnUntraced(function* (replayed: Replayed) {
        const current = yield* SubscriptionRef.get(slate)
        yield* telemetry.wentLive(current, replayed)
        yield* Deferred.succeed(caughtUp, replayed)
      })

      // One decode reads the day's log and then every appended frame, so each topic's document carries over from
      // replay to live.
      const log = yield* feedLog.follow(GameDay.dayStart(now))
      const isReplayed = (decoded: Decoded) => Option.exists(log.last, (last) => decoded.seq <= last)
      const following = yield* provider.decode(log.frames).pipe(
        Stream.mapEffect((decoded) =>
          Effect.map(
            isReplayed(decoded)
              ? step(Option.some(decoded), true, (held) => held.take(decoded))
              : take(decoded),
            ({ taken }) => ({ decoded, taken })
          )
        ),
        Stream.mapAccum(
          () => noneReplayed,
          (replayed, { decoded, taken }) => {
            const counted = isReplayed(decoded) ? countedIn(replayed, decoded, taken) : replayed
            return [counted, [{ decoded, replayed: counted }]] as const
          }
        ),
        Stream.runForEach(({ decoded, replayed }) =>
          Option.contains(log.last, decoded.seq) ? goLive(replayed) : Effect.void
        ),
        // A decode defect, or the log's stream ending, stops the following, logged if it was live.
        Effect.onExitIf(
          (exit) => !HubStopping.isStopping(exit),
          (exit) =>
            Effect.when(
              Effect.logError(
                "LiveSlate: frames are no longer taken into the slate until the Hub restarts",
                Exit.isFailure(exit) ? exit.cause : "the log's stream ended"
              ),
              Deferred.isDone(caughtUp)
            )
        ),
        Effect.forkScoped
      )

      // A decode that dies during the replay fails the build, rather than leaving it waiting.
      const replay = Effect.fn("LiveSlate.replay")(function* () {
        yield* Option.match(log.last, { onNone: () => goLive(noneReplayed), onSome: () => Effect.void })
        const { frames, deliveries } = yield* Effect.raceFirst(
          Deferred.await(caughtUp),
          Fiber.join(following).pipe(Effect.andThen(Effect.never))
        )
        yield* Effect.annotateCurrentSpan({ "sportal.frames": frames, "sportal.deliveries": deliveries })
      })
      yield* replay()

      // The timer, from the end of the replay, so nothing ticks a replayed game between two recorded frames: on each
      // change, sleeps until the earliest game is due, then ticks to the clock's now. A tick that changes nothing (a
      // sleep that ended early, or a verdict that stayed) wakes again; a change restarts it. A defect is logged and
      // counted, and the timer tries again after a moment.
      const tickWhenDue = Effect.fnUntraced(function* (due: DateTime.Utc) {
        const sleeping = yield* DateTime.now
        yield* Effect.sleep(Duration.max(DateTime.distance(sleeping, due), Duration.zero))
        const woke = yield* DateTime.now
        yield* step(Option.none(), false, (held) => held.tick(woke))
      })
      const wake = SubscriptionRef.get(slate).pipe(
        Effect.flatMap((held) =>
          Option.match(held.earliestDue(), { onNone: () => Effect.never, onSome: tickWhenDue })
        ),
        Effect.catchDefect((defect) =>
          telemetry.timerDefect(defect).pipe(Effect.andThen(Effect.sleep(timerBackoff)))
        ),
        Effect.forever
      )
      yield* Effect.forkScoped(
        SubscriptionRef.changes(slate).pipe(
          Stream.switchMap(() => Stream.fromEffect(wake)),
          Stream.runDrain
        ),
        { startImmediately: true }
      )

      return Board.of({
        latest: SubscriptionRef.get(slate),
        changes: SubscriptionRef.changes(slate).pipe(Stream.changesWith((a, b) => a.publishesSameAs(b))),
        taken: Stream.fromPubSub(takes)
      })
    })
  )

  /** A still board of `slate`: no take, no tick, no change after it. */
  static layerTest(slate: Slate): Layer.Layer<Board> {
    return Layer.succeed(
      Board,
      Board.of({ latest: Effect.succeed(slate), changes: Stream.make(slate), taken: Stream.empty })
    )
  }
}

/** What the replay took, for its summary. */
interface Replayed {
  readonly frames: number
  readonly deliveries: number
  readonly plays: number
}

const noneReplayed: Replayed = { frames: 0, deliveries: 0, plays: 0 }

/** `replayed` with one more frame, `decoded`, which `taken` took. */
function countedIn(replayed: Replayed, decoded: Decoded, taken: Taken): Replayed {
  return {
    frames: replayed.frames + 1,
    deliveries: replayed.deliveries + decoded.deliveries.length,
    plays: replayed.plays + taken.events.filter(({ what }) => GameEventKind.$is("Played")(what)).length
  }
}

// How long the timer waits after a defect before it tries again.
const timerBackoff = Duration.seconds(1)
