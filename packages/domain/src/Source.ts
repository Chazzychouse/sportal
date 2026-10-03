import { Data, Schema } from "effect"
import { type GameSnapshot, Network } from "./Game.ts"
import { StreamLocator } from "./Stream.ts"

/** The sources Sportal can play video from, by the name people know them by. */
export const SourceName = Schema.Literals(["YouTube TV"])
export type SourceName = typeof SourceName.Type

/** A network as carried by a specific source. */
export const Channel = Schema.Struct({ network: Network, source: SourceName, locator: StreamLocator })
export type Channel = typeof Channel.Type

/** Whether a source carries a network: on a channel, or not at all. */
export const ChannelCarriage = Schema.Union([
  Schema.TaggedStruct("Carried", { channel: Channel }),
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
    for (const { network } of game.broadcasts) {
      const carriage = this.carriageOf(network)
      if (carriage?._tag === "Carried") return ChannelAvailability.Carried({ channel: carriage.channel })
    }
    const unlearned = game.broadcasts.find(({ network }) => this.carriageOf(network) === undefined)
    return unlearned === undefined
      ? ChannelAvailability.NotCarried()
      : ChannelAvailability.Unlearned({ network: unlearned.network, source: this.source, guide: this.guide })
  }

  /** Records a carriage, replacing any earlier one for the same network. */
  record(carriage: ChannelCarriage): ChannelLineup {
    return new ChannelLineup({
      source: this.source,
      guide: this.guide,
      carriages: [...this.forget(networkOf(carriage)).carriages, carriage]
    })
  }

  forget(network: Network): ChannelLineup {
    return new ChannelLineup({
      source: this.source,
      guide: this.guide,
      carriages: this.carriages.filter((carriage) => networkOf(carriage) !== network)
    })
  }

  private carriageOf(network: Network): ChannelCarriage | undefined {
    return this.carriages.find((carriage) => networkOf(carriage) === network)
  }
}

/** Whether and where a source can show one game: carried, unlearned (its network still to be picked), or not carried. */
export type ChannelAvailability = Data.TaggedEnum<{
  Carried: { readonly channel: Channel }
  Unlearned: { readonly network: Network; readonly source: SourceName; readonly guide: StreamLocator }
  // biome-ignore lint/complexity/noBannedTypes: the not-carried case carries nothing
  NotCarried: {}
}>
export const ChannelAvailability = Data.taggedEnum<ChannelAvailability>()

/** An address a source refused to learn, because it is not one of the source's live channels. */
export class ChannelUrlRefused extends Schema.TaggedError<ChannelUrlRefused>()(
  "ChannelUrlRefused",
  {},
  { httpApiStatus: 422 }
) {}

function networkOf(carriage: ChannelCarriage): Network {
  return carriage._tag === "Carried" ? carriage.channel.network : carriage.network
}
