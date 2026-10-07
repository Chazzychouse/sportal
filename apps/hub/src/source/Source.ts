import type { ChannelAvailability } from "@sportal/domain/Channel"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { GuideUnreadable } from "@sportal/domain/Guide"
import { Context, type Effect, type Stream } from "effect"

/**
 * A way to obtain video for a game. It says whether and where each game can be shown, from a guide the shell reads,
 * and when that answer changes.
 */
export class Source extends Context.Service<
  Source,
  {
    /**
     * Whether and where this source can show a game: from its latest guide while that is fresh; otherwise no
     * guide.
     */
    readonly availability: Effect.Effect<(game: GameSnapshot) => ChannelAvailability>
    /** Emits once after every guide read, and when the latest guide goes stale. */
    readonly changes: Stream.Stream<void>
    /** Reads a guide response as the source's guide page received it; availability comes from it next. */
    readGuide(guide: string): Effect.Effect<void, GuideUnreadable>
  }
>()("sportal/hub/source/Source") {}
