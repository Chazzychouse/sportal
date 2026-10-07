import type { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Effect, Schema, SchemaGetter } from "effect"
import { Summary } from "./EspnPayload.ts"
import * as EspnPlay from "./EspnPlay.ts"

/**
 * ESPN's game summary, read as its plays of `league` with their wallclocks, in `Play.order`; a play without a wallclock
 * is not read. A timeout's team is the one its team participants mark as having called it; timeouts with none marked
 * are logged together, once, and count for neither team.
 */
export function SummaryPlays(league: LeagueId) {
  return Summary.pipe(
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

const Read = Schema.Array(
  Schema.Struct({
    play: Schema.toType(Play),
    wallclock: Schema.toType(Schema.DateTimeUtcFromString)
  })
)
