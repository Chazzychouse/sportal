import { DateTime, Duration, Option, Schema } from "effect"
import { ChannelAvailability, SourceName } from "./Channel.ts"
import type { GameSnapshot, Network } from "./Game.ts"
import type { LeagueId } from "./League.ts"
import { StreamLocator } from "./Stream.ts"
import type { Team } from "./Team.ts"

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
    const nearKickoff = DateTime.between(airing.begin, {
      minimum: DateTime.subtractDuration(game.kickoff, kickoffTolerance),
      maximum: DateTime.addDuration(game.kickoff, kickoffTolerance)
    })
    const onNow =
      game.progress() === "live" &&
      DateTime.between(this.readAt, { minimum: airing.begin, maximum: airing.end })
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
