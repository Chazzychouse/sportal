import type { LeagueId } from "@sportal/domain/League"
import { Play, PlayId } from "@sportal/domain/Play"
import { TeamId } from "@sportal/domain/Team"
import { Effect, Schema, SchemaGetter } from "effect"
import type { ArchivedPlay } from "../../corpus/Archive.ts"
import * as EspnPlay from "./EspnPlay.ts"

/**
 * ESPN's game summary, read as its plays with their wallclocks; a play without one is not read. A timeout says who
 * called it when its text names one of the header's teams ("Timeout #1 by NE at 03:27."); one that names neither is
 * logged and says no caller.
 */
export function plays(
  league: LeagueId,
  summary: unknown
): Effect.Effect<ReadonlyArray<ArchivedPlay>, Schema.SchemaError> {
  return decodeSummary[league](summary).pipe(
    Effect.tap(({ uncalled }) =>
      uncalled.length === 0
        ? Effect.void
        : Effect.logWarning(
            `EspnSummary: ${league} timeouts ${uncalled.join(", ")} name neither team as their caller; counted for neither`
          )
    ),
    Effect.map(({ plays }) => plays)
  )
}

// A summary's play refers to a team by its `id`, ESPN's id for it.
const TeamRef = Schema.Struct({ id: Schema.String }).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform(({ id }) => id),
    encode: SchemaGetter.transform((id) => ({ id }))
  })
)

// A play as a summary's drive lists it: its team is the one with the ball as it ended, as FastCast's entity has it.
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
  ),
  header: Schema.optional(
    Schema.Struct({
      competitions: Schema.Array(
        Schema.Struct({
          competitors: Schema.Array(
            Schema.Struct({ id: Schema.String, team: Schema.Struct({ abbreviation: Schema.String }) })
          )
        })
      )
    })
  )
})

// The plays read, and the timeouts among them whose caller did not read.
const Read = Schema.Struct({
  plays: Schema.Array(
    Schema.Struct({
      play: Schema.toType(Play),
      wallclock: Schema.toType(Schema.DateTimeUtcFromString),
      timeoutBy: Schema.optionalKey(TeamId)
    })
  ),
  uncalled: Schema.Array(PlayId)
})

function Summary(league: LeagueId) {
  return Raw.pipe(
    Schema.decodeTo(Read, {
      decode: SchemaGetter.transform(({ drives, winprobability, header }) => {
        const probabilities = new Map(
          (winprobability ?? []).map(({ playId, homeWinPercentage }) => [playId, homeWinPercentage])
        )
        const teams = new Map(
          (header?.competitions ?? [])
            .flatMap(({ competitors }) => competitors)
            .map(({ id, team }) => [team.abbreviation, TeamId.make(`${league}:${id}`)])
        )
        const plays = (drives?.previous ?? [])
          .flatMap((drive) => drive.plays ?? [])
          .flatMap(({ wallclock, ...play }) =>
            wallclock === undefined
              ? []
              : [
                  {
                    play: EspnPlay.read(league, {
                      ...play,
                      team: play.end.team,
                      homeWinProbability: probabilities.get(play.id)
                    }),
                    wallclock
                  }
                ]
          )
          .toSorted((a, b) => Play.order(a.play, b.play))
          .map((read) => {
            const caller = read.play.kind === "timeout" ? callerOf.exec(read.play.text)?.[1] : undefined
            const timeoutBy = caller === undefined ? undefined : teams.get(caller)
            return timeoutBy === undefined ? read : { ...read, timeoutBy }
          })
        return {
          plays,
          uncalled: plays.flatMap(({ play, ...read }) =>
            play.kind === "timeout" && !("timeoutBy" in read) ? [play.id] : []
          )
        }
      }),
      encode: SchemaGetter.forbidden(() => "Plays cannot be encoded back to an ESPN game summary")
    })
  )
}

// A called timeout's text names its caller by abbreviation: "Timeout #1 by NE at 03:27."
const callerOf = /\bby ([A-Z0-9&]+)\b/

const decodeSummary = {
  nfl: Schema.decodeUnknownEffect(Summary("nfl")),
  fbs: Schema.decodeUnknownEffect(Summary("fbs"))
}
