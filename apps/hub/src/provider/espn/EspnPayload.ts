import { Record, Schema, SchemaGetter } from "effect"

/** The site scoreboard, as polled or as fetched for a past date: its events, each for `EspnEvent` to read. */
export const Scoreboard = Schema.Struct({ events: Schema.Array(Schema.Unknown) })

/** The game's status as both feeds spell it: the site's `status`, FastCast's `fullStatus`. */
export const EspnStatus = Schema.Struct({
  period: Schema.Int,
  displayClock: Schema.String,
  type: Schema.Struct({
    name: Schema.String,
    state: Schema.Literals(["pre", "in", "post"])
  })
})
export type EspnStatus = typeof EspnStatus.Type

/** The down, distance and ball of a game in play, as both feeds spell it. */
export const EspnSituation = Schema.Struct({
  possession: Schema.optional(Schema.String),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardLine: Schema.optional(Schema.Int),
  homeTimeouts: Schema.optional(Schema.Int),
  awayTimeouts: Schema.optional(Schema.Int),
  lastPlay: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) }))
})
export type EspnSituation = typeof EspnSituation.Type

/** One side of a site scoreboard competition: its score as digits, its poll rank, and its team. */
const Competitor = Schema.Struct({
  homeAway: Schema.Literals(["home", "away"]),
  score: Schema.optional(Schema.String),
  curatedRank: Schema.optional(Schema.Struct({ current: Schema.Int })),
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

/** One event of the site scoreboard: what the decoder reads of it. */
export const SiteEvent = Schema.Struct({
  id: Schema.String,
  date: Schema.DateTimeUtcFromString,
  status: EspnStatus,
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
      situation: Schema.optional(EspnSituation),
      competitors: Schema.Array(Competitor)
    })
  )
})

/**
 * One event of a FastCast scoreboard topic's document. Its competitor is the team itself, with its score and rank
 * beside its names, and no short name.
 */
export const FastCastEvent = Schema.Struct({
  id: Schema.String,
  date: Schema.DateTimeUtcFromString,
  fullStatus: EspnStatus,
  competitors: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      homeAway: Schema.Literals(["home", "away"]),
      score: Schema.optional(Schema.String),
      abbreviation: Schema.String,
      displayName: Schema.String,
      location: Schema.optional(Schema.String),
      logo: Schema.optional(Schema.String),
      color: Schema.optional(Schema.String),
      alternateColor: Schema.optional(Schema.String),
      rank: Schema.optional(Schema.Int)
    })
  ),
  broadcasts: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String, shortName: Schema.String }))),
  situation: Schema.optional(EspnSituation)
})

/**
 * A play's reference to a team, read as ESPN's id for it: FastCast's entity spells it `{ $key }`, a game summary's play
 * `{ id }`.
 */
function TeamRef<Key extends "$key" | "id">(key: Key) {
  return Schema.Record(Schema.Literal(key), Schema.String).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((ref) => ref[key]),
      encode: SchemaGetter.transform((id) => Record.singleton(key, id))
    })
  )
}

/** A play's type: ESPN's id for it, and its text. */
export const PlayType = Schema.Struct({ id: Schema.String, text: Schema.String })
export type PlayType = typeof PlayType.Type

/**
 * The fields of a play that both of ESPN's feeds spell alike, a spot's team read by `team`: FastCast's entity refers to
 * a team by `$key`, a game summary's play by `id`.
 */
export function PlayFields<Team extends Schema.Top>(team: Team) {
  const spot = Schema.Struct({
    team: Schema.optional(team),
    down: Schema.optional(Schema.Int),
    distance: Schema.optional(Schema.Int),
    yardsToEndzone: Schema.optional(Schema.Int)
  })
  return {
    id: Schema.String,
    sequenceNumber: Schema.FiniteFromString.check(Schema.isInt()),
    type: PlayType,
    text: Schema.String,
    period: Schema.Struct({ number: Schema.Int }),
    clock: Schema.Struct({ displayValue: Schema.String }),
    statYardage: Schema.Int,
    scoringPlay: Schema.Boolean,
    homeScore: Schema.Int,
    awayScore: Schema.Int,
    start: spot,
    end: spot
  }
}

/** ESPN's play entity, as a game package lists it under `entities.plays`. */
export const PlayEntity = Schema.Struct({
  ...PlayFields(TeamRef("$key")),
  team: Schema.optional(TeamRef("$key")),
  participants: Schema.optional(
    Schema.Array(
      Schema.Struct({ type: Schema.optional(Schema.String), team: Schema.optional(TeamRef("$key")) })
    )
  ),
  probabilities: Schema.optional(
    Schema.Struct({
      winProbability: Schema.optional(Schema.Struct({ homeWinPercentage: Schema.Finite }))
    })
  )
})
