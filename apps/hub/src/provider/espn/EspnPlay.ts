import type { LeagueId } from "@sportal/domain/League"
import { Play as DomainPlay, PlayId, type PlayKind } from "@sportal/domain/Play"
import { TeamId } from "@sportal/domain/Team"
import { Array as Arr, Option, Record, Schema, SchemaGetter } from "effect"

/** ESPN's play entity, as a game package lists it under `entities.plays`, read as a `Play` of `league`. */
export function Play(league: LeagueId) {
  return Entity.pipe(
    Schema.decodeTo(Schema.toType(DomainPlay), {
      decode: SchemaGetter.transform((entity) => {
        const team = (ref: typeof TeamRef.Type | undefined) =>
          ref === undefined ? {} : { team: TeamId.make(`${league}:${ref.$key}`) }
        // ESPN reports down -1, with a meaningless distance, when no down is being played (after a score, at a
        // stoppage).
        const spot = ({ down, distance, yardsToEndzone, team: ref }: typeof Spot.Type) => ({
          ...(down === undefined || down < 1 ? {} : { down }),
          ...(down === undefined || down < 1 || distance === undefined ? {} : { distance }),
          ...(yardsToEndzone === undefined ? {} : { yardsToEndzone }),
          ...team(ref)
        })
        const homeWinProbability = entity.probabilities?.winProbability?.homeWinPercentage
        return new DomainPlay({
          id: PlayId.make(entity.id),
          sequence: entity.sequenceNumber,
          period: entity.period.number,
          clock: entity.clock.displayValue,
          ...team(entity.team),
          kind: Option.getOrElse(Record.get(kinds, entity.type.id), (): PlayKind => "other"),
          text: entity.text,
          yards: entity.statYardage,
          scoring: entity.scoringPlay,
          homeScore: entity.homeScore,
          awayScore: entity.awayScore,
          start: spot(entity.start),
          end: spot(entity.end),
          ...(homeWinProbability === undefined ? {} : { homeWinProbability })
        })
      }),
      encode: SchemaGetter.forbidden(() => "A Play cannot be encoded back to an ESPN play entity")
    })
  )
}

/** The types of `entities` that the `PlayKind` table does not know, each once. */
export function unknownTypes(
  entities: ReadonlyArray<unknown>
): ReadonlyArray<{ readonly id: string; readonly text: string }> {
  return Arr.dedupeWith(
    entities.flatMap((entity) =>
      Option.toArray(decodeType(entity)).flatMap(({ type }) => (Record.has(kinds, type.id) ? [] : [type]))
    ),
    (a, b) => a.id === b.id
  )
}

const TeamRef = Schema.Struct({ $key: Schema.String })

const Spot = Schema.Struct({
  team: Schema.optional(TeamRef),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardsToEndzone: Schema.optional(Schema.Int)
})

const PlayType = Schema.Struct({ id: Schema.String, text: Schema.String })

/** ESPN's play entity as a game package lists it: what `Play` reads of it. */
export const Entity = Schema.Struct({
  id: Schema.String,
  sequenceNumber: Schema.FiniteFromString.check(Schema.isInt()),
  type: PlayType,
  text: Schema.String,
  period: Schema.Struct({ number: Schema.Int }),
  clock: Schema.Struct({ displayValue: Schema.String }),
  team: Schema.optional(TeamRef),
  statYardage: Schema.Int,
  scoringPlay: Schema.Boolean,
  homeScore: Schema.Int,
  awayScore: Schema.Int,
  start: Spot,
  end: Spot,
  probabilities: Schema.optional(
    Schema.Struct({
      winProbability: Schema.optional(Schema.Struct({ homeWinPercentage: Schema.Finite }))
    })
  )
})

/** The ESPN play type that reads as `kind`: its plain one, as ESPN names it. */
export function typeOf(kind: PlayKind): typeof PlayType.Type {
  return types[kind]
}

const decodeType = Schema.decodeUnknownOption(Schema.Struct({ type: PlayType }))

// ESPN's play type ids, each with its slug, as the 2026-10-04 NFL recording lists them under `/entities/plays`; the tries
// as the recorded scoreboards name a last play's; and, by their text, the college types the 2026-10-03 FBS game summaries
// list.
const kinds: Readonly<Record<string, PlayKind>> = {
  "2": "endPeriod", // end-period
  "3": "incompletion", // pass-incompletion
  "5": "rush", // rush
  "7": "sack", // sack
  "8": "penalty", // penalty
  "9": "fumble", // fumble-recovery-own
  "14": "punt", // Punt Return
  "15": "twoPoint", // two-point-pass
  "16": "twoPoint", // two-point-rush
  "18": "fieldGoal", // blocked-field-goal
  "21": "timeout", // timeout
  "24": "pass", // pass-reception
  "26": "interception", // pass-interception-return
  "29": "fumbleLost", // fumble-recovery-opponent
  "32": "kickoff", // Kickoff Return Touchdown
  "36": "interception", // interception-return-touchdown
  "52": "punt", // punt
  "53": "kickoff", // kickoff
  "59": "fieldGoal", // field-goal-good
  "60": "fieldGoal", // field-goal-missed
  "61": "extraPoint", // extra-point-good
  "63": "interception", // Interception
  "65": "endPeriod", // end-of-half
  "66": "endPeriod", // end-of-game
  "67": "pass", // passing-touchdown
  "68": "rush", // rushing-touchdown
  "69": "fumble", // Fumble
  // Stoppages no team called: as `timeout`, the team with the ball would read as having taken one.
  "74": "other", // official-timeout
  "75": "other", // two-minute-warning
  "79": "endPeriod", // End of Regulation
  "80": "fumbleLost" // sack-opp-fumble-recovery
}

// The type `typeOf` writes for each kind, as ESPN's recordings name it; `kinds` reads each back as its kind.
const types: Readonly<Record<PlayKind, typeof PlayType.Type>> = {
  rush: { id: "5", text: "Rush" },
  pass: { id: "24", text: "Pass Reception" },
  incompletion: { id: "3", text: "Pass Incompletion" },
  sack: { id: "7", text: "Sack" },
  interception: { id: "26", text: "Pass Interception Return" },
  fumble: { id: "9", text: "Fumble Recovery (Own)" },
  fumbleLost: { id: "29", text: "Fumble Recovery (Opponent)" },
  punt: { id: "52", text: "Punt" },
  kickoff: { id: "53", text: "Kickoff" },
  fieldGoal: { id: "59", text: "Field Goal Good" },
  extraPoint: { id: "61", text: "Extra Point Good" },
  twoPoint: { id: "16", text: "Two Point Rush" },
  penalty: { id: "8", text: "Penalty" },
  timeout: { id: "21", text: "Timeout" },
  endPeriod: { id: "2", text: "End Period" },
  other: { id: "74", text: "Official Timeout" }
}
