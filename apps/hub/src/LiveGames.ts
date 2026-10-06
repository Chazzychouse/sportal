import { Delivery, type DeliverySource } from "@sportal/domain/Delivery"
import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import type { GameEvent } from "@sportal/domain/GameEvent"
import type { LeagueId } from "@sportal/domain/League"
import { LiveGame, LiveGameState } from "@sportal/domain/LiveGame"
import type { TeamId } from "@sportal/domain/Team"
import {
  Array as Arr,
  Cause,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Equal,
  Exit,
  Layer,
  Metric,
  Option,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef
} from "effect"

/** The fold of every delivery, in order: each league's last listing and every current game's live game. */
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
     * once and logs one summary line.
     */
    replay(
      deliveries: Stream.Stream<{ delivery: Delivery; at: DateTime.Utc; seq: number }>
    ): Effect.Effect<void>
    readonly latest: Effect.Effect<Folded>
    /** The latest first, then each change. */
    readonly changes: Stream.Stream<Folded>
    readonly events: Stream.Stream<{ readonly game: GameId; readonly event: GameEvent }>
  }
>()("sportal/hub/LiveGames") {
  /** Game `game`'s log annotations and metric attributes, read from `snapshot`. */
  static annotationsOf(game: GameId, snapshot: GameSnapshot) {
    return { game, league: snapshot.league, matchup: snapshot.matchup() }
  }

  /** The fold, empty, with its timer running for as long as the layer's scope is open. */
  static readonly layer: Layer.Layer<LiveGames> = Layer.effect(
    LiveGames,
    Effect.gen(function* () {
      // `reached` is the instant the fold has reached: every wake time at or before it has been ticked. It is kept
      // beside what is published so the two commit together, and is mapped out of `latest` and `changes`.
      const state = yield* SubscriptionRef.make<Folded & { readonly reached: Option.Option<DateTime.Utc> }>({
        seq: Option.none(),
        listed: new Map(),
        live: new Map(),
        reached: Option.none()
      })
      const events = yield* PubSub.unbounded<{ readonly game: GameId; readonly event: GameEvent }>()
      // Held by a replay for its whole run, so neither the timer nor a live take moves a replayed game between two
      // recorded deliveries.
      const replaying = yield* Semaphore.make(1)

      // Ticks to `at`, applies `delivery` if there is one, and hands what happened to `report`, all under the state's
      // lock; publishes only when the fold changed. Uninterruptible, so an interrupted caller never leaves telemetry
      // without its state; a report that dies leaves the state as it was, to be stepped again.
      const fold = (
        delivery: Option.Option<Delivery>,
        at: DateTime.Utc,
        seq: Option.Option<number>,
        report: (
          reports: ReadonlyArray<Report>,
          before: ReadonlyMap<GameId, LiveGame>,
          after: ReadonlyMap<GameId, LiveGame>
        ) => Effect.Effect<void>
      ) =>
        SubscriptionRef.modifySomeEffect(state, (folded) =>
          Effect.gen(function* () {
            const from = Option.getOrElse(folded.reached, () => at)
            const ticked = yield* tickTo({ live: folded.live, reports: [] }, from, at)
            const stepped = yield* Option.match(delivery, {
              onNone: () => Effect.succeed({ listed: folded.listed, ...ticked }),
              onSome: (delivery) => applied(folded.listed, ticked, delivery, at)
            })
            yield* report(stepped.reports, folded.live, stepped.live)
            const next = {
              seq: Option.orElse(seq, () => folded.seq),
              listed: stepped.listed,
              live: stepped.live,
              reached: Option.some(DateTime.max(from, at))
            }
            const changed = !sameFolded(next, folded) || !Equal.equals(next.reached, folded.reached)
            return [undefined, changed ? Option.some(next) : Option.none()] as const
          })
        ).pipe(Effect.uninterruptible)

      const live =
        (seq: Option.Option<number>) =>
        (
          reports: ReadonlyArray<Report>,
          before: ReadonlyMap<GameId, LiveGame>,
          after: ReadonlyMap<GameId, LiveGame>
        ) =>
          Effect.forEach(reports, (report) => reported(report, seq, events), { discard: true }).pipe(
            Effect.andThen(after === before ? Effect.void : countByState(after))
          )

      // The timer: on each change, sleeps until the earliest game is due, then ticks to the clock's now. A tick that
      // changes nothing (a sleep that ended early, or a verdict that stayed) loops; a change restarts it. A defect is
      // logged and counted, and the timer tries again after a moment.
      const wake = Effect.gen(function* () {
        const folded = yield* SubscriptionRef.get(state)
        const due = Option.flatMap(folded.reached, (from) => earliestDue(folded.live, from))
        yield* Option.match(due, {
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
        Effect.catchDefect((defect) =>
          Effect.logError("LiveGames: the timer raised a defect", Cause.die(defect)).pipe(
            Effect.andThen(Metric.update(gameDefects, 1)),
            Effect.andThen(Effect.sleep(timerBackoff))
          )
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
          yield* Effect.forEach(
            held.values(),
            (liveGame) =>
              gaugeState(liveGame, stateValues[liveGame.state._tag]).pipe(
                Effect.andThen(gaugeWatchability(liveGame))
              ),
            { discard: true }
          )
          yield* countByState(held)
          yield* Effect.logInfo(
            `LiveGames: replayed ${taken} deliveries, ${yield* Ref.get(plays)} plays; ${held.size} live games, in ${Duration.format(duration)}`
          )
        }, Semaphore.withPermit(replaying)),
        latest: Effect.map(SubscriptionRef.get(state), published),
        changes: SubscriptionRef.changes(state).pipe(Stream.map(published), Stream.changesWith(sameFolded)),
        events: Stream.fromPubSub(events)
      })
    })
  )
}

/** What the fold publishes: the last frame's `seq`, each league's last listing, and every current game's live game. */
type Folded = {
  readonly seq: Option.Option<number>
  readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly live: ReadonlyMap<GameId, LiveGame>
}

function published({ seq, listed, live }: Folded): Folded {
  return { seq, listed, live }
}

/** Whether `self` and `that` publish the same: a step that changed nothing hands back the same maps. */
function sameFolded(self: Folded, that: Folded): boolean {
  return self.live === that.live && self.listed === that.listed && Equal.equals(self.seq, that.seq)
}

/** What one step did to one game, for telemetry to tell. */
type Report = Data.TaggedEnum<{
  /** A snapshot was taken, ignored as behind, or kept (a tied poll that refreshed a pushed snapshot). */
  Took: {
    readonly snapshot: GameSnapshot
    readonly from: DeliverySource
    readonly outcome: "taken" | "behind" | "kept"
    readonly had: Option.Option<GameSnapshot>
  }
  Started: { readonly liveGame: LiveGame; readonly at: DateTime.Utc }
  Changed: { readonly before: LiveGame; readonly after: LiveGame; readonly at: DateTime.Utc }
  Stopped: { readonly liveGame: LiveGame; readonly at: DateTime.Utc }
  Happened: { readonly snapshot: GameSnapshot; readonly event: GameEvent }
  Dropped: { readonly game: GameId; readonly reason: "no game" }
  /** A step raised a defect; the game kept its last good live game. `snapshot` is the one at hand. */
  Raised: { readonly snapshot: GameSnapshot; readonly cause: Cause.Cause<never>; readonly by: string }
}>

/** Every current game's live game, and what the steps so far did. */
type Stepped = { readonly live: ReadonlyMap<GameId, LiveGame>; readonly reports: ReadonlyArray<Report> }

/**
 * Ticks, in wake order, every game due after `from` and at or before `at`, each at its own wake instant; games due at
 * the same instant tick together.
 */
function tickTo(stepped: Stepped, from: DateTime.Utc, at: DateTime.Utc): Effect.Effect<Stepped> {
  return Option.match(
    Option.filter(earliestDue(stepped.live, from), (due) => DateTime.isLessThanOrEqualTo(due, at)),
    {
      onNone: () => Effect.succeed(stepped),
      onSome: (due) =>
        Effect.reduce(
          [...stepped.live.values()].filter((liveGame) =>
            Option.exists(dueAt(liveGame, from), (instant) => DateTime.Equivalence(instant, due))
          ),
          () => stepped,
          (acc, liveGame) =>
            guarded(acc, liveGame.snapshot, "a tick", () =>
              settled(acc, liveGame.snapshot.id, due, Option.some(liveGame), liveGame.tick(due))
            )
        ).pipe(Effect.flatMap((ticked) => tickTo(ticked, due, at)))
    }
  )
}

/** The earliest instant after `from` at which a game's tick or its currency may change. */
function earliestDue(live: ReadonlyMap<GameId, LiveGame>, from: DateTime.Utc): Option.Option<DateTime.Utc> {
  return earliestOf([...live.values()].map((liveGame) => dueAt(liveGame, from)))
}

function dueAt(liveGame: LiveGame, from: DateTime.Utc): Option.Option<DateTime.Utc> {
  return earliestOf([liveGame.wakeAt(from), liveGame.currencyChangesAt(from)]).pipe(
    Option.filter((instant) => DateTime.isGreaterThan(instant, from))
  )
}

function earliestOf(instants: ReadonlyArray<Option.Option<DateTime.Utc>>): Option.Option<DateTime.Utc> {
  return Arr.match(Arr.getSomes(instants), {
    onEmpty: Option.none<DateTime.Utc>,
    onNonEmpty: (some) => Option.some(some.reduce(DateTime.min))
  })
}

function applied(
  listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>,
  stepped: Stepped,
  delivery: Delivery,
  at: DateTime.Utc
): Effect.Effect<Stepped & { readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>> }> {
  return Delivery.$match(delivery, {
    Listing: ({ league, games }) =>
      Effect.reduce(
        games,
        () => stepped,
        (acc, snapshot) => snapshotTaken(acc, snapshot, "poll", at)
      ).pipe(Effect.map((after) => ({ ...after, listed: new Map(listed).set(league, games) }))),
    Snapshot: ({ snapshot, from }) =>
      snapshotTaken(stepped, snapshot, from, at).pipe(Effect.map((after) => ({ ...after, listed }))),
    Plays: (plays) =>
      Option.match(Option.fromNullishOr(stepped.live.get(plays.game)), {
        onNone: () =>
          Effect.succeed({
            ...stepped,
            listed,
            reports: [...stepped.reports, Report.Dropped({ game: plays.game, reason: "no game" })]
          }),
        onSome: (liveGame) =>
          guarded(stepped, liveGame.snapshot, "a delivery", () =>
            settled(stepped, plays.game, at, Option.some(liveGame), liveGame.take(plays, at))
          ).pipe(Effect.map((after) => ({ ...after, listed })))
      })
  })
}

function snapshotTaken(
  stepped: Stepped,
  snapshot: GameSnapshot,
  from: DeliverySource,
  at: DateTime.Utc
): Effect.Effect<Stepped> {
  return guarded(stepped, snapshot, "a delivery", () => {
    const current = Option.fromNullishOr(stepped.live.get(snapshot.id))
    const step = Option.match(current, {
      onNone: () => ({ liveGame: Option.some(LiveGame.start(snapshot, from, at)), events: [] }),
      onSome: (liveGame) => liveGame.take(Delivery.Snapshot({ snapshot, from }), at)
    })
    const took = Report.Took({
      snapshot,
      from,
      outcome: Option.match(step.liveGame, {
        onNone: () => "behind",
        onSome: (liveGame) => (liveGame.snapshot === snapshot ? "taken" : "kept")
      }),
      had: Option.map(current, (liveGame) => liveGame.snapshot)
    })
    return settled({ ...stepped, reports: [...stepped.reports, took] }, snapshot.id, at, current, step)
  })
}

/**
 * Game `id` after a step at `at` from `current` (none for a game the fold does not hold): holds the step's new live
 * game, if any, while it is current, and lets it go once it is not. A game that was never held and is not current is
 * not held, and nothing is reported of it.
 */
function settled(
  stepped: Stepped,
  id: GameId,
  at: DateTime.Utc,
  current: Option.Option<LiveGame>,
  step: { readonly liveGame: Option.Option<LiveGame>; readonly events: ReadonlyArray<GameEvent> }
): Stepped {
  return Option.match(
    Option.orElse(step.liveGame, () => current),
    {
      onNone: () => stepped,
      onSome: (after) => {
        const reports = [
          ...stepped.reports,
          ...Option.match(step.liveGame, {
            onNone: () => [],
            onSome: () =>
              Option.match(current, {
                onNone: () => [Report.Started({ liveGame: after, at })],
                onSome: (before) => [Report.Changed({ before, after, at })]
              })
          }),
          ...step.events.map((event) => Report.Happened({ snapshot: after.snapshot, event }))
        ]
        if (after.isCurrent(at)) {
          return {
            live: Option.isSome(step.liveGame) ? new Map(stepped.live).set(id, after) : stepped.live,
            reports
          }
        }
        if (Option.isNone(current)) return stepped
        return {
          live: new Map([...stepped.live].filter(([game]) => game !== id)),
          reports: [...reports, Report.Stopped({ liveGame: after, at })]
        }
      }
    }
  )
}

/** Runs one game's pure step; a defect keeps what came before and reports it with the snapshot at hand. */
function guarded(
  stepped: Stepped,
  snapshot: GameSnapshot,
  by: string,
  step: () => Stepped
): Effect.Effect<Stepped> {
  return Effect.sync(step).pipe(
    Effect.catchDefect((defect) =>
      Effect.succeed({
        ...stepped,
        reports: [...stepped.reports, Report.Raised({ snapshot, cause: Cause.die(defect), by })]
      })
    )
  )
}

/** A report's logs, metrics, and published events, as a live fold tells them. */
function reported(
  report: Report,
  seq: Option.Option<number>,
  events: PubSub.PubSub<{ readonly game: GameId; readonly event: GameEvent }>
): Effect.Effect<void> {
  return Report.$match(report, {
    Took: ({ snapshot, from, outcome, had }) =>
      Effect.logDebug(
        `LiveGames: ${snapshot.matchup()}: ${outcome} ${from} ${gameTimeOf(snapshot)}${Option.match(had, {
          onNone: () => "",
          onSome: (had) => ` (had ${gameTimeOf(had)})`
        })}`
      ).pipe(
        Effect.andThen(
          Metric.update(
            Metric.withAttributes(snapshots, {
              outcome,
              source: from,
              ...LiveGames.annotationsOf(snapshot.id, snapshot)
            }),
            1
          )
        ),
        Effect.annotateLogs(LiveGames.annotationsOf(snapshot.id, snapshot))
      ),
    Started: ({ liveGame, at }) =>
      logLifecycle("started", liveGame, at).pipe(
        Effect.andThen(gaugeState(liveGame, stateValues[liveGame.state._tag])),
        Effect.andThen(gaugeWatchability(liveGame)),
        Effect.annotateLogs(LiveGames.annotationsOf(liveGame.snapshot.id, liveGame.snapshot))
      ),
    Changed: ({ before, after, at }) =>
      gaugeState(after, stateValues[after.state._tag]).pipe(
        Effect.andThen(logTransition(before, after, at)),
        Effect.andThen(gaugeWatchability(after)),
        Effect.andThen(before.watchability.lull === after.watchability.lull ? Effect.void : logLull(after)),
        Effect.annotateLogs(LiveGames.annotationsOf(after.snapshot.id, after.snapshot))
      ),
    Stopped: ({ liveGame, at }) =>
      logLifecycle("stopped", liveGame, at).pipe(
        Effect.andThen(gaugeState(liveGame, 0)),
        Effect.annotateLogs(LiveGames.annotationsOf(liveGame.snapshot.id, liveGame.snapshot))
      ),
    Happened: ({ snapshot, event }) =>
      logEvent(event, snapshot).pipe(
        Effect.andThen(
          event._tag === "Played"
            ? Metric.update(Metric.withAttributes(plays, { league: snapshot.league }), 1)
            : Effect.void
        ),
        Effect.andThen(PubSub.publish(events, { game: snapshot.id, event })),
        Effect.annotateLogs(LiveGames.annotationsOf(snapshot.id, snapshot))
      ),
    Dropped: ({ game, reason }) =>
      Effect.logDebug(`LiveGames: plays for game ${game} dropped: ${reason}`).pipe(
        Effect.andThen(Metric.update(Metric.withAttributes(deliveriesDropped, { reason }), 1))
      ),
    Raised: ({ snapshot, cause, by }) =>
      logDefect(`LiveGames: ${by} raised a defect; keeping the last good live game`, cause, snapshot, seq)
  })
}

/** A report as a replay tells it: only plays are counted for the summary, and a defect is still logged. */
function quiet(report: Report, seq: Option.Option<number>, plays: Ref.Ref<number>): Effect.Effect<void> {
  return Report.$match(report, {
    Took: () => Effect.void,
    Started: () => Effect.void,
    Changed: () => Effect.void,
    Stopped: () => Effect.void,
    Happened: ({ event }) =>
      event._tag === "Played" ? Ref.update(plays, (count) => count + 1) : Effect.void,
    Dropped: () => Effect.void,
    Raised: ({ snapshot, cause, by }) =>
      logDefect(
        `LiveGames: ${by} raised a defect in replay; keeping the last good live game`,
        cause,
        snapshot,
        seq
      )
  })
}

/**
 * Logs a defect at Error with the game's annotations, the frame's `seq`, and `snapshot` encoded, and counts it. A
 * snapshot that cannot be encoded is logged by its id, so the log itself never raises a defect.
 */
function logDefect(
  message: string,
  cause: Cause.Cause<never>,
  snapshot: GameSnapshot,
  seq: Option.Option<number>
): Effect.Effect<void> {
  return Effect.logError(message, cause).pipe(
    Effect.andThen(Metric.update(gameDefects, 1)),
    Effect.annotateLogs({
      ...LiveGames.annotationsOf(snapshot.id, snapshot),
      snapshot: Exit.match(Schema.encodeExit(GameSnapshot)(snapshot), {
        onSuccess: (encoded) => encoded,
        onFailure: () => snapshot.id
      })
    }),
    Effect.annotateLogs(Option.match(seq, { onNone: () => ({}), onSome: (seq) => ({ seq }) }))
  )
}

function gaugeState(liveGame: LiveGame, value: number): Effect.Effect<void> {
  return Metric.update(
    Metric.withAttributes(gameState, LiveGames.annotationsOf(liveGame.snapshot.id, liveGame.snapshot)),
    value
  )
}

function gaugeWatchability(liveGame: LiveGame): Effect.Effect<void> {
  const attributes = LiveGames.annotationsOf(liveGame.snapshot.id, liveGame.snapshot)
  return Metric.update(
    Metric.withAttributes(watchabilityScore, attributes),
    liveGame.watchability.score
  ).pipe(
    Effect.andThen(
      Metric.update(Metric.withAttributes(lulls, attributes), liveGame.watchability.lull ? 1 : 0)
    )
  )
}

/** A lull beginning or ending, at Info, with its reasons. */
function logLull(liveGame: LiveGame): Effect.Effect<void> {
  const { lull, score, reasons } = liveGame.watchability
  return Effect.logInfo(
    `LiveGames: ${liveGame.snapshot.matchup()}: a lull ${lull ? "began" : "ended"}, watchability ${score}${
      reasons.length === 0 ? "" : ` (${reasons.join(", ")})`
    }`
  )
}

/** Info for a game that is current, Debug otherwise. */
function logLifecycle(
  what: "started" | "stopped",
  liveGame: LiveGame,
  now: DateTime.Utc
): Effect.Effect<void> {
  return Effect.logWithLevel(liveGame.isCurrent(now) ? "Info" : "Debug")(
    `LiveGames: ${liveGame.snapshot.matchup()}: ${what}, ${liveGame.state._tag} at ${gameTimeOf(liveGame.snapshot)}`
  )
}

function logTransition(before: LiveGame, after: LiveGame, now: DateTime.Utc): Effect.Effect<void> {
  const from = before.state._tag
  const to = after.state._tag
  if (from === to) return Effect.void
  const lastUpdatedAt = LiveGameState.$match(before.state, {
    Upcoming: () => Option.none(),
    Live: ({ updatedAt }) => Option.some(updatedAt),
    Stale: ({ lastUpdatedAt }) => Option.some(lastUpdatedAt),
    Over: () => Option.none()
  })
  const silent = Option.map(lastUpdatedAt, (at) => DateTime.distance(at, now))
  const since = Option.match(silent, {
    onNone: () => "",
    onSome: (duration) => `, ${Math.round(Duration.toSeconds(duration))} s since the last update`
  })
  return Effect.logInfo(
    `LiveGames: ${after.snapshot.matchup()}: ${from} → ${to} at ${gameTimeOf(after.snapshot)}${since}`
  ).pipe(
    Effect.andThen(Metric.update(Metric.withAttributes(transitions, { from, to }), 1)),
    Effect.andThen(
      Option.match(silent, {
        onNone: () => Effect.void,
        onSome: (duration) =>
          from === "Stale"
            ? Metric.update(
                Metric.withAttributes(
                  staleDuration,
                  LiveGames.annotationsOf(after.snapshot.id, after.snapshot)
                ),
                duration
              )
            : Effect.void
      })
    )
  )
}

/** Info, with the event's fields as annotations, so the dashboard can mark it on the game's timeline. */
function logEvent(event: GameEvent, snapshot: GameSnapshot): Effect.Effect<void> {
  const { _tag, ...fields } = event
  const team = "team" in event ? ` ${teamOf(event.team, snapshot)}` : ""
  return Effect.logInfo(`LiveGames: ${snapshot.matchup()}: ${_tag}${team} at ${gameTimeOf(snapshot)}`).pipe(
    Effect.andThen(
      Metric.update(
        Metric.withAttributes(gameEvents, { ...LiveGames.annotationsOf(snapshot.id, snapshot), event: _tag }),
        1
      )
    ),
    Effect.annotateLogs({ ...fields, event: _tag })
  )
}

function teamOf(id: TeamId, snapshot: GameSnapshot): string {
  return [snapshot.home.team, snapshot.away.team].find((team) => team.id === id)?.abbreviation ?? id
}

function gameTimeOf(snapshot: GameSnapshot): string {
  return `${snapshot.status}, period ${snapshot.period}, ${snapshot.clock}`
}

function sleepUntil(at: DateTime.Utc): Effect.Effect<void> {
  return DateTime.now.pipe(
    Effect.flatMap((now) => Effect.sleep(Duration.max(DateTime.distance(now, at), Duration.zero)))
  )
}

function countByState(games: ReadonlyMap<GameId, LiveGame>): Effect.Effect<void> {
  const states = [...games.values()].map(({ state }) => state._tag)
  return Effect.forEach(
    everyState,
    (state) =>
      Metric.update(
        Metric.withAttributes(liveGamesByState, { state }),
        states.filter((other) => other === state).length
      ),
    { discard: true }
  )
}

const Report = Data.taggedEnum<Report>()

// Each state's value on `sportal_game_state`, where 0 is a game the fold has let go. Written as a record so that a new
// state fails to compile here.
const stateValues = { Upcoming: 1, Live: 2, Stale: 3, Over: 4 } satisfies Record<
  LiveGameState["_tag"],
  number
>

// Every state, so a state with no games reads 0.
const everyState = Object.keys(stateValues)

// How long the timer waits after a defect before it tries again.
const timerBackoff = Duration.seconds(1)

const liveGamesByState = Metric.gauge("sportal_live_games", {
  description: "Live games in the fold, by state"
})

const snapshots = Metric.counter("sportal_snapshots", {
  description:
    "Snapshots the fold took, ignored as behind its live game, or kept (a tied poll that refreshed a pushed snapshot)",
  incremental: true
})

const transitions = Metric.counter("sportal_transitions", {
  description: "Changes of a live game's state, by the state before and after",
  incremental: true
})

const gameDefects = Metric.counter("sportal_game_defects", {
  description: "Defects in the fold: a step on one game, or the timer",
  incremental: true
})

const gameState = Metric.gauge("sportal_game_state", {
  description: "A game's state, by game: 1 Upcoming, 2 Live, 3 Stale, 4 Over, 0 once the fold lets it go"
})

const gameEvents = Metric.counter("sportal_game_events", {
  description: "Events in a game, by game and event",
  incremental: true
})

const plays = Metric.counter("sportal_plays", { description: "New plays, by league", incremental: true })

const deliveriesDropped = Metric.counter("sportal_deliveries_dropped", {
  description: "Deliveries the fold could not apply, by reason",
  incremental: true
})

const staleDuration = Metric.timer("sportal_stale_duration", {
  description: "How long a stale game went without a snapshot, recorded when it is taken again",
  boundaries: [90, 120, 180, 300, 600, 900, 1800, 3600].map((seconds) => seconds * 1000)
})

const takeDuration = Metric.timer("sportal_take_duration", {
  description: "How long the fold takes to apply one delivery, as its caller waits"
})

const watchabilityScore = Metric.gauge("sportal_watchability", {
  description: "How worth watching a game is, 0–100, by game"
})

const lulls = Metric.gauge("sportal_lull", {
  description: "Whether a game is in a lull (1) or not (0), by game"
})
