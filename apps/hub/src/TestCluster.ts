import { Layer } from "effect"
import { MessageStorage } from "effect/cluster"
import * as Cluster from "./Cluster.ts"
import { GameActors } from "./GameActors.ts"

/** The Hub's cluster with its messages in memory, as the Hub runs it, for a test that addresses an entity itself. */
export const cluster = Cluster.layer.pipe(
  Layer.provide(MessageStorage.layerMemory),
  Layer.provide(Cluster.config())
)

/** The game actors on the Hub's cluster, with its messages in memory, as the Hub runs them. */
export const gameActors = GameActors.layer.pipe(Layer.provide(cluster))
