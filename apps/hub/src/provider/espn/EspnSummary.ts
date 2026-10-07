import type { LeagueId } from "@sportal/domain/League"
import { Play, PlayId } from "@sportal/domain/Play"
import { TeamId } from "@sportal/domain/Team"
import { Effect, Schema, SchemaGetter } from "effect"
import type { ArchivedPlay } from "../../corpus/Archive.ts"
import * as EspnPlay from "./EspnPlay.ts"

/**
 * ESPN's game summary, read as its plays with their wallclocks; a play without one is not read. A timeout says who
 * called it when its text names one of the header's teams ("Timeout #1 by NE at 03:27."), by its abbreviation or, for
 * the one team the game's timeouts never name so, by the one other code they use; one that names neither is logged
 * and says no caller.
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
          .map((read) => ({
            read,
            code: read.play.kind === "timeout" ? callerOf.exec(read.play.text)?.[1] : undefined
          }))
        const teams = callers(
          league,
          (header?.competitions ?? []).flatMap(({ competitors }) => competitors),
          new Set(plays.flatMap(({ code }) => (code === undefined ? [] : [code])))
        )
        const read = plays.map(({ read, code }) => {
          const timeoutBy = code === undefined ? undefined : teams.get(code)
          return timeoutBy === undefined ? read : { ...read, timeoutBy }
        })
        return {
          plays: read,
          uncalled: read.flatMap(({ play, ...read }) =>
            play.kind === "timeout" && !("timeoutBy" in read) ? [play.id] : []
          )
        }
      }),
      encode: SchemaGetter.forbidden(() => "Plays cannot be encoded back to an ESPN game summary")
    })
  )
}

// A called timeout's text names its caller by a code: "Timeout #1 by NE at 03:27."
const callerOf = /\bby ([A-Z0-9&]+)\b/

/**
 * The team each of a game's caller `codes` names. A code that is a header team's abbreviation is that team. The text
 * may use another code for a team (the NFL's BLT for the header's BAL, HST for HOU), so when exactly one code is left
 * and exactly one header team was never named, they are the same team. Any other code names no team.
 */
function callers(
  league: LeagueId,
  competitors: ReadonlyArray<{ readonly id: string; readonly team: { readonly abbreviation: string } }>,
  codes: ReadonlySet<string>
): ReadonlyMap<string, TeamId> {
  const team = ({ id }: { readonly id: string }) => TeamId.make(`${league}:${id}`)
  const named = competitors.filter(({ team }) => codes.has(team.abbreviation))
  const unnamed = competitors.filter(({ team }) => !codes.has(team.abbreviation))
  const left = [...codes].filter((code) => !named.some(({ team }) => team.abbreviation === code))
  const [code] = left
  const [rest] = unnamed
  return new Map([
    ...named.map(({ team: { abbreviation }, ...competitor }) => [abbreviation, team(competitor)] as const),
    ...(left.length === 1 && unnamed.length === 1 && code !== undefined && rest !== undefined
      ? [[code, team(rest)] as const]
      : [])
  ])
}

const decodeSummary = {
  nfl: Schema.decodeUnknownEffect(Summary("nfl")),
  fbs: Schema.decodeUnknownEffect(Summary("fbs"))
}
