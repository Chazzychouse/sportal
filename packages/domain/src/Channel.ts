import { Array as Arr, Data, type DateTime, Option, Schema } from "effect"
import { type GameSnapshot, Network } from "./Game.ts"
import { StreamLocator } from "./Stream.ts"

/** The sources Sportal can play video from, by the name people know them by. */
export const SourceName = Schema.Literals(["YouTube TV", "Scenario"])
export type SourceName = typeof SourceName.Type

/** A channel as a source names it ("News 3", "ESPN2"), and the address that plays it live. */
export const Channel = Schema.Struct({ name: Schema.String, source: SourceName, locator: StreamLocator })
export type Channel = typeof Channel.Type

/** Whether a source carries a network: on a channel, or not at all. */
export const ChannelCarriage = Schema.Union([
  Schema.TaggedStruct("Carried", { network: Network, channel: Channel }),
  Schema.TaggedStruct("NotCarried", { network: Network, source: SourceName })
])
export type ChannelCarriage = typeof ChannelCarriage.Type

/**
 * The channel carriages one source has learned, and the guide where the rest are picked. Recording or
 * forgetting a carriage returns a new lineup.
 */
export class ChannelLineup extends Schema.Class<ChannelLineup>("sportal/ChannelLineup")({
  source: SourceName,
  guide: StreamLocator,
  carriages: Schema.Array(ChannelCarriage)
}) {
  /**
   * Where this source can show a game, given its networks in broadcast order. A carried network wins;
   * otherwise the first network with no carriage recorded is the one to pick next.
   */
  availabilityOf(game: GameSnapshot): ChannelAvailability {
    return Arr.findFirst(game.broadcasts, ({ network }) => {
      const carriage = this.carriageOf(network)
      return carriage?._tag === "Carried"
        ? Option.some(
            ChannelAvailability.Carried({ channel: carriage.channel, learnedFor: Option.some(network) })
          )
        : Option.none()
    }).pipe(
      Option.orElse(() =>
        Option.map(
          Arr.findFirst(game.broadcasts, ({ network }) => this.carriageOf(network) === undefined),
          ({ network }) => ChannelAvailability.Unlearned({ network, source: this.source, guide: this.guide })
        )
      ),
      Option.getOrElse(() => ChannelAvailability.NotCarried({ why: "NoStream" }))
    )
  }

  /** Records a carriage, replacing any earlier one for the same network. */
  record(carriage: ChannelCarriage): ChannelLineup {
    return new ChannelLineup({
      source: this.source,
      guide: this.guide,
      carriages: [...this.forget(carriage.network).carriages, carriage]
    })
  }

  forget(network: Network): ChannelLineup {
    return new ChannelLineup({
      source: this.source,
      guide: this.guide,
      carriages: this.carriages.filter((carriage) => carriage.network !== network)
    })
  }

  private carriageOf(network: Network): ChannelCarriage | undefined {
    return this.carriages.find((carriage) => carriage.network === network)
  }
}

/**
 * Whether and where a source can show one game: carried, upcoming (its airing is still to come, or past what
 * the guide lists), unlearned (its network still to be picked), or not carried, with why.
 */
export type ChannelAvailability = Data.TaggedEnum<{
  Carried: { readonly channel: Channel; readonly learnedFor: Option.Option<Network> }
  Upcoming: { readonly channel: Option.Option<string>; readonly begin: Option.Option<DateTime.Utc> }
  Unlearned: { readonly network: Network; readonly source: SourceName; readonly guide: StreamLocator }
  NotCarried: { readonly why: "NoStream" | "StreamingOnly" | "NotInGuide" }
}>
export const ChannelAvailability = Data.taggedEnum<ChannelAvailability>()

/** An address a source refused to learn, because it is not one of the source's live channels. */
export class ChannelUrlRefused extends Schema.TaggedError<ChannelUrlRefused>()(
  "ChannelUrlRefused",
  {},
  { httpApiStatus: 422 }
) {}
