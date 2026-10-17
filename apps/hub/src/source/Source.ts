import type { GuideUnreadable } from "@sportal/api/GuideUnreadable"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { type GameSnapshot, Network } from "@sportal/domain/Game"
import { ChannelId, Guide, type Lineup } from "@sportal/domain/Guide"
import { Context, DateTime, Duration, Effect, Layer, Option, Ref } from "effect"
import { HubConfig } from "../HubConfig.ts"
import * as YouTubeTvGuide from "./youtube-tv/YouTubeTvGuide.ts"

/**
 * A way to obtain video: for a game, whether and where it can be shown; and its lineup of sports channels; each as of
 * a time.
 */
export class Source extends Context.Service<
  Source,
  {
    readonly availability: Effect.Effect<
      (game: GameSnapshot, now: DateTime.Utc) => ReadonlyArray<ChannelAvailability>
    >
    /** This source's sports channels that play live at a time, each with what airs on it now and next. */
    readonly lineup: Effect.Effect<(now: DateTime.Utc) => Lineup>
    readGuide(response: string): Effect.Effect<void, GuideUnreadable>
  }
>()("sportal/hub/source/Source") {
  static readonly layerYouTubeTv: Layer.Layer<Source, never, HubConfig> = Layer.effect(
    Source,
    Effect.gen(function* () {
      const latest = yield* Ref.make(Option.none<Guide>())
      const { lineupChannels } = yield* HubConfig

      const readGuide = Effect.fn("Source.readGuide")(function* (response: string) {
        const read = yield* YouTubeTvGuide.decode(response)
        yield* Ref.set(latest, Option.some(read))
      })

      const availability = Ref.get(latest).pipe(
        Effect.map((latest) => (game: GameSnapshot, now: DateTime.Utc) => {
          const fresh = Option.filter(latest, (guide) => isFresh(guide, now))
          return [
            Option.match(fresh, {
              onNone: (): ChannelAvailability => ({ _tag: "NoGuide", source: "YouTube TV" }),
              onSome: (guide) => guide.availabilityOf(game, now)
            })
          ]
        })
      )

      const lineup = Ref.get(latest).pipe(
        Effect.map(
          (latest) => (now: DateTime.Utc) =>
            Option.match(
              Option.filter(latest, (guide) => isFresh(guide, now)),
              {
                onNone: (): Lineup => [],
                onSome: (guide) => guide.lineup(now, lineupChannels)
              }
            )
        )
      )

      return Source.of({ availability, lineup, readGuide })
    })
  )

  static readonly layerTwitch: Layer.Layer<Source> = Layer.succeed(
    Source,
    Source.of({
      availability: Effect.succeed((game: GameSnapshot, now: DateTime.Utc) => [
        twitchGuide.availabilityOf(game, now)
      ]),
      lineup: Effect.succeed((now: DateTime.Utc) => twitchGuide.lineup(now, [])),
      readGuide: () => Effect.void
    })
  )

  static layerAll<R>(sources: ReadonlyArray<Layer.Layer<Source, never, R>>): Layer.Layer<Source, never, R> {
    return Layer.effect(
      Source,
      Effect.gen(function* () {
        const each = yield* Effect.forEach(sources, (source) =>
          Layer.build(source).pipe(Effect.map((context) => Context.get(context, Source)))
        )

        const availability = Effect.forEach(each, (source) => source.availability).pipe(
          Effect.map(
            (availabilities) => (game: GameSnapshot, now: DateTime.Utc) =>
              availabilities.flatMap((availabilityOf) => availabilityOf(game, now))
          )
        )
        const lineup = Effect.forEach(each, (source) => source.lineup).pipe(
          Effect.map((lineups) => (now: DateTime.Utc) => lineups.flatMap((lineupAt) => lineupAt(now)))
        )
        const readGuide = (response: string) =>
          Effect.forEach(each, (source) => source.readGuide(response), { discard: true })

        return Source.of({ availability, lineup, readGuide })
      })
    )
  }

  static layerTest(
    availabilityOf: (game: GameSnapshot) => ChannelAvailability,
    lineup: Lineup = []
  ): Layer.Layer<Source> {
    return Layer.succeed(
      Source,
      Source.of({
        availability: Effect.succeed((game: GameSnapshot) => [availabilityOf(game)]),
        lineup: Effect.succeed(() => lineup),
        readGuide: () => Effect.void
      })
    )
  }
}

const staleAfter = Duration.minutes(45)

function isFresh(guide: Guide, now: DateTime.Utc): boolean {
  return DateTime.isLessThan(now, DateTime.addDuration(guide.readAt, staleAfter))
}

/** Twitch's fixed guide: Prime Video's channel, which carries every Prime Video broadcast; it airs nothing listed. */
const twitchGuide = new Guide({
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
})
