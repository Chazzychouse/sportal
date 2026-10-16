import type { LeagueId } from "@sportal/domain/League"
import { type FootballKind, Play } from "@sportal/domain/Play"
import { Effect, Schema, SchemaGetter } from "effect"
import * as EspnEvent from "./EspnEvent.ts"
import { PlayEntity } from "./EspnPayload.ts"

/** ESPN's play entity, as a game package lists it under `entities.plays`, read as a football `Play` of `league`. */
export function play(league: LeagueId) {
  return PlayEntity.pipe(
    Schema.decodeTo(Schema.toType(Play), {
      decode: SchemaGetter.transformEffect((entity) =>
        read(league, {
          ...entity,
          caller: entity.participants?.find(({ type }) => type === "timeout_taker")?.team
        })
      ),
      encode: SchemaGetter.forbidden(() => "A Play cannot be encoded back to an ESPN play entity")
    })
  )
}

/**
 * The football `Play` of `league` that an ESPN play says: the fields every sport's play carries, its team (a
 * timeout's `caller`, since ESPN's own `team` on one is the team with the ball), and its detail: the kind its type
 * reads as (`other` for a type the table does not know), its yards, and its spots. It fails when its start spot has
 * no team.
 */
const read = Effect.fnUntraced(function* (
  league: LeagueId,
  play: typeof PlayEntity.Type & { readonly caller?: string | undefined }
) {
  // ESPN reports down -1, with a meaningless distance, when no down is being played (after a score, at a stoppage).
  const spot = ({ down, distance, yardsToEndzone, team }: typeof play.start) => ({
    ...(down === undefined || down < 1 ? {} : { down }),
    ...(down === undefined || down < 1 || distance === undefined ? {} : { distance }),
    ...(yardsToEndzone === undefined ? {} : { yardsToEndzone }),
    ...(team === undefined ? {} : { team: EspnEvent.teamId(league, team) })
  })
  const credited = play.type.id === timeoutType ? play.caller : play.team

  const wire = {
    id: play.id,
    sequence: play.sequenceNumber,
    period: play.period.number,
    clock: play.clock.displayValue,
    text: play.text,
    type: { id: play.type.id, text: play.type.text },
    scoring: play.scoringPlay,
    homeScore: play.homeScore,
    awayScore: play.awayScore,
    ...(credited === undefined ? {} : { team: EspnEvent.teamId(league, credited) }),
    detail: {
      _tag: "Football",
      kind: kinds.get(play.type.id) ?? "other",
      yards: play.statYardage,
      start: spot(play.start),
      end: spot(play.end)
    }
  }
  return yield* decodePlay(wire).pipe(Effect.mapError(({ issue }) => issue))
})

const decodePlay = Schema.decodeUnknownEffect(Play)

const timeoutType = "21"

// Every ESPN play type id the recordings have (tallied 2026-10-07), with the kind it draws as; any other is `other`.
// After each, its text as ESPN spells it.
const kinds: ReadonlyMap<string, FootballKind> = new Map([
  ["5", "run"], // Rush
  ["68", "run"], // Rushing Touchdown
  ["16", "run"], // Two Point Rush
  ["24", "pass"], // Pass Reception
  ["4", "pass"], // Pass Completion
  ["67", "pass"], // Passing Touchdown
  ["15", "pass"], // Two Point Pass
  ["3", "incomplete"], // Pass Incompletion
  ["7", "sack"], // Sack
  ["80", "sack"], // Sack Opp Fumble Recovery
  ["53", "kick"], // Kickoff
  ["32", "kick"], // Kickoff Return Touchdown
  ["52", "kick"], // Punt
  ["14", "kick"], // Punt Return
  ["34", "kick"], // Punt Return Touchdown
  ["59", "kick"], // Field Goal Good
  ["60", "kick"], // Field Goal Missed
  ["18", "kick"], // Blocked Field Goal
  ["61", "kick"], // Extra Point Good
  ["62", "kick"], // Extra Point Missed
  ["8", "penalty"] // Penalty
])
