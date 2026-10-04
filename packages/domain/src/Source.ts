import { Data, DateTime, Duration, Option, Schema } from "effect"
import { type GameSnapshot, Network } from "./Game.ts"
import type { LeagueId } from "./League.ts"
import { StreamLocator } from "./Stream.ts"
import type { Team } from "./Team.ts"

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
    for (const { network } of game.broadcasts) {
      const carriage = this.carriageOf(network)
      if (carriage?._tag === "Carried")
        return ChannelAvailability.Carried({ channel: carriage.channel, learnedFor: Option.some(network) })
    }
    const unlearned = game.broadcasts.find(({ network }) => this.carriageOf(network) === undefined)
    return unlearned === undefined
      ? ChannelAvailability.NotCarried({ why: "NoStream" })
      : ChannelAvailability.Unlearned({ network: unlearned.network, source: this.source, guide: this.guide })
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

/** A source's own id for one of its channels (YouTube TV's station id). */
export const ChannelId = Schema.String.pipe(Schema.brand("ChannelId"))
export type ChannelId = typeof ChannelId.Type

/** One programme on a channel, with its begin and end. */
export const Airing = Schema.Struct({
  channel: ChannelId,
  title: Schema.String,
  begin: Schema.DateTimeUtc,
  end: Schema.DateTimeUtc
})
export type Airing = typeof Airing.Type

/**
 * One reading of a source's guide: the channels this account gets, each with its live address while it is
 * on the air, and what each airs.
 */
export class Guide extends Schema.Class<Guide>("sportal/Guide")({
  source: SourceName,
  readAt: Schema.DateTimeUtc,
  channels: Schema.Array(
    Schema.Struct({ id: ChannelId, name: Schema.String, live: Schema.optional(StreamLocator) })
  ),
  airings: Schema.Array(Airing)
}) {
  /**
   * How far past its reading a guide is complete. The first page of YouTube TV's guide reached 3h46m past
   * the half hour before the read (spike, 2026-10-03); a later kickoff may not be listed yet.
   */
  static readonly reach = Duration.hours(3)

  /**
   * Where this source shows a game, from the airing that names both its teams, has not ended, and begins near
   * kickoff or is on now while the game is under way. Of several, the one on a channel named for one of the game's
   * networks wins, then the first in the guide. It is carried once its channel is on the air and the airing
   * is at most half an hour off; until then it is upcoming. With no match, a kickoff past the guide's reach
   * is upcoming, and any other game is not carried.
   */
  availabilityOf(game: GameSnapshot): ChannelAvailability {
    const matches = this.airings.filter((airing) => this.airs(airing, game))
    const [first] = matches
    if (first === undefined) {
      if (DateTime.isGreaterThan(game.kickoff, DateTime.addDuration(this.readAt, Guide.reach)))
        return ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
      const streamingOnly =
        game.broadcasts.length > 0 && game.broadcasts.every(({ medium }) => medium === "streaming")
      return ChannelAvailability.NotCarried({ why: streamingOnly ? "StreamingOnly" : "NotInGuide" })
    }

    const airing =
      matches.find((candidate) =>
        game.broadcasts.some(({ network }) => namesNetwork(this.channelOf(candidate).name, network))
      ) ?? first
    const channel = this.channelOf(airing)
    const soon = DateTime.isLessThanOrEqualTo(airing.begin, DateTime.addDuration(this.readAt, startingSoon))
    return channel.live !== undefined && soon
      ? ChannelAvailability.Carried({
          channel: { name: channel.name, source: this.source, locator: channel.live },
          learnedFor: Option.none()
        })
      : ChannelAvailability.Upcoming({ channel: Option.some(channel.name), begin: Option.some(airing.begin) })
  }

  private airs(airing: Airing, game: GameSnapshot): boolean {
    const nearKickoff =
      Math.abs(DateTime.toEpochMillis(airing.begin) - DateTime.toEpochMillis(game.kickoff)) <=
      Duration.toMillis(kickoffTolerance)
    const onNow =
      game.isLive() && DateTime.between(this.readAt, { minimum: airing.begin, maximum: airing.end })
    return (
      (nearKickoff || onNow) &&
      DateTime.isGreaterThan(airing.end, this.readAt) &&
      namesTeam(airing.title, game.home.team, game.league) &&
      namesTeam(airing.title, game.away.team, game.league)
    )
  }

  private channelOf(airing: Airing): { readonly name: string; readonly live?: StreamLocator | undefined } {
    return this.channels.find(({ id }) => id === airing.channel) ?? { name: airing.channel }
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

/** A guide response the source could not read: not the guide, or a shape it no longer knows. */
export class GuideUnreadable extends Schema.TaggedError<GuideUnreadable>()(
  "GuideUnreadable",
  {},
  { httpApiStatus: 422 }
) {}

/** How long before an airing begins its channel is shown for it: the pregame, not another programme. */
const startingSoon = Duration.minutes(30)

/** How far an airing may begin from kickoff and still be the game: listings round, and kickoffs slip. */
const kickoffTolerance = Duration.minutes(45)

/** Whether a channel's name carries a network's as whole words: "ABC 13" for ABC. */
function namesNetwork(channel: string, network: Network): boolean {
  return ` ${normalized(channel)} `.includes(` ${normalized(network)} `)
}

/**
 * Whether a title names a team by its full name or short name, as whole words. Its location alone names it
 * only in a college game: NFL titles use full names, and "Chicago" alone is the Cubs as much as the Bears.
 */
function namesTeam(title: string, team: Team, league: LeagueId): boolean {
  const words = ` ${normalized(title)} `
  const names = league === "nfl" ? [team.shortName, team.name] : [team.location, team.shortName, team.name]
  return names.some((name) => words.includes(` ${normalized(name)} `))
}

/** Lower case, "&" read as "and", every run of punctuation and space a single space. */
function normalized(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}
