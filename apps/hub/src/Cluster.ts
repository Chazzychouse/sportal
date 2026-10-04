import { Context, Duration, Effect, Layer } from "effect"
import {
  MessageStorage,
  RunnerHealth,
  RunnerStorage,
  Runners,
  ShardId,
  Sharding,
  ShardingConfig
} from "effect/cluster"

const config = ShardingConfig.layer({
  entityTerminationTimeout: Duration.seconds(1),
  simulateRemoteSerialization: false
})

/**
 * The Hub's single-process cluster, with no runners to talk to, ready once it owns its shards. It assumes a single
 * runner that owns every shard: it waits for shard 1 of `"default"`.
 */
export const layer: Layer.Layer<Sharding.Sharding, never, MessageStorage.MessageStorage> =
  Sharding.layer.pipe(
    Layer.tap((context) => {
      const sharding = Context.get(context, Sharding.Sharding)
      // Sharding acquires its shards on a fiber of its own, all in one batch. Until it has, a send is retried after
      // `sendRetryInterval`, so the first send would wait for nothing.
      return Effect.yieldNow.pipe(
        Effect.map(() => sharding.hasShardId(ShardId.make("default", 1))),
        Effect.repeat({ until: (acquired) => acquired })
      )
    }),
    Layer.provide([Runners.layerNoop, RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
    Layer.provide(config)
  )

/** The Hub's cluster. */
export const inMemory: Layer.Layer<Sharding.Sharding> = layer.pipe(
  // Keep-alive's message is persisted, and memory storage is the smallest that carries it, with nothing on disk.
  Layer.provide(MessageStorage.layerMemory),
  Layer.provide(config)
)
