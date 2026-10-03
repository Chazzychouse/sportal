import type { ChannelLineup } from "@sportal/domain/Source"
import { Context, type Effect } from "effect"

export class Source extends Context.Service<
  Source,
  {
    /** The channels this source has learned so far. */
    readonly lineup: Effect.Effect<ChannelLineup>
  }
>()("sportal/hub/Source") {}
