import type { GameSnapshot, Network } from "@sportal/domain/Game"
import type { ChannelAvailability, ChannelUrlRefused, GuideUnreadable } from "@sportal/domain/Source"
import { Context, type Effect, type Stream } from "effect"
import type { ChannelStoreError } from "./ChannelStore.ts"

export class Source extends Context.Service<
  Source,
  {
    /** Whether and where this source can show a game: from its latest guide, or, until one is read, its lineup. */
    readonly availability: Effect.Effect<(game: GameSnapshot) => ChannelAvailability>
    /** Emits once after every change to the lineup and every guide read. */
    readonly changes: Stream.Stream<void>
    /** Reads a guide response as the source's guide page received it; availability comes from it next. */
    readGuide(guide: string): Effect.Effect<void, GuideUnreadable>
    /** Remembers the channel at `url` as where this source carries `network`. */
    learn(network: Network, url: string): Effect.Effect<void, ChannelUrlRefused | ChannelStoreError>
    markNotCarried(network: Network): Effect.Effect<void, ChannelStoreError>
    forget(network: Network): Effect.Effect<void, ChannelStoreError>
  }
>()("sportal/hub/Source") {}
