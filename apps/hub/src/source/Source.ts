import { ChannelAvailability } from "@sportal/domain/Channel"
import type { GameSnapshot } from "@sportal/domain/Game"
import { Context, DateTime, Effect, Layer, Option, Stream } from "effect"
import { GuideReader } from "./GuideReader.ts"
import * as YouTubeTvGuide from "./youtube-tv/YouTubeTvGuide.ts"

/** A way to obtain video for a game. It says whether and where each game can be shown, and when that may change. */
export class Source extends Context.Service<
  Source,
  {
    /** Whether and where this source can show a game, as of now. */
    readonly availability: Effect.Effect<(game: GameSnapshot) => ChannelAvailability>
    /** Emits whenever what this source answers may have changed. */
    readonly changes: Stream.Stream<void>
  }
>()("sportal/hub/source/Source") {
  /** YouTube TV: from the latest guide its reader keeps while it is fresh; otherwise no guide. */
  static readonly layerYouTubeTv: Layer.Layer<Source, never, GuideReader> = Layer.effect(
    Source,
    Effect.gen(function* () {
      const reader = yield* GuideReader

      const availability = Effect.fn("Source.youTubeTvAvailability")(function* () {
        const now = yield* DateTime.now
        const latest = yield* reader.latest
        return (game: GameSnapshot) =>
          Option.match(latest, {
            onNone: () => ChannelAvailability.NoGuide({ source: YouTubeTvGuide.source }),
            onSome: (guide) => guide.availabilityOf(game, now)
          })
      })

      return Source.of({ availability: availability(), changes: reader.changes })
    })
  )

  /** A source answering `availabilityOf` for every game, which changes whenever `changes` emits. */
  static layerTest(
    availabilityOf: (game: GameSnapshot) => ChannelAvailability,
    changes: Stream.Stream<void> = Stream.never
  ): Layer.Layer<Source> {
    return Layer.succeed(Source, Source.of({ availability: Effect.succeed(availabilityOf), changes }))
  }
}
