import { Schema } from "effect"

/** A baseball team stat inside one of its groups (`batting`, `pitching`, `fielding`). */
const GroupedStat = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  displayValue: Schema.String
})

/**
 * One entry of a team's box score `statistics`: a labeled stat (football, basketball), or a named group of stats
 * (baseball).
 */
export const SummaryStat = Schema.Struct({
  name: Schema.String,
  label: Schema.optional(Schema.String),
  displayValue: Schema.optional(Schema.String),
  stats: Schema.optional(Schema.Array(GroupedStat))
})
export type SummaryStat = typeof SummaryStat.Type

/** One of the summary's videos: its id, headline, seconds, thumbnail, and its mp4s. */
export const SummaryVideo = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Finite]),
  headline: Schema.String,
  duration: Schema.Int,
  thumbnail: Schema.optional(Schema.String),
  links: Schema.optional(
    Schema.Struct({
      source: Schema.optional(
        Schema.Struct({
          href: Schema.String,
          HD: Schema.optional(Schema.Struct({ href: Schema.String }))
        })
      )
    })
  )
})
export type SummaryVideo = typeof SummaryVideo.Type

/** A team's leaders: by category, each with its leading athletes. */
export const SummaryLeaders = Schema.Struct({
  team: Schema.Struct({ id: Schema.String }),
  leaders: Schema.Array(
    Schema.Struct({
      displayName: Schema.String,
      leaders: Schema.Array(
        Schema.Struct({
          displayValue: Schema.String,
          athlete: Schema.Struct({
            displayName: Schema.String,
            headshot: Schema.optional(Schema.Struct({ href: Schema.String }))
          })
        })
      )
    })
  )
})
export type SummaryLeaders = typeof SummaryLeaders.Type

/**
 * The game summary, as `EspnSummary` reads it: the header's competitors (ids, sides, points per period), the box
 * score's team stats, the leaders, the win probability by play, the scoring plays (football), the plays (baseball's
 * scoring plays are read from them), and the videos.
 */
export const EspnSummaryPayload = Schema.Struct({
  header: Schema.Struct({
    competitions: Schema.NonEmptyArray(
      Schema.Struct({
        competitors: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            homeAway: Schema.Literals(["home", "away"]),
            linescores: Schema.optional(Schema.Array(Schema.Struct({ displayValue: Schema.String })))
          })
        )
      })
    )
  }),
  boxscore: Schema.optional(
    Schema.Struct({
      teams: Schema.Array(
        Schema.Struct({
          homeAway: Schema.Literals(["home", "away"]),
          statistics: Schema.optional(Schema.Array(SummaryStat))
        })
      )
    })
  ),
  leaders: Schema.optional(Schema.Array(SummaryLeaders)),
  winprobability: Schema.optional(
    Schema.Array(Schema.Struct({ playId: Schema.String, homeWinPercentage: Schema.Finite }))
  ),
  scoringPlays: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
  plays: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, scoringPlay: Schema.optional(Schema.Boolean) }))
  ),
  videos: Schema.optional(Schema.Array(SummaryVideo))
})
export type EspnSummaryPayload = typeof EspnSummaryPayload.Type
