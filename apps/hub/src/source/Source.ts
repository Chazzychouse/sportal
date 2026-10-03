import type { Network } from "@sportal/domain/Game"
import type { ChannelLineup, ChannelUrlRefused } from "@sportal/domain/Source"
import { Context, type Effect, type Stream } from "effect"
import type { ChannelStoreError } from "./ChannelStore.ts"

export class Source extends Context.Service<
  Source,
  {
    /** The channels this source has learned so far. */
    readonly lineup: Effect.Effect<ChannelLineup>
    /** Emits once after every change to the lineup. */
    readonly changes: Stream.Stream<void>
    /** Remembers the channel at `url` as where this source carries `network`. */
    learn(network: Network, url: string): Effect.Effect<void, ChannelUrlRefused | ChannelStoreError>
    markNotCarried(network: Network): Effect.Effect<void, ChannelStoreError>
    forget(network: Network): Effect.Effect<void, ChannelStoreError>
  }
>()("sportal/hub/Source") {}
