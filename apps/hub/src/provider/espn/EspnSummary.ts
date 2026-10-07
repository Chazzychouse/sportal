import type { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { type DateTime, type Effect, Schema, SchemaGetter } from "effect"
import * as EspnPlay from "./EspnPlay.ts"

/** ESPN's game summary, read as its plays with their wallclocks; a play without one is not read. */
export function plays(
  league: LeagueId,
  summary: unknown
): Effect.Effect<
  ReadonlyArray<{ readonly play: Play; readonly wallclock: DateTime.Utc }>,
  Schema.SchemaError
> {
  return decodeSummary[league](summary)
}

// A summary's play refers to a team by its `id`, ESPN's id for it.
const TeamRef = Schema.Struct({ id: Schema.String }).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform(({ id }) => id),
    encode: SchemaGetter.transform((id) => ({ id }))
  })
)

// A play as a summary's drive lists it: its team is the one with the ball as it started.
const SummaryPlay = Schema.Struct({
  ...EspnPlay.fields(TeamRef),
  wallclock: Schema.optional(Schema.DateTimeUtcFromString)
})

// What a summary has of its plays: each drive's, and each play's win probability by its id. A summary without drives
// has no plays.
const Raw = Schema.Struct({
  drives: Schema.optional(
    Schema.Struct({
      previous: Schema.Array(Schema.Struct({ plays: Schema.optional(Schema.Array(SummaryPlay)) }))
    })
  ),
  winprobability: Schema.optional(
    Schema.Array(Schema.Struct({ playId: Schema.String, homeWinPercentage: Schema.Finite }))
  )
})

const Read = Schema.Array(
  Schema.Struct({ play: Schema.toType(Play), wallclock: Schema.toType(Schema.DateTimeUtcFromString) })
)

function Summary(league: LeagueId) {
  return Raw.pipe(
    Schema.decodeTo(Read, {
      decode: SchemaGetter.transform(({ drives, winprobability }) => {
        const probabilities = new Map(
          (winprobability ?? []).map(({ playId, homeWinPercentage }) => [playId, homeWinPercentage])
        )
        return (drives?.previous ?? [])
          .flatMap((drive) => drive.plays ?? [])
          .flatMap(({ wallclock, ...play }) =>
            wallclock === undefined
              ? []
              : [
                  {
                    play: EspnPlay.read(league, {
                      ...play,
                      team: play.start.team,
                      homeWinProbability: probabilities.get(play.id)
                    }),
                    wallclock
                  }
                ]
          )
          .toSorted((a, b) => Play.order(a.play, b.play))
      }),
      encode: SchemaGetter.forbidden(() => "Plays cannot be encoded back to an ESPN game summary")
    })
  )
}

const decodeSummary = {
  nfl: Schema.decodeUnknownEffect(Summary("nfl")),
  fbs: Schema.decodeUnknownEffect(Summary("fbs"))
}
