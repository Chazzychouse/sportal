import { Schema } from "effect"
import * as EspnSnapshot from "./EspnSnapshot.ts"

const Competitor = Schema.Struct({
  homeAway: Schema.Literals(["home", "away"]),
  score: Schema.optional(EspnSnapshot.Score),
  curatedRank: Schema.optional(Schema.Struct({ current: EspnSnapshot.Ranking })),
  team: Schema.Struct({
    id: Schema.String,
    abbreviation: Schema.String,
    displayName: Schema.String,
    location: Schema.optional(Schema.String),
    shortDisplayName: Schema.optional(Schema.String),
    logo: Schema.optional(Schema.String)
  })
})

export const Event = Schema.Struct({
  id: Schema.String,
  date: Schema.String,
  status: Schema.Struct({
    period: Schema.Int,
    displayClock: Schema.String,
    type: EspnSnapshot.Status
  }),
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
      situation: Schema.optional(EspnSnapshot.Situation),
      competitors: Schema.Array(Competitor)
    })
  )
})

export const Scoreboard = Schema.Struct({
  events: Schema.Array(Schema.Unknown)
})
