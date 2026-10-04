import { Context, Duration, Effect, Layer } from "effect"
import {
  type MessageStorage,
  RunnerHealth,
  RunnerStorage,
  Runners,
  ShardId,
  Sharding,
  ShardingConfig
} from "effect/cluster"

/**
 * The Hub's single-process cluster, with no runners to talk to, ready once it owns its shards. It assumes a single
 * runner that owns every shard: it waits for shard 1 of `"default"`.
 */
export const layer: Layer.Layer<Sharding.Sharding, never, MessageStorage.MessageStorage> =
  Sharding.layer.pipe(
    Layer.tap((context) => {
      const sharding = Context.get(context, Sharding.Sharding)
      // Sharding acquires its shards on a fiber of its own, all in one batch. Until it has, a send is retried after
      // `sendRetryInterval`, so the first poll would wait for nothing.
      return Effect.yieldNow.pipe(
        Effect.map(() => sharding.hasShardId(ShardId.make("default", 1))),
        Effect.repeat({ until: (acquired) => acquired })
      )
    }),
    Layer.provide([Runners.layerNoop, RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
    Layer.provide(config())
  )

/** The cluster's settings, which memory storage requires as well. */
export function config(): Layer.Layer<ShardingConfig.ShardingConfig> {
  return ShardingConfig.layer({
    entityTerminationTimeout: Duration.seconds(1),
    simulateRemoteSerialization: false
  })
}
