import type { ChannelAvailability } from "@sportal/domain/Channel"
import type { GameSnapshot } from "@sportal/domain/Game"
import { Context, DateTime, Effect, Layer, Option, Stream } from "effect"
import { GuideReader } from "./GuideReader.ts"
import * as Twitch from "./Twitch.ts"
import * as YouTubeTvGuide from "./youtube-tv/YouTubeTvGuide.ts"

/** A way to obtain video for a game. It says whether and where each game can be shown, and when that may change. */
export class Source extends Context.Service<
  Source,
  {
    /**
     * Whether and where this source can show a game, as of now: one availability from each source it stands for, in
     * order.
     */
    readonly availability: Effect.Effect<(game: GameSnapshot) => ReadonlyArray<ChannelAvailability>>
    /** Emits whenever this source's availability may have changed. */
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
        return (game: GameSnapshot) => [
          Option.match(latest, {
            onNone: (): ChannelAvailability => ({ _tag: "NoGuide", source: YouTubeTvGuide.source }),
            onSome: (guide) => guide.availabilityOf(game, now)
          })
        ]
      })

      return Source.of({ availability: availability(), changes: reader.changes })
    })
  )

  /**
   * Twitch: its lineup, which is always current. It says it may have changed once a minute, so a game reaching the
   * half hour before kickoff reaches its tile.
   */
  static readonly layerTwitch: Layer.Layer<Source> = Layer.effect(
    Source,
    Effect.gen(function* () {
      const availability = Effect.fn("Source.twitchAvailability")(function* () {
        const now = yield* DateTime.now
        return (game: GameSnapshot) => [Twitch.lineup.availabilityOf(game, now)]
      })

      return Source.of({
        availability: availability(),
        changes: Stream.tick("1 minute").pipe(Stream.drop(1))
      })
    })
  )

  /**
   * Every source given, as one: for each game every source's availability, in the order given, and a change whenever
   * any of them changes.
   */
  static layerAll<R>(sources: ReadonlyArray<Layer.Layer<Source, never, R>>): Layer.Layer<Source, never, R> {
    return Layer.effect(
      Source,
      Effect.gen(function* () {
        const each = yield* Effect.forEach(sources, (source) =>
          Layer.build(source).pipe(Effect.map((context) => Context.get(context, Source)))
        )

        const availability = Effect.fn("Source.availability")(function* () {
          const availabilities = yield* Effect.forEach(each, (source) => source.availability)
          return (game: GameSnapshot) => availabilities.flatMap((availabilityOf) => availabilityOf(game))
        })

        return Source.of({
          availability: availability(),
          changes: Stream.mergeAll(
            each.map((source) => source.changes),
            { concurrency: "unbounded" }
          )
        })
      })
    )
  }

  /** A source giving `availabilityOf` every game, which changes whenever `changes` emits. */
  static layerTest(
    availabilityOf: (game: GameSnapshot) => ChannelAvailability,
    changes: Stream.Stream<void> = Stream.never
  ): Layer.Layer<Source> {
    return Layer.succeed(
      Source,
      Source.of({ availability: Effect.succeed((game: GameSnapshot) => [availabilityOf(game)]), changes })
    )
  }
}
