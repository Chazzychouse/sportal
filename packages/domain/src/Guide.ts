import { Channel, type ChannelAvailability, SourceName, StreamLocator } from "@sportal/domain/Channel"
import { type GameSnapshot, Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import type { Team } from "@sportal/domain/Team"
import { Array as Arr, DateTime, Duration, Option, Schema } from "effect"

export const ChannelId = Schema.String.pipe(Schema.brand("ChannelId"))
export type ChannelId = typeof ChannelId.Type

export const Airing = Schema.Struct({
  channel: ChannelId,
  title: Schema.String,
  begin: Schema.DateTimeUtc,
  end: Schema.DateTimeUtc
})
export type Airing = typeof Airing.Type

/** An airing as a client sees it: its title, begin and end, without its channel's id. */
const OnAir = Schema.Struct({
  title: Schema.String,
  begin: Schema.DateTimeUtcFromString,
  end: Schema.DateTimeUtcFromString
})

/**
 * A source's sports channels that play live, in its guide's order, each with the airing on it now and the next to
 * begin; given by `Guide#lineup`.
 */
export const Lineup = Schema.Array(
  Schema.Struct({
    channel: Channel,
    now: Schema.OptionFromOptionalKey(OnAir),
    next: Schema.OptionFromOptionalKey(OnAir)
  })
)
export type Lineup = typeof Lineup.Type

export class Guide extends Schema.Class<Guide>("sportal/Guide")({
  source: SourceName,
  readAt: Schema.DateTimeUtc,
  channels: Schema.Array(
    Schema.Struct({
      id: ChannelId,
      name: Schema.String,
      live: Schema.optional(StreamLocator),
      network: Schema.optional(Network)
    })
  ),
  airings: Schema.Array(Airing)
}) {
  /**
   * How far past its reading a guide's airings are complete. The first page of YouTube TV's guide reached 3h46m past
   * the half hour before the read (spike, 2026-10-03); a later start may not be listed yet.
   */
  static readonly reach = Duration.hours(3)

  /**
   * Where this source shows a game at `now`, from the airing that names both its teams, has not ended, and begins near
   * its start or is on now while the game is under way. Of several, the one on a channel named for one of the game's
   * networks wins, then the first in the guide. With no such airing, a channel that carries one of the game's networks
   * shows it as if it aired from its start, until the game is over. Either is carried once its channel is on the air and
   * either its airing has begun, so the pregame shows, or the game has started; until then it is upcoming. With
   * neither, a start past the reach of a guide that lists airings is upcoming, and any other game is not carried.
   */
  availabilityOf(game: GameSnapshot, now: DateTime.Utc): ChannelAvailability {
    const nearStart = {
      minimum: DateTime.subtractDuration(game.startsAt, startTolerance),
      maximum: DateTime.addDuration(game.startsAt, startTolerance)
    }
    const matches = this.airings.filter((airing) => this.airs(airing, game, now, nearStart))
    const [first] = matches
    if (first !== undefined) {
      const airing =
        matches.find((candidate) =>
          game.broadcasts.some(({ network }) => namesNetwork(this.channelOf(candidate).name, network))
        ) ?? first
      return this.from(this.channelOf(airing), airing.begin, game, now)
    }

    const carrier = this.channels.find((channel) =>
      game.broadcasts.some(({ network }) => channel.network === network)
    )
    if (carrier !== undefined && game.progress() !== "over")
      return this.from(carrier, game.startsAt, game, now)

    const pastReach = DateTime.isGreaterThan(game.startsAt, DateTime.addDuration(this.readAt, Guide.reach))
    if (this.airings.length > 0 && pastReach)
      return { _tag: "Upcoming", channel: Option.none(), begin: Option.none() }
    const streamingOnly =
      game.broadcasts.length > 0 && game.broadcasts.every(({ medium }) => medium === "streaming")
    return { _tag: "NotCarried", why: streamingOnly ? "StreamingOnly" : "NotInGuide" }
  }

  /**
   * This guide's sports channels that play live, in its order, each with the airing on at `now` and the earliest to
   * begin after it. A sports channel is one network's stream, one whose name names a sports network ("ABC 13" for
   * ABC), or one `alsoNamed` names (a local station named for its call sign, as "News 3"), read without case or
   * punctuation.
   */
  lineup(now: DateTime.Utc, alsoNamed: ReadonlyArray<string>): Lineup {
    const named = new Set(alsoNamed.map(normalized))
    return this.channels.flatMap(({ id, name, live, network }) => {
      const sports =
        network !== undefined ||
        named.has(normalized(name)) ||
        sportsNetworks.some((sportsNetwork) => namesNetwork(name, sportsNetwork))
      if (live === undefined || !sports) return []

      const airings = this.airings.filter(({ channel }) => channel === id)
      const onNow = Arr.findFirst(
        airings,
        ({ begin, end }) => DateTime.isLessThanOrEqualTo(begin, now) && DateTime.isLessThan(now, end)
      )
      const later = airings.filter(({ begin }) => DateTime.isGreaterThan(begin, now))
      const next = Arr.head(Arr.sortWith(later, ({ begin }) => begin, DateTime.Order))
      const channel = { name, source: this.source, locator: live }
      return [{ channel, now: Option.map(onNow, onAir), next: Option.map(next, onAir) }]
    })
  }

  /**
   * Carried on `channel` once it is on the air and either `now` has reached `begin` or `game` has started; else
   * upcoming from `begin`.
   */
  private from(
    channel: { readonly name: string; readonly live?: StreamLocator | undefined },
    begin: DateTime.Utc,
    game: GameSnapshot,
    now: DateTime.Utc
  ): ChannelAvailability {
    const begun = DateTime.isGreaterThanOrEqualTo(now, begin) || game.progress() !== "upcoming"
    return channel.live !== undefined && begun
      ? { _tag: "Carried", channel: { name: channel.name, source: this.source, locator: channel.live } }
      : { _tag: "Upcoming", channel: Option.some(channel.name), begin: Option.some(begin) }
  }

  private airs(
    airing: Airing,
    game: GameSnapshot,
    now: DateTime.Utc,
    nearStart: { readonly minimum: DateTime.Utc; readonly maximum: DateTime.Utc }
  ): boolean {
    const onNow =
      game.progress() === "live" && DateTime.between(now, { minimum: airing.begin, maximum: airing.end })
    return (
      (DateTime.between(airing.begin, nearStart) || onNow) &&
      DateTime.isGreaterThan(airing.end, now) &&
      namesTeam(airing.title, game.home.team, game.league) &&
      namesTeam(airing.title, game.away.team, game.league)
    )
  }

  private channelOf(airing: Airing): { readonly name: string; readonly live?: StreamLocator | undefined } {
    return this.channels.find(({ id }) => id === airing.channel) ?? { name: airing.channel }
  }
}

/** How far an airing may begin from a game's start and still be the game: listings round, and starts slip. */
const startTolerance = Duration.minutes(45)

/** The networks whose channels are sports channels, as channel names spell them; locals by their network's name. */
const sportsNetworks = [
  "ESPN",
  "ESPN2",
  "ESPNU",
  "ESPNews",
  "SEC Network",
  "ACC Network",
  "Big Ten Network",
  "BTN",
  "FS1",
  "FS2",
  "NFL Network",
  "NFL RedZone",
  "CBS Sports Network",
  "NBCSN",
  "Golf Channel",
  "NBA TV",
  "MLB Network",
  "NHL Network",
  "Tennis Channel",
  "TBS",
  "TNT",
  "truTV",
  "USA",
  "ABC",
  "CBS",
  "NBC",
  "FOX"
].map((name) => Network.make(name))

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

/** An airing without its channel, as the lineup sends it. */
function onAir({ title, begin, end }: Airing): { title: string; begin: DateTime.Utc; end: DateTime.Utc } {
  return { title, begin, end }
}

/** Lower case, "&" read as "and", every run of punctuation and space a single space. */
function normalized(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}
