import { Schema } from "effect"

const Competitor = Schema.Struct({
  homeAway: Schema.Literals(["home", "away"]),
  score: Schema.optional(Schema.String),
  curatedRank: Schema.optional(Schema.Struct({ current: Schema.Int })),
  team: Schema.Struct({
    id: Schema.String,
    abbreviation: Schema.String,
    displayName: Schema.String,
    logo: Schema.optional(Schema.String)
  })
})

const Situation = Schema.Struct({
  possession: Schema.optional(Schema.String),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardLine: Schema.optional(Schema.Int),
  isRedZone: Schema.optional(Schema.Boolean),
  homeTimeouts: Schema.optional(Schema.Int),
  awayTimeouts: Schema.optional(Schema.Int),
  lastPlay: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) }))
})

export const Event = Schema.Struct({
  id: Schema.String,
  date: Schema.String,
  status: Schema.Struct({
    period: Schema.Int,
    displayClock: Schema.String,
    type: Schema.Struct({
      name: Schema.String,
      state: Schema.Literals(["pre", "in", "post"])
    })
  }),
  competitions: Schema.NonEmptyArray(
    Schema.Struct({
      broadcasts: Schema.optional(Schema.Array(Schema.Struct({ names: Schema.Array(Schema.String) }))),
      situation: Schema.optional(Situation),
      competitors: Schema.Array(Competitor)
    })
  )
})

export const Scoreboard = Schema.Struct({
  events: Schema.Array(Schema.Unknown)
})
