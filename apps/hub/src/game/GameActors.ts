import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LiveGame } from "@sportal/domain/LiveGame"
import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Filter,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef
} from "effect"
import {
  Entity,
  MessageStorage,
  RunnerHealth,
  RunnerStorage,
  Runners,
  ShardId,
  Sharding,
  ShardingConfig
} from "effect/cluster"
import { Rpc } from "effect/rpc"

/** The game actors: one cluster entity per game, each deciding its game's live state from the snapshots sent to it. */
export class GameActors extends Context.Service<
  GameActors,
  {
    /** Sends a snapshot to its game's actor and waits until the actor has taken or ignored it. */
    readonly receive: (snapshot: GameSnapshot) => Effect.Effect<void>
    /** Every running actor's live game, by game id. */
    readonly liveGames: Effect.Effect<ReadonlyMap<GameId, LiveGame>>
    /** Every running actor's live game, by game id, on each change. */
    readonly changes: Stream.Stream<ReadonlyMap<GameId, LiveGame>>
  }
>()("sportal/hub/GameActors") {
  /**
   * The service, its entity, and its registry, on a cluster provided by the caller. It assumes a single runner that
   * owns every shard: it waits for shard 1 of `"default"`.
   */
  static readonly onCluster: Layer.Layer<GameActors, never, Sharding.Sharding> = Layer.suspend(() =>
    // Suspended because the entity and the registry are declared below this class.
    Layer.effect(
      GameActors,
      Effect.gen(function* () {
        const sharding = yield* Sharding.Sharding
        // Sharding acquires its shards on a fiber of its own, all in one batch. Until it has, a send is retried
        // after `sendRetryInterval`, so the first poll would wait for nothing.
        yield* Effect.yieldNow.pipe(
          Effect.map(() => sharding.hasShardId(ShardId.make("default", 1))),
          Effect.repeat({ until: (acquired) => acquired })
        )
        const clientFor = yield* Game.client
        const liveGames = yield* LiveGames
        return GameActors.of({
          receive: (snapshot) =>
            clientFor(snapshot.id)
              .Receive({ snapshot })
              .pipe(
                Effect.catch((error) => logUndelivered(snapshot, Cause.fail(error))),
                Effect.catchDefect((defect) => logUndelivered(snapshot, Cause.die(defect)))
              ),
          liveGames: SubscriptionRef.get(liveGames.all),
          changes: SubscriptionRef.changes(liveGames.all)
        })
      })
    ).pipe(Layer.provide(gameEntity), Layer.provide(LiveGames.layer))
  )

  /** A single-process cluster that stores nothing on disk: no runners to talk to, messages kept in memory. */
  static readonly cluster: Layer.Layer<Sharding.Sharding> = Sharding.layer.pipe(
    Layer.provide(Runners.layerNoop),
    Layer.provide([MessageStorage.layerMemory, RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
    Layer.provide(
      ShardingConfig.layer({
        entityTerminationTimeout: Duration.seconds(1),
        simulateRemoteSerialization: false
      })
    )
  )

  /** The actors on a single-process cluster that stores nothing. */
  static readonly layer: Layer.Layer<GameActors> = GameActors.onCluster.pipe(
    Layer.provide(GameActors.cluster)
  )
}

function logUndelivered(snapshot: GameSnapshot, cause: Cause.Cause<unknown>): Effect.Effect<void> {
  return Effect.logError("GameActors: a game actor did not take a snapshot", cause).pipe(
    Effect.annotateLogs({ game: snapshot.id })
  )
}

const Receive = Rpc.make("Receive", { payload: { snapshot: GameSnapshot } })

/** The game actor entity, keyed by game id. Exported for its tests, which address an entity directly. */
export const Game = Entity.make("Game", [Receive])

const gameEntity = Game.toLayer(
  Effect.gen(function* () {
    const id = GameId.make((yield* Entity.CurrentAddress).entityId)
    const liveGames = yield* LiveGames
    const state = yield* SubscriptionRef.make(Option.none<LiveGame>())
    yield* Effect.addFinalizer(() => liveGames.remove(id))
    // The registry is written under the state's lock, so it never lags the state or takes an older live game.
    const change = (step: (current: Option.Option<LiveGame>) => Option.Option<LiveGame>) =>
      SubscriptionRef.updateEffect(state, (current) => {
        const next = step(current)
        return Option.match(next, {
          onNone: () => Effect.void,
          onSome: (liveGame) => liveGames.set(id, liveGame)
        }).pipe(Effect.as(next))
      })
    yield* Effect.forkScoped(
      SubscriptionRef.changes(state).pipe(
        Stream.filterMap(
          Filter.fromPredicateOption(Option.flatMap((liveGame: LiveGame) => liveGame.staleAt()))
        ),
        Stream.switchMap((staleAt) => Stream.fromEffect(staleOn(staleAt))),
        Stream.runDrain
      ),
      { startImmediately: true }
    )
    yield* Effect.forkScoped(
      SubscriptionRef.changes(state).pipe(
        Stream.mapEffect((current) =>
          DateTime.now.pipe(
            Effect.map((now) => Option.exists(current, (liveGame) => liveGame.isCurrent(now)))
          )
        ),
        Stream.changes,
        Stream.runForEach(Entity.keepAlive)
      ),
      { startImmediately: true }
    )
    return Game.of({
      Receive: ({ payload: { snapshot } }) =>
        Effect.gen(function* () {
          if (snapshot.id !== id) {
            return yield* Effect.die(new Error(`Game actor ${id} was sent a snapshot of game ${snapshot.id}`))
          }
          const now = yield* DateTime.now
          yield* change(
            Option.match({
              onNone: () => Option.some(LiveGame.start(snapshot, now)),
              onSome: (liveGame) => liveGame.receive(snapshot, now).pipe(Option.orElseSome(() => liveGame))
            })
          )
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.logError(
              "GameActors: a snapshot raised a defect; keeping the last good live game",
              Cause.die(defect)
            ).pipe(Effect.annotateLogs({ snapshot: Schema.encodeSync(GameSnapshot)(snapshot) }))
          )
        )
    })

    function staleOn(staleAt: DateTime.Utc): Effect.Effect<void> {
      return Effect.gen(function* () {
        yield* Effect.sleep(Duration.max(DateTime.distance(yield* DateTime.now, staleAt), Duration.zero))
        const now = yield* DateTime.now
        yield* change(Option.map((liveGame) => liveGame.tick(now).pipe(Option.getOrElse(() => liveGame))))
      })
    }
  }),
  { maxIdleTime: "5 minutes", disableFatalDefects: true }
)

/** Every running actor's live game. An actor writes its own on every change and removes it when it stops. */
class LiveGames extends Context.Service<
  LiveGames,
  {
    readonly all: SubscriptionRef.SubscriptionRef<ReadonlyMap<GameId, LiveGame>>
    readonly set: (id: GameId, liveGame: LiveGame) => Effect.Effect<void>
    readonly remove: (id: GameId) => Effect.Effect<void>
  }
>()("sportal/hub/GameActors/LiveGames") {
  static readonly layer = Layer.effect(
    LiveGames,
    Effect.gen(function* () {
      const all = yield* SubscriptionRef.make<ReadonlyMap<GameId, LiveGame>>(new Map())
      return LiveGames.of({
        all,
        set: (id, liveGame) => SubscriptionRef.update(all, (games) => new Map(games).set(id, liveGame)),
        remove: (id) =>
          SubscriptionRef.update(all, (games) => new Map([...games].filter(([game]) => game !== id)))
      })
    })
  )
}
