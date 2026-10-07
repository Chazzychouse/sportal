import type { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Effect, Schema, SchemaGetter } from "effect"
import type { ArchivedPlay } from "../../corpus/Archive.ts"
import * as EspnPlay from "./EspnPlay.ts"

/**
 * ESPN's game summary, read as its plays with their wallclocks, in `Play.order`; a play without a wallclock is not
 * read. A timeout's team is the one its team participants mark as having called it; timeouts with none marked are logged
 * together, once, and count for neither team.
 */
export function plays(
  league: LeagueId,
  summary: unknown
): Effect.Effect<ReadonlyArray<ArchivedPlay>, Schema.SchemaError> {
  return decodeSummary[league](summary)
}

// A summary's play refers to a team by its `id`, ESPN's id for it.
const TeamRef = Schema.Struct({ id: Schema.String }).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform(({ id }) => id),
    encode: SchemaGetter.transform((id) => ({ id }))
  })
)

// A play as a summary's drive lists it: its team is the one with the ball as it ended, as FastCast's entity has it, and
// a timeout's caller is the team participant marked `timeout`.
const SummaryPlay = Schema.Struct({
  ...EspnPlay.fields(TeamRef),
  teamParticipants: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, timeout: Schema.optional(Schema.Boolean) }))
  ),
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
  Schema.Struct({
    play: Schema.toType(Play),
    wallclock: Schema.toType(Schema.DateTimeUtcFromString)
  })
)

function Summary(league: LeagueId) {
  return Raw.pipe(
    Schema.decodeTo(Read, {
      decode: SchemaGetter.transformEffect(({ drives, winprobability }) => {
        const probabilities = new Map(
          (winprobability ?? []).map(({ playId, homeWinPercentage }) => [playId, homeWinPercentage])
        )
        const wallclocked = (drives?.previous ?? [])
          .flatMap((drive) => drive.plays ?? [])
          .flatMap(({ wallclock, ...play }) => (wallclock === undefined ? [] : [{ play, wallclock }]))

        return Effect.gen(function* () {
          const read = yield* Effect.forEach(wallclocked, ({ play, wallclock }) =>
            Effect.map(
              EspnPlay.read(league, {
                ...play,
                team: play.end.team,
                caller: play.teamParticipants?.find(({ timeout }) => timeout === true)?.id,
                homeWinProbability: probabilities.get(play.id)
              }),
              (read) => ({ play: read, wallclock })
            )
          )

          const uncalled = read.flatMap(({ play }) =>
            Play.guards.Timeout(play) && play.team === undefined ? [play.id] : []
          )
          if (uncalled.length > 0) {
            yield* Effect.logWarning(
              `EspnSummary: ${league} timeouts ${uncalled.join(", ")} have no caller marked; counted for neither`
            )
          }

          return read.toSorted((a, b) => Play.order(a.play, b.play))
        })
      }),
      encode: SchemaGetter.forbidden(() => "Plays cannot be encoded back to an ESPN game summary")
    })
  )
}

const decodeSummary = {
  nfl: Schema.decodeUnknownEffect(Summary("nfl")),
  fbs: Schema.decodeUnknownEffect(Summary("fbs"))
}
