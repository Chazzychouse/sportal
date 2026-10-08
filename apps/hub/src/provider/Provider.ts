import { Context, Layer, type Stream } from "effect"
import type { Delivery } from "../slate/Delivery.ts"

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
  /** A provider whose frames said `deliveries`. */
  static layerTest(deliveries: Stream.Stream<ReadonlyArray<Delivery>>): Layer.Layer<Provider> {
    return Layer.succeed(Provider, Provider.of({ deliveries }))
  }
}
