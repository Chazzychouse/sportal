import type { ChannelAvailability } from "@sportal/domain/Channel"
import type { GameSnapshot } from "@sportal/domain/Game"
import { Context, type DateTime, Effect, Layer, Option, Stream } from "effect"
import { GuideReader } from "./GuideReader.ts"
import * as Twitch from "./Twitch.ts"
import * as YouTubeTvGuide from "./youtube-tv/YouTubeTvGuide.ts"

/** A way to obtain video for a game. It says whether and where each game can be shown, as of a time. */
export class Source extends Context.Service<
  Source,
  {
    /**
     * Whether and where this source can show a game at a time: one availability from each source it stands for, in
     * order. As it is, then again each time what the source knows changes.
     */
    readonly availability: Stream.Stream<
      (game: GameSnapshot, now: DateTime.Utc) => ReadonlyArray<ChannelAvailability>
    >
  }
>()("sportal/hub/source/Source") {
  /** YouTube TV: from the latest guide its reader keeps while it is fresh; otherwise no guide. */
  static readonly layerYouTubeTv: Layer.Layer<Source, never, GuideReader> = Layer.effect(
    Source,
    Effect.gen(function* () {
      const reader = yield* GuideReader

      const availability = reader.guide.pipe(
        Stream.map((latest) => (game: GameSnapshot, now: DateTime.Utc) => [
          Option.match(latest, {
            onNone: (): ChannelAvailability => ({ _tag: "NoGuide", source: YouTubeTvGuide.source }),
            onSome: (guide) => guide.availabilityOf(game, now)
          })
        ])
      )

      return Source.of({ availability })
    })
  )

  /** Twitch: its lineup, which never changes. */
  static readonly layerTwitch: Layer.Layer<Source> = Layer.succeed(
    Source,
    Source.of({
      availability: Stream.make((game: GameSnapshot, now: DateTime.Utc) => [
        Twitch.lineup.availabilityOf(game, now)
      ])
    })
  )

  /**
   * Every source given, as one: for each game every source's availability, in the order given, again whenever any of
   * them changes.
   */
  static layerAll<R>(sources: ReadonlyArray<Layer.Layer<Source, never, R>>): Layer.Layer<Source, never, R> {
    return Layer.effect(
      Source,
      Effect.gen(function* () {
        const each = yield* Effect.forEach(sources, (source) =>
          Layer.build(source).pipe(Effect.map((context) => Context.get(context, Source)))
        )

        const availability = Stream.zipLatestAll(...each.map((source) => source.availability)).pipe(
          Stream.map(
            (availabilities) => (game: GameSnapshot, now: DateTime.Utc) =>
              availabilities.flatMap((availabilityOf) => availabilityOf(game, now))
          )
        )

        return Source.of({ availability })
      })
    )
  }

  /** A source giving `availabilityOf` every game, and again each time `again` emits. */
  static layerTest(
    availabilityOf: (game: GameSnapshot) => ChannelAvailability,
    again: Stream.Stream<void> = Stream.empty
  ): Layer.Layer<Source> {
    const value = (game: GameSnapshot) => [availabilityOf(game)]
    return Layer.succeed(
      Source,
      Source.of({ availability: Stream.concat(Stream.make(value), again.pipe(Stream.as(value))) })
    )
  }
}
