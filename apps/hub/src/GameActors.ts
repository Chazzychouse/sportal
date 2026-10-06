import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LiveGame, LiveGameState } from "@sportal/domain/LiveGame"
import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Filter,
  Layer,
  Metric,
  Option,
  Schema,
  Stream,
  SubscriptionRef
} from "effect"
import { Entity, type Sharding } from "effect/cluster"
import { Rpc } from "effect/rpc"

/** Which feed a snapshot came from. */
export const DeliverySource = Schema.Literals(["push", "poll"])
export type DeliverySource = typeof DeliverySource.Type

/** The game actors: one cluster entity per game, each deciding its game's live state from the snapshots sent to it. */
export class GameActors extends Context.Service<
  GameActors,
  {
    /** Sends a snapshot to its game's actor and waits until the actor has taken or ignored it. */
    readonly receive: (snapshot: GameSnapshot, source: DeliverySource) => Effect.Effect<void>
    /** Every running actor's live game, by game id. */
    readonly liveGames: Effect.Effect<ReadonlyMap<GameId, LiveGame>>
    /** Every running actor's live game, by game id, on each change. */
    readonly changes: Stream.Stream<ReadonlyMap<GameId, LiveGame>>
  }
>()("sportal/hub/GameActors") {
  /** The service, its entity, and its registry, on the cluster provided by the caller. */
  static readonly layer: Layer.Layer<GameActors, never, Sharding.Sharding> = Layer.suspend(() =>
    // Suspended because the entity and the registry are declared below this class.
    Layer.effect(
      GameActors,
      Effect.gen(function* () {
        const clientFor = yield* Game.client
        const liveGames = yield* LiveGames
        return GameActors.of({
          receive: Effect.fn("GameActors.receive")(function* (
            snapshot: GameSnapshot,
            source: DeliverySource
          ) {
            yield* Effect.annotateCurrentSpan({ "sportal.game": snapshot.id, "sportal.source": source })
            yield* clientFor(snapshot.id)
              .Receive({ snapshot, source })
              .pipe(
                Effect.catch((error) => logDefect(undelivered, Cause.fail(error), snapshot.id, snapshot)),
                Effect.catchDefect((defect) =>
                  logDefect(undelivered, Cause.die(defect), snapshot.id, snapshot)
                )
              )
          }, Effect.trackDuration(receiveDuration)),
          liveGames: liveGames.get,
          changes: liveGames.changes
        })
      })
    ).pipe(Layer.provide(gameEntity), Layer.provide(LiveGames.layer))
  )
}

const undelivered = "GameActors: a game actor did not take a snapshot"

/**
 * Logs a defect or a cluster error at Error with game `game`'s annotations and `snapshot` encoded, and counts it. A
 * snapshot that cannot be encoded is logged by its id, so the log itself never raises a defect.
 */
function logDefect(
  message: string,
  cause: Cause.Cause<unknown>,
  game: GameId,
  snapshot: GameSnapshot
): Effect.Effect<void> {
  return Effect.logError(message, cause).pipe(
    Effect.andThen(Metric.update(gameDefects, 1)),
    Effect.annotateLogs({
      ...annotationsOf(game, snapshot),
      snapshot: Exit.match(Schema.encodeExit(GameSnapshot)(snapshot), {
        onSuccess: (encoded) => encoded,
        onFailure: () => snapshot.id
      })
    })
  )
}

function annotationsOf(game: GameId, snapshot: GameSnapshot) {
  return { game, league: snapshot.league, matchup: snapshot.matchup() }
}

const Receive = Rpc.make("Receive", { payload: { snapshot: GameSnapshot, source: DeliverySource } })

/** The game actor entity, keyed by game id. Exported for its tests, which address an entity directly. */
export const Game = Entity.make("Game", [Receive])

const gameEntity = Game.toLayer(
  Effect.gen(function* () {
    const id = GameId.make((yield* Entity.CurrentAddress).entityId)
    const liveGames = yield* LiveGames
    const state = yield* SubscriptionRef.make(Option.none<LiveGame>())
    yield* Effect.annotateLogsScoped({ game: id })
    yield* Metric.modify(gameActors, 1)
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* liveGames.remove(id)
        yield* Metric.modify(gameActors, -1)
        const now = yield* DateTime.now
        yield* Option.match(yield* SubscriptionRef.get(state), {
          onNone: () => Effect.void,
          onSome: (liveGame) =>
            logLifecycle("stopped", liveGame, now).pipe(asGame(liveGame.snapshot, "stopping"), Effect.asVoid)
        })
      })
    )
    // The registry is written under the state's lock, so it never lags the state or takes an older live game.
    // `step` gives the new live game, or none when nothing changes: then nothing is written, logged, or published.
    // Returns the live game before the step and the step's result.
    const change = (now: DateTime.Utc, step: (current: Option.Option<LiveGame>) => Option.Option<LiveGame>) =>
      SubscriptionRef.modifySomeEffect(state, (current) => {
        const next = step(current)
        return Option.match(next, {
          onNone: () => Effect.void,
          onSome: (liveGame) =>
            liveGames.set(id, liveGame).pipe(
              Effect.andThen(
                Option.match(current, {
                  onNone: () => logLifecycle("started", liveGame, now),
                  onSome: (before) => logTransition(before, liveGame, now)
                })
              )
            )
        }).pipe(Effect.as([[current, next], Option.map(next, Option.some)] as const))
      })
    // Each stream guards all of its work on a live game with `asGame`, so a defect is logged and the stream carries on
    // to the next change. Restarting would run the same step on the same live game again, in a loop.
    yield* Effect.forkScoped(
      SubscriptionRef.changes(state).pipe(
        Stream.filterMap(Filter.fromPredicateOption((current) => current)),
        Stream.switchMap((liveGame) =>
          Stream.fromEffect(staleOn(liveGame).pipe(asGame(liveGame.snapshot, "the stale timer")))
        ),
        Stream.runDrain
      ),
      { startImmediately: true }
    )
    yield* Effect.forkScoped(
      SubscriptionRef.changes(state).pipe(
        Stream.filterMap(Filter.fromPredicateOption((current) => current)),
        Stream.switchMap(currentOn),
        Stream.changesWith((before, after) => before.current === after.current),
        Stream.runForEach(({ liveGame, current }) =>
          Entity.keepAlive(current).pipe(asGame(liveGame.snapshot, "keep-alive"))
        )
      ),
      { startImmediately: true }
    )
    return Game.of({
      Receive: ({ payload: { snapshot, source } }) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "sportal.game": id,
            "sportal.league": snapshot.league,
            "sportal.source": source
          })
          if (snapshot.id !== id) {
            return yield* Effect.die(new Error(`Game actor ${id} was sent a snapshot of game ${snapshot.id}`))
          }
          const now = yield* DateTime.now
          const [before, next] = yield* change(
            now,
            Option.match({
              onNone: () => Option.some(LiveGame.start(snapshot, now)),
              onSome: (liveGame) => liveGame.receive(snapshot, now)
            })
          )
          const outcome = Option.isSome(next) ? "taken" : "behind"
          yield* Effect.logDebug(
            `GameActors: ${snapshot.matchup()}: ${outcome} ${source} ${gameTimeOf(snapshot)}${Option.match(
              before,
              {
                onNone: () => "",
                onSome: (liveGame) => ` (had ${gameTimeOf(liveGame.snapshot)})`
              }
            )}`
          )
          yield* Metric.update(Metric.withAttributes(snapshots, { outcome, source }), 1)
        }).pipe(asGame(snapshot, "a snapshot"), Effect.asVoid)
    })

    /**
     * Runs `effect` with the game's log annotations, giving its value, or none after a defect. A defect is logged
     * with the snapshot at hand and counted, and the game keeps its last good live game.
     */
    function asGame(snapshot: GameSnapshot, raisedBy: string) {
      return <A, R>(effect: Effect.Effect<A, never, R>): Effect.Effect<Option.Option<A>, never, R> =>
        effect.pipe(
          Effect.asSome,
          Effect.catchDefect((defect) =>
            logDefect(
              `GameActors: ${raisedBy} raised a defect; keeping the last good live game`,
              Cause.die(defect),
              id,
              snapshot
            ).pipe(Effect.as(Option.none<A>()))
          ),
          Effect.annotateLogs(annotationsOf(id, snapshot))
        )
    }

    /**
     * For a live game that has a stale time, sleeps until then and ticks. A sleep can end a moment early on a real
     * clock, where the tick changes nothing; it then sleeps the rest of the way.
     */
    function staleOn(liveGame: LiveGame): Effect.Effect<void> {
      return Effect.suspend(() =>
        Option.match(liveGame.staleAt(), {
          onNone: () => Effect.void,
          onSome: (staleAt) =>
            Effect.gen(function* () {
              yield* sleepUntil(staleAt)
              const now = yield* DateTime.now
              yield* change(
                now,
                Option.flatMap((current) => current.tick(now))
              )
              return now
            }).pipe(Effect.repeat({ while: (now) => DateTime.isLessThan(now, staleAt) }), Effect.asVoid)
        })
      )
    }

    /**
     * Whether a live game is current: now, and again each time that changes with no snapshot. A sleep that ends a
     * moment early finds the same value, which keep-alive drops, and sleeps the rest of the way.
     */
    function currentOn(liveGame: LiveGame): Stream.Stream<{ liveGame: LiveGame; current: boolean }> {
      return Stream.fromEffect(
        DateTime.now.pipe(
          Effect.map((now) => ({
            current: liveGame.isCurrent(now),
            changesAt: liveGame.currencyChangesAt(now)
          })),
          asGame(liveGame.snapshot, "keep-alive")
        )
      ).pipe(
        Stream.filterMap(Filter.fromPredicateOption((guarded) => guarded)),
        Stream.flatMap(({ current, changesAt }) =>
          Stream.make({ liveGame, current }).pipe(
            Stream.concat(
              Option.match(changesAt, {
                onNone: () => Stream.empty,
                onSome: (at) =>
                  Stream.fromEffect(sleepUntil(at).pipe(asGame(liveGame.snapshot, "keep-alive"))).pipe(
                    Stream.filterMap(Filter.fromPredicateOption((slept) => slept)),
                    Stream.flatMap(() => currentOn(liveGame))
                  )
              })
            )
          )
        )
      )
    }
  }),
  { maxIdleTime: "5 minutes", disableFatalDefects: true }
)

/** Info for a game that is current, Debug otherwise, so a quiet slate's actors do not fill the logs. */
function logLifecycle(
  what: "started" | "stopped",
  liveGame: LiveGame,
  now: DateTime.Utc
): Effect.Effect<void> {
  return Effect.logWithLevel(liveGame.isCurrent(now) ? "Info" : "Debug")(
    `GameActors: ${liveGame.snapshot.matchup()}: ${what}, ${liveGame.state._tag} at ${gameTimeOf(liveGame.snapshot)}`
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
  const since = Option.match(lastUpdatedAt, {
    onNone: () => "",
    onSome: (at) => `, ${Math.round(Duration.toSeconds(DateTime.distance(at, now)))} s since the last update`
  })
  return Effect.logInfo(
    `GameActors: ${after.snapshot.matchup()}: ${from} → ${to} at ${gameTimeOf(after.snapshot)}${since}`
  ).pipe(Effect.andThen(Metric.update(Metric.withAttributes(transitions, { from, to }), 1)))
}

function gameTimeOf(snapshot: GameSnapshot): string {
  return `${snapshot.status}, period ${snapshot.period}, ${snapshot.clock}`
}

function sleepUntil(at: DateTime.Utc): Effect.Effect<void> {
  return DateTime.now.pipe(
    Effect.flatMap((now) => Effect.sleep(Duration.max(DateTime.distance(now, at), Duration.zero)))
  )
}

/** Every running actor's live game. An actor writes its own on every change and removes it when it stops. */
class LiveGames extends Context.Service<
  LiveGames,
  {
    readonly get: Effect.Effect<ReadonlyMap<GameId, LiveGame>>
    readonly changes: Stream.Stream<ReadonlyMap<GameId, LiveGame>>
    readonly set: (id: GameId, liveGame: LiveGame) => Effect.Effect<void>
    readonly remove: (id: GameId) => Effect.Effect<void>
  }
>()("sportal/hub/GameActors/LiveGames") {
  static readonly layer = Layer.effect(
    LiveGames,
    Effect.gen(function* () {
      const all = yield* SubscriptionRef.make<ReadonlyMap<GameId, LiveGame>>(new Map())
      const update = (f: (games: ReadonlyMap<GameId, LiveGame>) => ReadonlyMap<GameId, LiveGame>) =>
        SubscriptionRef.updateEffect(all, (games) => {
          const next = f(games)
          return countByState(next).pipe(Effect.as(next))
        })
      return LiveGames.of({
        get: SubscriptionRef.get(all),
        changes: SubscriptionRef.changes(all),
        set: (id, liveGame) => update((games) => new Map(games).set(id, liveGame)),
        remove: (id) => update((games) => new Map([...games].filter(([game]) => game !== id)))
      })
    })
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

// Every state, so a state with no games reads 0. Written as a record so that a new state fails to compile here.
const everyState = Object.keys({ Upcoming: 0, Live: 0, Stale: 0, Over: 0 } satisfies Record<
  LiveGameState["_tag"],
  0
>)

const gameActors = Metric.gauge("sportal_game_actors", { description: "Game actors running" })

const liveGamesByState = Metric.gauge("sportal_live_games", {
  description: "Live games in the registry, by state"
})

const snapshots = Metric.counter("sportal_snapshots", {
  description: "Snapshots a game actor took, or ignored as behind its live game",
  incremental: true
})

const transitions = Metric.counter("sportal_transitions", {
  description: "Changes of a live game's state, by the state before and after",
  incremental: true
})

const gameDefects = Metric.counter("sportal_game_defects", {
  description: "Defects in a game actor, and snapshots a game actor did not take",
  incremental: true
})

const receiveDuration = Metric.timer("sportal_receive_duration", {
  description: "How long a game actor takes to take or ignore a snapshot, as its sender waits"
})
