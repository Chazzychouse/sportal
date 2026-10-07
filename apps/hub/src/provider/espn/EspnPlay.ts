import type { LeagueId } from "@sportal/domain/League"
import { FootballPlay, type Penalty } from "@sportal/domain/Play"
import { Array as Arr, Effect, Option, Schema, SchemaGetter, type SchemaIssue } from "effect"
import { teamId } from "./EspnEvent.ts"

/** ESPN's play entity, as a game package lists it under `entities.plays`, read as a `Play` of `league`. */
export function Play(league: LeagueId) {
  return Entity.pipe(
    Schema.decodeTo(Schema.toType(FootballPlay), {
      decode: SchemaGetter.transformEffect((entity) =>
        read(league, {
          ...entity,
          homeWinProbability: entity.probabilities?.winProbability?.homeWinPercentage
        })
      ),
      encode: SchemaGetter.forbidden(() => "A Play cannot be encoded back to an ESPN play entity")
    })
  )
}

/**
 * The `Play` of `league` that an ESPN play says, as either of ESPN's feeds spells it: the case and outcome its type
 * reads as (`Other` for a type the table does not know), the fields both feeds spell alike, its teams by ESPN's own ids,
 * and its win probability. It fails when its start spot has no team. A timeout's caller is not read: ESPN's `team` on one
 * is the team with the ball.
 */
export function read(
  league: LeagueId,
  play: typeof Alike.Type & {
    readonly team?: string | undefined
    readonly homeWinProbability?: number | undefined
  }
): Effect.Effect<FootballPlay, SchemaIssue.Issue> {
  const outcome = outcomeOf(play.type)
  // ESPN reports down -1, with a meaningless distance, when no down is being played (after a score, at a stoppage).
  const spot = ({ down, distance, yardsToEndzone, team }: typeof Alike.Type.start) => ({
    ...(down === undefined || down < 1 ? {} : { down }),
    ...(down === undefined || down < 1 || distance === undefined ? {} : { distance }),
    ...(yardsToEndzone === undefined ? {} : { yardsToEndzone }),
    ...(team === undefined ? {} : { team: teamId(league, team) })
  })
  const gained = {
    ...(play.team === undefined ? {} : { team: teamId(league, play.team) }),
    yards: play.statYardage
  }

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

  // A snap, a kick, a safety, or a penalty gains yards for a team; a timeout's team is its caller, not ESPN's `team`.
  const wire =
    "yards" in FootballPlay.cases[outcome._tag].fields
      ? { ...outcome, ...shared, ...gained }
      : { ...outcome, ...shared }

  return decodeCase(wire).pipe(Effect.mapError(({ issue }) => issue))
}

/**
 * The fields of a play that both of ESPN's feeds spell alike, a spot's team read by `team`: FastCast's entity refers to
 * a team by `$key`, a game summary's play by `id`.
 */
export function fields<Team extends Schema.Top>(team: Team) {
  const spot = Schema.Struct({
    team: Schema.optional(team),
    down: Schema.optional(Schema.Int),
    distance: Schema.optional(Schema.Int),
    yardsToEndzone: Schema.optional(Schema.Int)
  })
  return {
    id: Schema.String,
    sequenceNumber: Schema.FiniteFromString.check(Schema.isInt()),
    type: PlayType,
    text: Schema.String,
    period: Schema.Struct({ number: Schema.Int }),
    clock: Schema.Struct({ displayValue: Schema.String }),
    statYardage: Schema.Int,
    scoringPlay: Schema.Boolean,
    homeScore: Schema.Int,
    awayScore: Schema.Int,
    start: spot,
    end: spot
  }
}

/** The types of `entities` that the table does not know, each once. */
export function unknownTypes(
  entities: ReadonlyArray<unknown>
): ReadonlyArray<{ readonly id: string; readonly text: string }> {
  return Arr.dedupeWith(
    entities.flatMap((entity) =>
      Option.toArray(decodeType(entity)).flatMap(({ type }) =>
        types.some((row) => row.id === type.id) ? [] : [type]
      )
    ),
    (a, b) => a.id === b.id
  )
}

const PlayType = Schema.Struct({ id: Schema.String, text: Schema.String })

// FastCast refers to a team by its `$key`, ESPN's id for it.
const Key = Schema.Struct({ $key: Schema.String }).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform(({ $key }) => $key),
    encode: SchemaGetter.transform(($key) => ({ $key }))
  })
)

/** ESPN's play entity as a game package lists it: what `Play` reads of it. */
export const Entity = Schema.Struct({
  ...fields(Key),
  team: Schema.optional(Key),
  probabilities: Schema.optional(
    Schema.Struct({
      winProbability: Schema.optional(Schema.Struct({ homeWinPercentage: Schema.Finite }))
    })
  )
})

// What `read` takes of either feed's play, its teams read to ESPN's ids.
const Alike = Schema.Struct(fields(Schema.String))

/** The ESPN play type that reads as `play`'s case and outcome, as ESPN names it; an `Other` keeps its own. */
export function typeOf(play: FootballPlay): typeof PlayType.Type {
  if (FootballPlay.guards.Other(play)) return play.type
  const row = types.find(
    (candidate) =>
      candidate.play._tag === play._tag &&
      Object.entries(candidate.play).every(([field, value]) => Reflect.get(play, field) === value)
  )
  if (row === undefined) throw new Error(`EspnPlay: no ESPN play type reads as ${play._tag}`)
  return { id: row.id, text: row.text }
}

const decodeType = Schema.decodeUnknownOption(Schema.Struct({ type: PlayType }))
const decodeCase = Schema.decodeUnknownEffect(FootballPlay)

// A case's tag and the fields that say its outcome: what an ESPN play type says of a play.
type Outcome = FootballPlay extends infer Case
  ? Case extends { readonly _tag: Exclude<FootballPlay["_tag"], "Other"> }
    ? Pick<Case, "_tag"> & Omit<Case, keyof Penalty>
    : never
  : never

function outcomeOf(
  type: typeof PlayType.Type
): Outcome | { readonly _tag: "Other"; readonly type: typeof PlayType.Type } {
  return types.find((row) => row.id === type.id)?.play ?? { _tag: "Other", type }
}

// Every ESPN play type id the recordings have (fixtures/espn-recordings, this adapter's fixtures, and the recorded
// scenarios, tallied 2026-10-07), its text as ESPN spells it, and the case and outcome it reads as. Where two ids read
// alike, `typeOf` writes the first.
const types: ReadonlyArray<{ readonly id: string; readonly text: string; readonly play: Outcome }> = [
  { id: "5", text: "Rush", play: { _tag: "Rush", touchdown: false } },
  { id: "68", text: "Rushing Touchdown", play: { _tag: "Rush", touchdown: true } },
  { id: "24", text: "Pass Reception", play: { _tag: "Completion", touchdown: false } },
  { id: "4", text: "Pass Completion", play: { _tag: "Completion", touchdown: false } },
  { id: "67", text: "Passing Touchdown", play: { _tag: "Completion", touchdown: true } },
  { id: "3", text: "Pass Incompletion", play: { _tag: "Incompletion" } },
  { id: "63", text: "Interception", play: { _tag: "Interception", return: "none" } },
  { id: "26", text: "Pass Interception Return", play: { _tag: "Interception", return: "returned" } },
  { id: "36", text: "Interception Return Touchdown", play: { _tag: "Interception", return: "touchdown" } },
  { id: "7", text: "Sack", play: { _tag: "Sack", fumbleLost: false } },
  { id: "80", text: "Sack Opp Fumble Recovery", play: { _tag: "Sack", fumbleLost: true } },
  { id: "69", text: "Fumble", play: { _tag: "Fumble", recovery: "unknown" } },
  { id: "9", text: "Fumble Recovery (Own)", play: { _tag: "Fumble", recovery: "own" } },
  { id: "29", text: "Fumble Recovery (Opponent)", play: { _tag: "Fumble", recovery: "opponent" } },
  { id: "39", text: "Fumble Return Touchdown", play: { _tag: "Fumble", recovery: "touchdown" } },
  { id: "15", text: "Two Point Pass", play: { _tag: "TwoPointTry", by: "pass" } },
  { id: "16", text: "Two Point Rush", play: { _tag: "TwoPointTry", by: "rush" } },
  { id: "53", text: "Kickoff", play: { _tag: "Kickoff", returnTouchdown: false } },
  { id: "32", text: "Kickoff Return Touchdown", play: { _tag: "Kickoff", returnTouchdown: true } },
  { id: "52", text: "Punt", play: { _tag: "Punt", return: "none" } },
  { id: "14", text: "Punt Return", play: { _tag: "Punt", return: "returned" } },
  { id: "34", text: "Punt Return Touchdown", play: { _tag: "Punt", return: "touchdown" } },
  { id: "59", text: "Field Goal Good", play: { _tag: "FieldGoal", result: "good" } },
  { id: "60", text: "Field Goal Missed", play: { _tag: "FieldGoal", result: "missed" } },
  { id: "18", text: "Blocked Field Goal", play: { _tag: "FieldGoal", result: "blocked" } },
  { id: "61", text: "Extra Point Good", play: { _tag: "ExtraPoint", good: true } },
  { id: "62", text: "Extra Point Missed", play: { _tag: "ExtraPoint", good: false } },
  { id: "20", text: "Safety", play: { _tag: "Safety" } },
  { id: "8", text: "Penalty", play: { _tag: "Penalty" } },
  { id: "21", text: "Timeout", play: { _tag: "Timeout" } },
  { id: "74", text: "Official Timeout", play: { _tag: "Stoppage", kind: "officialTimeout" } },
  { id: "75", text: "Two-minute warning", play: { _tag: "Stoppage", kind: "twoMinuteWarning" } },
  { id: "70", text: "Coin Toss", play: { _tag: "Stoppage", kind: "coinToss" } },
  { id: "2", text: "End Period", play: { _tag: "PeriodEnd", ends: "period" } },
  { id: "65", text: "End of Half", play: { _tag: "PeriodEnd", ends: "half" } },
  { id: "79", text: "End of Regulation", play: { _tag: "PeriodEnd", ends: "regulation" } },
  { id: "66", text: "End of Game", play: { _tag: "PeriodEnd", ends: "game" } }
]
