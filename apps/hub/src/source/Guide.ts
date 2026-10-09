import { type ChannelAvailability, SourceName } from "@sportal/domain/Channel"
import { type GameSnapshot, Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { StreamLocator } from "@sportal/domain/Stream"
import type { Team } from "@sportal/domain/Team"
import { DateTime, Duration, Option, Schema } from "effect"

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
 * on the air and, for a channel that is one network's stream, that network; and what each airs.
 */
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
   * the half hour before the read (spike, 2026-10-03); a later kickoff may not be listed yet.
   */
  static readonly reach = Duration.hours(3)

  /**
   * Where this source shows a game at `now`, from the airing that names both its teams, has not ended, and begins near
   * kickoff or is on now while the game is under way. Of several, the one on a channel named for one of the game's
   * networks wins, then the first in the guide. With no such airing, a channel that carries one of the game's networks
   * shows it as if it aired from kickoff, until the game is over. Either is carried once its channel is on the air and
   * the game has started; until then it is upcoming. With neither, a kickoff past the reach of a
   * guide that lists airings is upcoming, and any other game is not carried.
   */
  availabilityOf(game: GameSnapshot, now: DateTime.Utc): ChannelAvailability {
    const nearKickoff = {
      minimum: DateTime.subtractDuration(game.kickoff, kickoffTolerance),
      maximum: DateTime.addDuration(game.kickoff, kickoffTolerance)
    }
    const matches = this.airings.filter((airing) => this.airs(airing, game, now, nearKickoff))
    const [first] = matches
    if (first !== undefined) {
      const airing =
        matches.find((candidate) =>
          game.broadcasts.some(({ network }) => namesNetwork(this.channelOf(candidate).name, network))
        ) ?? first
      return this.from(this.channelOf(airing), airing.begin, game)
    }

    const carrier = this.channels.find((channel) =>
      game.broadcasts.some(({ network }) => channel.network === network)
    )
    if (carrier !== undefined && game.progress() !== "over") return this.from(carrier, game.kickoff, game)

    const pastReach = DateTime.isGreaterThan(game.kickoff, DateTime.addDuration(this.readAt, Guide.reach))
    if (this.airings.length > 0 && pastReach)
      return { _tag: "Upcoming", channel: Option.none(), begin: Option.none() }
    const streamingOnly =
      game.broadcasts.length > 0 && game.broadcasts.every(({ medium }) => medium === "streaming")
    return { _tag: "NotCarried", why: streamingOnly ? "StreamingOnly" : "NotInGuide" }
  }

  /** Carried on `channel` once it is on the air and `game` has started; else upcoming from `begin`. */
  private from(
    channel: { readonly name: string; readonly live?: StreamLocator | undefined },
    begin: DateTime.Utc,
    game: GameSnapshot
  ): ChannelAvailability {
    return channel.live !== undefined && game.progress() !== "upcoming"
      ? { _tag: "Carried", channel: { name: channel.name, source: this.source, locator: channel.live } }
      : { _tag: "Upcoming", channel: Option.some(channel.name), begin: Option.some(begin) }
  }

  private airs(
    airing: Airing,
    game: GameSnapshot,
    now: DateTime.Utc,
    nearKickoff: { readonly minimum: DateTime.Utc; readonly maximum: DateTime.Utc }
  ): boolean {
    const onNow =
      game.progress() === "live" && DateTime.between(now, { minimum: airing.begin, maximum: airing.end })
    return (
      (DateTime.between(airing.begin, nearKickoff) || onNow) &&
      DateTime.isGreaterThan(airing.end, now) &&
      namesTeam(airing.title, game.home.team, game.league) &&
      namesTeam(airing.title, game.away.team, game.league)
    )
  }

  private channelOf(airing: Airing): { readonly name: string; readonly live?: StreamLocator | undefined } {
    return this.channels.find(({ id }) => id === airing.channel) ?? { name: airing.channel }
  }
}

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
