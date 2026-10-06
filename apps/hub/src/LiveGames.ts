import type { Delivery } from "@sportal/domain/Delivery"
import * as Fold from "@sportal/domain/LiveGames"
import {
  Context,
  type Data,
  DateTime,
  Duration,
  Effect,
  Equal,
  Layer,
  Option,
  PubSub,
  Ref,
  Semaphore,
  Stream,
  SubscriptionRef
} from "effect"
import { countByState, gaugeHeld, quiet, reported, takeDuration, timerDefect } from "./LiveGamesTelemetry.ts"

/** The live games, run: the domain fold of every delivery in order, its timer, its telemetry, and its game events. */
export class LiveGames extends Context.Service<
  LiveGames,
  {
    /**
     * Applies `delivery`, received at `at` as frame `seq` (scripted deliveries have none), first ticking every game
     * whose wake time is at or before `at`. Callers must stamp `at` in the order they call `take` (Ingest takes from
     * one stream): a tick never goes back. A take during a replay waits for the replay to end.
     */
    take(delivery: Delivery, at: DateTime.Utc, seq: Option.Option<number>): Effect.Effect<void>
    /**
     * Runs `deliveries` through `take` with no per-game telemetry and no `events`, then sets each held game's gauges
     * once and logs one summary line. Returns how many deliveries it took.
     */
    replay(
      deliveries: Stream.Stream<{ delivery: Delivery; at: DateTime.Utc; seq: number }>
    ): Effect.Effect<number>
    readonly latest: Effect.Effect<Fold.LiveGames>
    /** The latest first, then each change. `reached` alone changing is not a change. */
    readonly changes: Stream.Stream<Fold.LiveGames>
    readonly events: Stream.Stream<Data.TaggedEnum.Value<Fold.FoldReport, "Happened">>
  }
>()("sportal/hub/LiveGames") {
  /** The fold, empty, with its timer running for as long as the layer's scope is open. */
  static readonly layer: Layer.Layer<LiveGames> = Layer.effect(
    LiveGames,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make(Fold.LiveGames.empty)
      const events = yield* PubSub.unbounded<Data.TaggedEnum.Value<Fold.FoldReport, "Happened">>()
      // Held by a replay for its whole run, so neither the timer nor a live take moves a replayed game between two
      // recorded deliveries.
      const replaying = yield* Semaphore.make(1)

      // Steps the fold and hands what happened to `report`, all under the state's lock; publishes only when the fold
      // changed. Uninterruptible, so an interrupted caller never leaves telemetry without its state; a report that
      // dies leaves the state as it was, to be stepped again.
      const fold = (
        delivery: Option.Option<Delivery>,
        at: DateTime.Utc,
        seq: Option.Option<number>,
        report: (
          reports: ReadonlyArray<Fold.FoldReport>,
          before: Fold.LiveGames,
          after: Fold.LiveGames
        ) => Effect.Effect<void>
      ) =>
        SubscriptionRef.modifySomeEffect(state, (folded) =>
          Effect.gen(function* () {
            const { next, reports } = yield* folded.step(delivery, at, seq)
            yield* report(reports, folded, next)
            const changed = !next.publishesSameAs(folded) || !Equal.equals(next.reached, folded.reached)
            return [undefined, changed ? Option.some(next) : Option.none()] as const
          })
        ).pipe(Effect.uninterruptible)

      const live =
        (seq: Option.Option<number>) =>
        (reports: ReadonlyArray<Fold.FoldReport>, before: Fold.LiveGames, after: Fold.LiveGames) =>
          Effect.forEach(reports, (report) => reported(report, seq, events), { discard: true }).pipe(
            Effect.andThen(after.live === before.live ? Effect.void : countByState(after.live))
          )

      // The timer: on each change, sleeps until the earliest game is due, then ticks to the clock's now. A tick that
      // changes nothing (a sleep that ended early, or a verdict that stayed) loops; a change restarts it. A defect is
      // logged and counted, and the timer tries again after a moment.
      const wake = Effect.gen(function* () {
        const folded = yield* SubscriptionRef.get(state)
        yield* Option.match(folded.earliestDue(), {
          onNone: () => Effect.never,
          onSome: (due) =>
            sleepUntil(due).pipe(
              Effect.andThen(
                DateTime.now.pipe(
                  Effect.flatMap((now) => fold(Option.none(), now, Option.none(), live(Option.none()))),
                  Semaphore.withPermit(replaying)
                )
              )
            )
        })
      }).pipe(
        Effect.catchDefect((defect) => timerDefect(defect).pipe(Effect.andThen(Effect.sleep(timerBackoff)))),
        Effect.forever
      )
      yield* Effect.forkScoped(
        SubscriptionRef.changes(state).pipe(
          Stream.switchMap(() => Stream.fromEffect(wake)),
          Stream.runDrain
        ),
        { startImmediately: true }
      )

      return LiveGames.of({
        take: Effect.fn("LiveGames.take")(function* (
          delivery: Delivery,
          at: DateTime.Utc,
          seq: Option.Option<number>
        ) {
          yield* Effect.annotateCurrentSpan({ "sportal.delivery": delivery._tag })
          yield* fold(Option.some(delivery), at, seq, live(seq)).pipe(Semaphore.withPermit(replaying))
        }, Effect.trackDuration(takeDuration)),
        replay: Effect.fn("LiveGames.replay")(function* (deliveries) {
          const plays = yield* Ref.make(0)
          const [duration, taken] = yield* deliveries.pipe(
            Stream.runFoldEffect(
              () => 0,
              (count, { delivery, at, seq }) =>
                fold(Option.some(delivery), at, Option.some(seq), (reports) =>
                  Effect.forEach(reports, (report) => quiet(report, Option.some(seq), plays), {
                    discard: true
                  })
                ).pipe(Effect.as(count + 1))
            ),
            Effect.timed
          )
          const held = (yield* SubscriptionRef.get(state)).live
          yield* Effect.forEach(held.values(), gaugeHeld, { discard: true })
          yield* countByState(held)
          yield* Effect.logInfo(
            `LiveGames: replayed ${taken} deliveries, ${yield* Ref.get(plays)} plays; ${held.size} live games, in ${Duration.format(duration)}`
          )
          return taken
        }, Semaphore.withPermit(replaying)),
        latest: SubscriptionRef.get(state),
        changes: SubscriptionRef.changes(state).pipe(Stream.changesWith((a, b) => a.publishesSameAs(b))),
        events: Stream.fromPubSub(events)
      })
    })
  )
}

function sleepUntil(at: DateTime.Utc): Effect.Effect<void> {
  return DateTime.now.pipe(
    Effect.flatMap((now) => Effect.sleep(Duration.max(DateTime.distance(now, at), Duration.zero)))
  )
}

// How long the timer waits after a defect before it tries again.
const timerBackoff = Duration.seconds(1)
