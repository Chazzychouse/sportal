import { Schema, SchemaGetter } from "effect"

/** The site scoreboard, as polled: its events, each for `EspnEvent` to read. */
export const Scoreboard = Schema.Struct({ events: Schema.Array(Schema.Unknown) })

/** The game's status as the site scoreboard spells it. */
export const EspnStatus = Schema.Struct({
  period: Schema.Int,
  /** Seconds left in the period, as ESPN counts them. */
  clock: Schema.Finite,
  type: Schema.Struct({
    name: Schema.String,
    state: Schema.Literals(["pre", "in", "post"]),
    shortDetail: Schema.String
  })
})
export type EspnStatus = typeof EspnStatus.Type

/** The down, distance and ball of a game in play, as the site scoreboard spells it. */
export const EspnSituation = Schema.Struct({
  possession: Schema.optional(Schema.String),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardLine: Schema.optional(Schema.Int),
  homeTimeouts: Schema.optional(Schema.Int),
  awayTimeouts: Schema.optional(Schema.Int)
})
export type EspnSituation = typeof EspnSituation.Type

/** One side of a site scoreboard competition: its score as digits, its poll rank, and its team. */
const Competitor = Schema.Struct({
  homeAway: Schema.Literals(["home", "away"]),
  score: Schema.optional(Schema.String),
  curatedRank: Schema.optional(Schema.Struct({ current: Schema.Int })),
  records: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String), summary: Schema.String }))
  ),
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

/** A competition's betting line: ESPN's spread is the home team's, and each side says whether it is favored. */
export const EspnOdds = Schema.Struct({
  spread: Schema.optional(Schema.Finite),
  overUnder: Schema.optional(Schema.Finite),
  homeTeamOdds: Schema.optional(Schema.Struct({ favorite: Schema.optional(Schema.Boolean) })),
  awayTeamOdds: Schema.optional(Schema.Struct({ favorite: Schema.optional(Schema.Boolean) }))
})
export type EspnOdds = typeof EspnOdds.Type

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
      odds: Schema.optional(Schema.Array(EspnOdds)),
      competitors: Schema.Array(Competitor)
    })
  )
})

/** A play's reference to a team, `{ $key }`, read as ESPN's id for it. */
const TeamRef = Schema.Struct({ $key: Schema.String }).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform(({ $key }) => $key),
    encode: SchemaGetter.transform(($key) => ({ $key }))
  })
)

/** A play's type: ESPN's id for it, and its text. */
const PlayType = Schema.Struct({ id: Schema.String, text: Schema.String })

const Spot = Schema.Struct({
  team: Schema.optional(TeamRef),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardsToEndzone: Schema.optional(Schema.Int)
})

/** ESPN's play entity, as a game package lists it under `entities.plays`. */
export const PlayEntity = Schema.Struct({
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
  start: Spot,
  end: Spot,
  team: Schema.optional(TeamRef),
  participants: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String), team: Schema.optional(TeamRef) }))
  )
})
