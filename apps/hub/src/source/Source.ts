import type { ChannelAvailability } from "@sportal/domain/Channel"
import { type GameSnapshot, Network } from "@sportal/domain/Game"
import { Context, DateTime, Duration, Effect, Layer, Option, Stream } from "effect"
import { ChannelId, Guide } from "./Guide.ts"
import { YouTubeTv } from "./youtube-tv/YouTubeTv.ts"

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
  /** YouTube TV: from the latest guide it read while that guide is fresh; otherwise no guide. */
  static readonly layerYouTubeTv: Layer.Layer<Source, never, YouTubeTv> = Layer.effect(
    Source,
    Effect.gen(function* () {
      const youTubeTv = yield* YouTubeTv

      const availability = youTubeTv.guide.pipe(
        Stream.map((latest) => (game: GameSnapshot, now: DateTime.Utc) => {
          const fresh = Option.filter(latest, (guide) => isFresh(guide, now))
          return [
            Option.match(fresh, {
              onNone: (): ChannelAvailability => ({ _tag: "NoGuide", source: "YouTube TV" }),
              onSome: (guide) => guide.availabilityOf(game, now)
            })
          ]
        })
      )

      return Source.of({ availability })
    })
  )

  /** Twitch: its lineup, which never changes. */
  static readonly layerTwitch: Layer.Layer<Source> = Layer.succeed(
    Source,
    Source.of({
      availability: Stream.make((game: GameSnapshot, now: DateTime.Utc) => [
        new Guide({
          source: "Twitch",
          readAt: DateTime.makeUnsafe(0),
          channels: [
            {
              id: ChannelId.make("primevideo"),
              name: "Prime Video",
              live: {
                _tag: "WebView",
                url: "https://player.twitch.tv/?channel=primevideo&parent=twitch.tv&player=popout"
              },
              network: Network.make("Prime Video")
            }
          ],
          airings: []
        }).availabilityOf(game, now)
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

/** A guide answers for 45 minutes after its reading; the shell reads one every 5 minutes while it runs. */
const staleAfter = Duration.minutes(45)

function isFresh(guide: Guide, now: DateTime.Utc): boolean {
  return DateTime.isLessThan(now, DateTime.addDuration(guide.readAt, staleAfter))
}
