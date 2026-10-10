import { Context, type Effect } from "effect"
import type { Delivery } from "./Provider.ts"

/** What a test gives `Provider.layerTest`'s provider to say. */
export class ProviderFeed extends Context.Service<
  ProviderFeed,
  {
    /** One frame saying `deliveries`; returns once the provider's reader has taken it and asked for the next. */
    deliver(deliveries: ReadonlyArray<Delivery>): Effect.Effect<void>
    /** Ends the provider's frames after those already delivered. */
    readonly end: Effect.Effect<void>
  }
>()("sportal/hub/provider/ProviderFeed") {}
