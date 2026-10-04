import { Layer } from "effect"
import * as Cluster from "./Cluster.ts"
import { GameActors } from "./GameActors.ts"

/** The game actors on the Hub's cluster, as the Hub runs them. */
export const gameActors = GameActors.layer.pipe(Layer.provide(Cluster.inMemory))
