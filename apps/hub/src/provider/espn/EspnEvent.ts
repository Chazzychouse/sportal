import { type Broadcast, GameId, GameSnapshot, GameStatus, Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Situation as DomainSituation } from "@sportal/domain/Situation"
import { Team, TeamId } from "@sportal/domain/Team"
import { type DateTime, Effect, Schema, SchemaGetter, SchemaIssue } from "effect"

/**
 * One game as either ESPN feed spells it, read as a `league` `GameSnapshot`: an event of the site scoreboard the Hub
 * polls, or an event of a FastCast scoreboard topic's document. An event without a home and an away team does not
 * decode.
 */
export function EspnEvent(league: LeagueId) {
  return Schema.Union([
    Schema.Struct({
      id: Schema.String,
      date: Schema.DateTimeUtcFromString,
      status: Status,
      competitions: Schema.NonEmptyArray(
        Schema.Struct({
          geoBroadcasts: Schema.optional(
            Schema.Array(
              Schema.Struct({
                type: Schema.Struct({ shortName: Schema.String }),
                media: Schema.Struct({ shortName: Schema.String })
              })
            )
          ),
          situation: Schema.optional(Situation),
          competitors: Schema.Array(
            Schema.Struct({
              homeAway: Schema.Literals(["home", "away"]),
              score: Schema.optional(Score),
              curatedRank: Schema.optional(Schema.Struct({ current: Ranking })),
              team: Schema.Struct({
                id: Schema.String,
                abbreviation: Schema.String,
                displayName: Schema.String,
                location: Schema.optional(Schema.String),
                shortDisplayName: Schema.optional(Schema.String),
                logo: Schema.optional(Schema.String),
                color: Schema.optional(Schema.String),
                alternateColor: Schema.optional(Schema.String)
              })
            })
          )
        })
      )
    }).pipe(
      Schema.decodeTo(Schema.toType(GameSnapshot), {
        decode: SchemaGetter.transformEffect((event) => {
          const [competition] = event.competitions
          return snapshot(league, {
            id: event.id,
            kickoff: event.date,
            status: event.status,
            competitors: competition.competitors.map(({ homeAway, score, curatedRank, team }) => ({
              ...team,
              homeAway,
              score,
              ranking: curatedRank?.current
            })),
            broadcasts: (competition.geoBroadcasts ?? []).map(({ type, media }) => ({
              medium: type.shortName,
              network: media.shortName
            })),
            situation: competition.situation
          })
        }),
        encode: SchemaGetter.forbidden(() => "A GameSnapshot cannot be encoded back to an ESPN event")
      })
    ),
    // FastCast's competitor is the team itself, with its score and rank beside its names, and no short name.
    Schema.Struct({
      id: Schema.String,
      date: Schema.DateTimeUtcFromString,
      fullStatus: Status,
      competitors: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          homeAway: Schema.Literals(["home", "away"]),
          score: Schema.optional(Score),
          abbreviation: Schema.String,
          displayName: Schema.String,
          location: Schema.optional(Schema.String),
          logo: Schema.optional(Schema.String),
          rank: Schema.optional(Ranking)
        })
      ),
      broadcasts: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, shortName: Schema.String }))
      ),
      situation: Schema.optional(Situation)
    }).pipe(
      Schema.decodeTo(Schema.toType(GameSnapshot), {
        decode: SchemaGetter.transformEffect((event) =>
          snapshot(league, {
            id: event.id,
            kickoff: event.date,
            status: event.fullStatus,
            competitors: event.competitors.map(({ rank, ...competitor }) => ({
              ...competitor,
              ranking: rank
            })),
            broadcasts: (event.broadcasts ?? []).map(({ type, shortName }) => ({
              medium: type,
              network: shortName
            })),
            situation: event.situation
          })
        ),
        encode: SchemaGetter.forbidden(() => "A GameSnapshot cannot be encoded back to an ESPN event")
      })
    )
  ])
}

// The game's status as both feeds spell it (the site's `status`, FastCast's `fullStatus`).
const Status = Schema.Struct({
  period: Schema.Int,
  displayClock: Schema.String,
  type: Schema.Struct({
    name: Schema.String,
    state: Schema.Literals(["pre", "in", "post"])
  }).pipe(
    Schema.decodeTo(GameStatus, {
      decode: SchemaGetter.transform(statusOf),
      encode: SchemaGetter.forbidden(() => "A GameStatus cannot be encoded back to ESPN's status type")
    })
  )
})

// A competitor's score: digits, or nothing before kickoff, which reads as 0.
const Score = Schema.String.pipe(
  Schema.decodeTo(Schema.Int, {
    decode: SchemaGetter.transform((score) => Number.parseInt(score, 10) || 0),
    encode: SchemaGetter.transform(String)
  })
)

// ESPN ranks an unranked team 99, which reads as no ranking.
const Ranking = Schema.Int.pipe(
  Schema.decodeTo(Schema.UndefinedOr(Schema.Int), {
    decode: SchemaGetter.transform((rank) => (rank > 25 ? undefined : rank)),
    encode: SchemaGetter.transform((ranking) => ranking ?? 99)
  })
)

const Situation = Schema.Struct({
  possession: Schema.optional(Schema.String),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardLine: Schema.optional(Schema.Int),
  homeTimeouts: Schema.optional(Schema.Int),
  awayTimeouts: Schema.optional(Schema.Int),
  lastPlay: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) }))
})

/** The snapshot an event says, once each feed's spelling is read into one shape. */
function snapshot(
  league: LeagueId,
  event: {
    readonly id: string
    readonly kickoff: DateTime.Utc
    readonly status: typeof Status.Type
    readonly competitors: ReadonlyArray<{
      readonly homeAway: "home" | "away"
      readonly id: string
      readonly abbreviation: string
      readonly displayName: string
      readonly location?: string | undefined
      readonly shortDisplayName?: string | undefined
      readonly logo?: string | undefined
      readonly color?: string | undefined
      readonly alternateColor?: string | undefined
      readonly score?: number | undefined
      readonly ranking?: number | undefined
    }>
    readonly broadcasts: ReadonlyArray<{ readonly medium: string; readonly network: string }>
    readonly situation: typeof Situation.Type | undefined
  }
): Effect.Effect<GameSnapshot, SchemaIssue.Issue> {
  const home = event.competitors.find((competitor) => competitor.homeAway === "home")
  const away = event.competitors.find((competitor) => competitor.homeAway === "away")
  if (home === undefined || away === undefined) {
    return Effect.fail(
      new SchemaIssue.InvalidValue({ message: "An event needs a home and an away team" }, event)
    )
  }
  const side = (competitor: typeof home) => ({
    team: new Team({
      id: TeamId.make(`${league}:${competitor.id}`),
      abbreviation: competitor.abbreviation,
      name: competitor.displayName,
      location: competitor.location ?? competitor.displayName,
      // FastCast has no short name: EspnDecode advances each pushed game's listed game to it, keeping the poll's names.
      shortName: competitor.shortDisplayName ?? competitor.displayName,
      logo: competitor.logo,
      color: competitor.color,
      alternateColor: competitor.alternateColor
    }),
    score: competitor.score ?? 0,
    ranking: competitor.ranking
  })
  return Effect.succeed(
    new GameSnapshot({
      id: GameId.make(event.id),
      league,
      kickoff: event.kickoff,
      status: event.status.type,
      period: event.status.period,
      clock: event.status.displayClock,
      home: side(home),
      away: side(away),
      broadcasts: event.broadcasts.flatMap(({ medium, network }) => broadcast(medium, network)),
      situation: event.situation === undefined ? undefined : situation(league, event.situation, home.id)
    })
  )
}

// ESPN also lists radio, which no source plays.
function broadcast(medium: string, network: string): Array<Broadcast> {
  return medium === "TV"
    ? [{ network: Network.make(network), medium: "tv" }]
    : medium === "Streaming"
      ? [{ network: Network.make(network), medium: "streaming" }]
      : []
}

/** The domain `Situation`; the league and the home team's id orient its possession and yard line. */
function situation(league: LeagueId, raw: typeof Situation.Type, homeTeamId: string): DomainSituation {
  return new DomainSituation({
    homeTimeouts: raw.homeTimeouts ?? 0,
    awayTimeouts: raw.awayTimeouts ?? 0,
    ...(raw.possession === undefined ? {} : { possession: TeamId.make(`${league}:${raw.possession}`) }),
    // ESPN reports down -1 between plays (after a score, before a kickoff).
    ...(raw.down === undefined || raw.down < 1 ? {} : { down: raw.down }),
    ...(raw.distance === undefined ? {} : { distance: raw.distance }),
    // ESPN counts the yard line from the home goal line; the domain counts it to the goal the team with
    // the ball attacks. Without a team on the ball it cannot be oriented.
    ...(raw.yardLine === undefined || raw.possession === undefined
      ? {}
      : { yardLine: raw.possession === homeTeamId ? 100 - raw.yardLine : raw.yardLine }),
    ...(raw.lastPlay?.text === undefined ? {} : { lastPlay: raw.lastPlay.text })
  })
}

function statusOf(type: { readonly name: string; readonly state: "pre" | "in" | "post" }): GameStatus {
  switch (type.name) {
    case "STATUS_HALFTIME":
      return "halftime"
    case "STATUS_DELAYED":
      return "delayed"
    case "STATUS_POSTPONED":
      return "postponed"
    case "STATUS_CANCELED":
      return "canceled"
  }
  return type.state === "pre" ? "scheduled" : type.state === "in" ? "live" : "final"
}
