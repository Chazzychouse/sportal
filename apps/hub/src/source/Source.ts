import { ChannelAvailability } from "@sportal/domain/Channel"
import type { GameSnapshot } from "@sportal/domain/Game"
import { Array as Arr, Context, DateTime, Effect, Layer, Option, Stream } from "effect"
import { GuideReader } from "./GuideReader.ts"
import * as Twitch from "./Twitch.ts"
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
            onNone: () => ChannelAvailability.cases.NoGuide.make({ source: YouTubeTvGuide.source }),
            onSome: (guide) => guide.availabilityOf(game, now)
          })
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
        return (game: GameSnapshot) => Twitch.lineup.availabilityOf(game, now)
      })

      return Source.of({
        availability: availability(),
        changes: Stream.tick("1 minute").pipe(Stream.drop(1))
      })
    })
  )

  /**
   * Every source given, as one: for each game the most useful answer any of them gives, whatever their order, and a
   * change whenever any of them changes.
   */
  static layerAll<R>(sources: ReadonlyArray<Layer.Layer<Source, never, R>>): Layer.Layer<Source, never, R> {
    return Layer.effect(
      Source,
      Effect.gen(function* () {
        const each = yield* Effect.forEach(sources, (source) =>
          Layer.build(source).pipe(Effect.map((context) => Context.get(context, Source)))
        )

        const availability = Effect.fn("Source.availability")(function* () {
          const answers = yield* Effect.forEach(each, (source) => source.availability)
          return (game: GameSnapshot) => mostUseful(answers.map((availabilityOf) => availabilityOf(game)))
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

  /** A source answering `availabilityOf` for every game, which changes whenever `changes` emits. */
  static layerTest(
    availabilityOf: (game: GameSnapshot) => ChannelAvailability,
    changes: Stream.Stream<void> = Stream.never
  ): Layer.Layer<Source> {
    return Layer.succeed(Source, Source.of({ availability: Effect.succeed(availabilityOf), changes }))
  }
}

/** The answer that says most of several: ties go to the first, and only ever between answers of one kind. */
function mostUseful(answers: ReadonlyArray<ChannelAvailability>): ChannelAvailability {
  return Arr.reduce<ChannelAvailability, ChannelAvailability>(
    answers,
    ChannelAvailability.cases.NotCarried.make({ why: "NoStream" }),
    (best, answer) => (usefulness(answer) > usefulness(best) ? answer : best)
  )
}

/**
 * How much an answer tells: carried; upcoming on a known channel; upcoming with nothing known; no guide (it may yet be
 * carried); streaming only; not in the guide; no stream.
 */
function usefulness(answer: ChannelAvailability): number {
  return ChannelAvailability.match(answer, {
    Carried: () => 6,
    Upcoming: ({ channel }) => (Option.isSome(channel) ? 5 : 4),
    NoGuide: () => 3,
    NotCarried: ({ why }) => (why === "StreamingOnly" ? 2 : why === "NotInGuide" ? 1 : 0)
  })
}
