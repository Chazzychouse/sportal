import type { ChannelCarriage, SourceName } from "@sportal/domain/Channel"
import type { Network } from "@sportal/domain/Game"
import { Context, type Effect, Schema } from "effect"

/** Where the Hub keeps the channel carriages it learned from the user: they cannot be fetched again. */
export class ChannelStore extends Context.Service<
  ChannelStore,
  {
    readonly carriages: Effect.Effect<ReadonlyArray<ChannelCarriage>, ChannelStoreError>
    /** Records a carriage, replacing any earlier one for the same network and source. */
    record(carriage: ChannelCarriage): Effect.Effect<void, ChannelStoreError>
    forget(network: Network, source: SourceName): Effect.Effect<void, ChannelStoreError>
  }
>()("sportal/hub/ChannelStore") {}

export class ChannelStoreError extends Schema.TaggedError<ChannelStoreError>()("ChannelStoreError", {
  cause: Schema.Defect()
}) {}
