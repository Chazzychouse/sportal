import type { LeagueId } from "@sportal/domain/League"
import { Play, type PlayOutcome } from "@sportal/domain/Play"
import { Effect, Predicate, Schema, SchemaGetter } from "effect"
import { teamId } from "./EspnEvent.ts"
import { PlayEntity, type PlayType } from "./EspnPayload.ts"

/** ESPN's play entity, as a game package lists it under `entities.plays`, read as a `Play` of `league`. */
export function FootballPlay(league: LeagueId) {
  return PlayEntity.pipe(
    Schema.decodeTo(Schema.toType(Play), {
      decode: SchemaGetter.transformEffect((entity) =>
        read(league, {
          ...entity,
          caller: entity.participants?.find(({ type }) => type === "timeout_taker")?.team,
          homeWinProbability: entity.probabilities?.winProbability?.homeWinPercentage
        })
      ),
      encode: SchemaGetter.forbidden(() => "A Play cannot be encoded back to an ESPN play entity")
    })
  )
}

/**
 * The `Play` of `league` that an ESPN play says, as either of ESPN's feeds spells it: the case and outcome its type
 * reads as (`Other` for a type the table does not know), the fields both feeds spell alike, its teams by ESPN's own
 * ids, and its win probability. A timeout's team is its `caller`: ESPN's own `team` on one is the team with the ball.
 * It fails when its start spot has no team.
 */
const read = Effect.fnUntraced(function* (
  league: LeagueId,
  play: typeof PlayEntity.Type & {
    readonly caller?: string | undefined
    readonly homeWinProbability?: number | undefined
  }
) {
  const outcome = outcomeOf(play.type)
  // ESPN reports down -1, with a meaningless distance, when no down is being played (after a score, at a stoppage).
  const spot = ({ down, distance, yardsToEndzone, team }: typeof play.start) => ({
    ...(down === undefined || down < 1 ? {} : { down }),
    ...(down === undefined || down < 1 || distance === undefined ? {} : { distance }),
    ...(yardsToEndzone === undefined ? {} : { yardsToEndzone }),
    ...(team === undefined ? {} : { team: teamId(league, team) })
  })
  const team = (id: string | undefined) => (id === undefined ? {} : { team: teamId(league, id) })

  const shared = {
    id: play.id,
    sequence: play.sequenceNumber,
    period: play.period.number,
    clock: play.clock.displayValue,
    text: play.text,
    scoring: play.scoringPlay,
    homeScore: play.homeScore,
    awayScore: play.awayScore,
    start: spot(play.start),
    end: spot(play.end),
    ...(play.homeWinProbability === undefined ? {} : { homeWinProbability: play.homeWinProbability })
  }

  const wire = Play.gainsYards(outcome)
    ? { ...outcome, ...shared, ...team(play.team), yards: play.statYardage }
    : { ...outcome, ...shared, ...(Predicate.isTagged(outcome, "Timeout") ? team(play.caller) : {}) }

  return yield* decodeCase(wire).pipe(Effect.mapError(({ issue }) => issue))
})

const decodeCase = Schema.decodeUnknownEffect(Play)

function outcomeOf(type: PlayType): PlayOutcome {
  return byId.get(type.id) ?? { _tag: "Other", type }
}

// Every ESPN play type id the recordings have (fixtures/espn-recordings, this adapter's fixtures, and the scenario recordings
// since removed, tallied 2026-10-07), with the case and outcome it reads as and, after it, its text as ESPN spells it.
const types = {
  "5": { _tag: "Rush", touchdown: false }, // Rush
  "68": { _tag: "Rush", touchdown: true }, // Rushing Touchdown
  "24": { _tag: "Completion", touchdown: false }, // Pass Reception
  "4": { _tag: "Completion", touchdown: false }, // Pass Completion
  "67": { _tag: "Completion", touchdown: true }, // Passing Touchdown
  "3": { _tag: "Incompletion" }, // Pass Incompletion
  "63": { _tag: "Interception", return: "none" }, // Interception
  "26": { _tag: "Interception", return: "returned" }, // Pass Interception Return
  "36": { _tag: "Interception", return: "touchdown" }, // Interception Return Touchdown
  "7": { _tag: "Sack", fumbleLost: false }, // Sack
  "80": { _tag: "Sack", fumbleLost: true }, // Sack Opp Fumble Recovery
  "69": { _tag: "Fumble", recovery: "unknown" }, // Fumble
  "9": { _tag: "Fumble", recovery: "own" }, // Fumble Recovery (Own)
  "29": { _tag: "Fumble", recovery: "opponent" }, // Fumble Recovery (Opponent)
  "39": { _tag: "Fumble", recovery: "touchdown" }, // Fumble Return Touchdown
  "15": { _tag: "TwoPointTry", by: "pass" }, // Two Point Pass
  "16": { _tag: "TwoPointTry", by: "rush" }, // Two Point Rush
  "53": { _tag: "Kickoff", returnTouchdown: false }, // Kickoff
  "32": { _tag: "Kickoff", returnTouchdown: true }, // Kickoff Return Touchdown
  "52": { _tag: "Punt", return: "none" }, // Punt
  "14": { _tag: "Punt", return: "returned" }, // Punt Return
  "34": { _tag: "Punt", return: "touchdown" }, // Punt Return Touchdown
  "59": { _tag: "FieldGoal", result: "good" }, // Field Goal Good
  "60": { _tag: "FieldGoal", result: "missed" }, // Field Goal Missed
  "18": { _tag: "FieldGoal", result: "blocked" }, // Blocked Field Goal
  "61": { _tag: "ExtraPoint", good: true }, // Extra Point Good
  "62": { _tag: "ExtraPoint", good: false }, // Extra Point Missed
  "20": { _tag: "Safety" }, // Safety
  "8": { _tag: "Penalty" }, // Penalty
  "21": { _tag: "Timeout" }, // Timeout
  "74": { _tag: "Stoppage", kind: "officialTimeout" }, // Official Timeout
  "75": { _tag: "Stoppage", kind: "twoMinuteWarning" }, // Two-minute warning
  "70": { _tag: "Stoppage", kind: "coinToss" }, // Coin Toss
  "2": { _tag: "PeriodEnd", ends: "period" }, // End Period
  "65": { _tag: "PeriodEnd", ends: "half" }, // End of Half
  "79": { _tag: "PeriodEnd", ends: "regulation" }, // End of Regulation
  "66": { _tag: "PeriodEnd", ends: "game" } // End of Game
} as const satisfies Readonly<Record<string, Exclude<PlayOutcome, { readonly _tag: "Other" }>>>

const byId: ReadonlyMap<string, PlayOutcome> = new Map(Object.entries(types))
