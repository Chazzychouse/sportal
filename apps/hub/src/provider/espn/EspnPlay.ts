import type { LeagueId } from "@sportal/domain/League"
import { FootballPlay, type PlayOutcome } from "@sportal/domain/Play"
import { Array as Arr, Effect, Option, Schema, SchemaGetter, type SchemaIssue } from "effect"
import { teamId } from "./EspnEvent.ts"

/** ESPN's play entity, as a game package lists it under `entities.plays`, read as a `Play` of `league`. */
export function Play(league: LeagueId) {
  return Entity.pipe(
    Schema.decodeTo(Schema.toType(FootballPlay), {
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
export function read(
  league: LeagueId,
  play: typeof Alike.Type & {
    readonly team?: string | undefined
    readonly caller?: string | undefined
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

  const wire = FootballPlay.gainsYards(outcome)
    ? { ...outcome, ...shared, ...team(play.team), yards: play.statYardage }
    : { ...outcome, ...shared, ...(outcome._tag === "Timeout" ? team(play.caller) : {}) }

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
      Option.toArray(decodeType(entity)).flatMap(({ type }) => (byId.has(type.id) ? [] : [type]))
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
  participants: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String), team: Schema.optional(Key) }))
  ),
  probabilities: Schema.optional(
    Schema.Struct({
      winProbability: Schema.optional(Schema.Struct({ homeWinPercentage: Schema.Finite }))
    })
  )
})

// What `read` takes of either feed's play, its teams read to ESPN's ids.
const Alike = Schema.Struct(fields(Schema.String))

/**
 * The ESPN play type that reads as `play`'s case and outcome, as ESPN names it; an `Other` keeps its own. Each case and
 * outcome names its type's id, which the compiler checks is in the table.
 */
export function typeOf(play: FootballPlay): typeof PlayType.Type {
  return FootballPlay.match(play, {
    Rush: ({ touchdown }) => written(touchdown ? "68" : "5"),
    Completion: ({ touchdown }) => written(touchdown ? "67" : "24"),
    Incompletion: () => written("3"),
    Interception: (interception) =>
      written(({ none: "63", returned: "26", touchdown: "36" } as const)[interception.return]),
    Sack: ({ fumbleLost }) => written(fumbleLost ? "80" : "7"),
    Fumble: ({ recovery }) =>
      written(({ unknown: "69", own: "9", opponent: "29", touchdown: "39" } as const)[recovery]),
    TwoPointTry: ({ by }) => written(by === "pass" ? "15" : "16"),
    Kickoff: ({ returnTouchdown }) => written(returnTouchdown ? "32" : "53"),
    Punt: (punt) => written(({ none: "52", returned: "14", touchdown: "34" } as const)[punt.return]),
    FieldGoal: ({ result }) => written(({ good: "59", missed: "60", blocked: "18" } as const)[result]),
    ExtraPoint: ({ good }) => written(good ? "61" : "62"),
    Safety: () => written("20"),
    Penalty: () => written("8"),
    Timeout: () => written("21"),
    Stoppage: ({ kind }) =>
      written(({ officialTimeout: "74", twoMinuteWarning: "75", coinToss: "70" } as const)[kind]),
    PeriodEnd: ({ ends }) =>
      written(({ period: "2", half: "65", regulation: "79", game: "66" } as const)[ends]),
    Other: (other) => other.type
  })
}

// The table's type `id`, as `typeOf` writes it.
function written(id: keyof typeof types): typeof PlayType.Type {
  return { id, text: types[id].text }
}

const decodeType = Schema.decodeUnknownOption(Schema.Struct({ type: PlayType }))
const decodeCase = Schema.decodeUnknownEffect(FootballPlay)

function outcomeOf(type: typeof PlayType.Type): PlayOutcome {
  return byId.get(type.id) ?? { _tag: "Other", type }
}

// Every ESPN play type id the recordings have (fixtures/espn-recordings, this adapter's fixtures, and the recorded
// scenarios, tallied 2026-10-07), with its text as ESPN spells it and the case and outcome it reads as.
const types = {
  "5": { text: "Rush", play: { _tag: "Rush", touchdown: false } },
  "68": { text: "Rushing Touchdown", play: { _tag: "Rush", touchdown: true } },
  "24": { text: "Pass Reception", play: { _tag: "Completion", touchdown: false } },
  "4": { text: "Pass Completion", play: { _tag: "Completion", touchdown: false } },
  "67": { text: "Passing Touchdown", play: { _tag: "Completion", touchdown: true } },
  "3": { text: "Pass Incompletion", play: { _tag: "Incompletion" } },
  "63": { text: "Interception", play: { _tag: "Interception", return: "none" } },
  "26": { text: "Pass Interception Return", play: { _tag: "Interception", return: "returned" } },
  "36": { text: "Interception Return Touchdown", play: { _tag: "Interception", return: "touchdown" } },
  "7": { text: "Sack", play: { _tag: "Sack", fumbleLost: false } },
  "80": { text: "Sack Opp Fumble Recovery", play: { _tag: "Sack", fumbleLost: true } },
  "69": { text: "Fumble", play: { _tag: "Fumble", recovery: "unknown" } },
  "9": { text: "Fumble Recovery (Own)", play: { _tag: "Fumble", recovery: "own" } },
  "29": { text: "Fumble Recovery (Opponent)", play: { _tag: "Fumble", recovery: "opponent" } },
  "39": { text: "Fumble Return Touchdown", play: { _tag: "Fumble", recovery: "touchdown" } },
  "15": { text: "Two Point Pass", play: { _tag: "TwoPointTry", by: "pass" } },
  "16": { text: "Two Point Rush", play: { _tag: "TwoPointTry", by: "rush" } },
  "53": { text: "Kickoff", play: { _tag: "Kickoff", returnTouchdown: false } },
  "32": { text: "Kickoff Return Touchdown", play: { _tag: "Kickoff", returnTouchdown: true } },
  "52": { text: "Punt", play: { _tag: "Punt", return: "none" } },
  "14": { text: "Punt Return", play: { _tag: "Punt", return: "returned" } },
  "34": { text: "Punt Return Touchdown", play: { _tag: "Punt", return: "touchdown" } },
  "59": { text: "Field Goal Good", play: { _tag: "FieldGoal", result: "good" } },
  "60": { text: "Field Goal Missed", play: { _tag: "FieldGoal", result: "missed" } },
  "18": { text: "Blocked Field Goal", play: { _tag: "FieldGoal", result: "blocked" } },
  "61": { text: "Extra Point Good", play: { _tag: "ExtraPoint", good: true } },
  "62": { text: "Extra Point Missed", play: { _tag: "ExtraPoint", good: false } },
  "20": { text: "Safety", play: { _tag: "Safety" } },
  "8": { text: "Penalty", play: { _tag: "Penalty" } },
  "21": { text: "Timeout", play: { _tag: "Timeout" } },
  "74": { text: "Official Timeout", play: { _tag: "Stoppage", kind: "officialTimeout" } },
  "75": { text: "Two-minute warning", play: { _tag: "Stoppage", kind: "twoMinuteWarning" } },
  "70": { text: "Coin Toss", play: { _tag: "Stoppage", kind: "coinToss" } },
  "2": { text: "End Period", play: { _tag: "PeriodEnd", ends: "period" } },
  "65": { text: "End of Half", play: { _tag: "PeriodEnd", ends: "half" } },
  "79": { text: "End of Regulation", play: { _tag: "PeriodEnd", ends: "regulation" } },
  "66": { text: "End of Game", play: { _tag: "PeriodEnd", ends: "game" } }
} as const satisfies Readonly<
  Record<string, { readonly text: string; readonly play: Exclude<PlayOutcome, { readonly _tag: "Other" }> }>
>

const byId: ReadonlyMap<string, PlayOutcome> = new Map(
  Object.entries(types).map(([id, { play }]) => [id, play])
)
