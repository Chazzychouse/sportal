import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import type { Play } from "@sportal/domain/Play"
import { type Cause, Context, Data, Effect, Exit, Layer, Queue, Stream } from "effect"
import { isStopping } from "../Shutdown.ts"

/**
 * A provider of game data. It runs itself: it decides when to poll, what to follow on its push, and when to reconnect,
 * and reads each frame it receives with its own decode. Nothing tells it what to do.
 */
export class Provider extends Context.Service<
  Provider,
  {
    /**
     * What each frame it receives said, as its deliveries in the order the frame said them, one array per frame, in
     * the order received, for as long as it runs. Never fails.
     */
    readonly deliveries: Stream.Stream<ReadonlyArray<Delivery>>
  }
>()("sportal/hub/provider/Provider") {
  /**
   * A provider whose frames are what a test offers `frames`, taken one at a time: it takes the next only once its
   * reader has taken the one before. They end when `frames` ends.
   */
  static layerTest(frames: Queue.Dequeue<ReadonlyArray<Delivery>, Cause.Done>): Layer.Layer<Provider> {
    return Layer.succeed(Provider, Provider.of({ deliveries: Stream.fromEffectRepeat(Queue.take(frames)) }))
  }
}

/** What a frame said: a league's listing, or one game's whole list of plays. */
export type Delivery = Data.TaggedEnum<{
  Listing: { readonly league: LeagueId; readonly games: ReadonlyArray<GameSnapshot> }
  Plays: { readonly game: GameId; readonly plays: ReadonlyArray<Play> }
}>
export const Delivery = Data.taggedEnum<Delivery>()
