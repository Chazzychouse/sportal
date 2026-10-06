import { Data } from "effect"
import type { Play } from "./Play.ts"
import type { TeamId } from "./Team.ts"

/**
 * Something that happened in a game: from its plays when it has them (`Play.eventsSince`), from comparing two
 * snapshots otherwise (`GameSnapshot#eventsSince`). Derived, never stored as truth. `team` is the team that scored, has
 * the ball, gained it, or called the timeout.
 */
export type GameEvent = Data.TaggedEnum<{
  ScoreChanged: { readonly team: TeamId; readonly points: number }
  EnteredRedZone: { readonly team: TeamId }
  ReachedScoringRange: { readonly team: TeamId }
  GoalToGo: { readonly team: TeamId }
  FourthDown: { readonly team: TeamId }
  TwoMinuteDrill: object
  Overtime: object
  Turnover: { readonly team: TeamId }
  PossessionChanged: { readonly team: TeamId }
  TimeoutTaken: { readonly team: TeamId }
  PeriodEnded: { readonly period: number }
  WentToHalftime: object
  WentFinal: object
  Played: { readonly play: Play }
  /** A run or completed pass of 20 or more yards. */
  BigPlay: { readonly team: TeamId; readonly yards: number }
  Sack: { readonly team: TeamId }
}>
const constructors = Data.taggedEnum<GameEvent>()
export const GameEvent = {
  ScoreChanged: constructors.ScoreChanged,
  EnteredRedZone: constructors.EnteredRedZone,
  ReachedScoringRange: constructors.ReachedScoringRange,
  GoalToGo: constructors.GoalToGo,
  FourthDown: constructors.FourthDown,
  TwoMinuteDrill: constructors.TwoMinuteDrill,
  Overtime: constructors.Overtime,
  Turnover: constructors.Turnover,
  PossessionChanged: constructors.PossessionChanged,
  TimeoutTaken: constructors.TimeoutTaken,
  PeriodEnded: constructors.PeriodEnded,
  WentToHalftime: constructors.WentToHalftime,
  WentFinal: constructors.WentFinal,
  Played: constructors.Played,
  BigPlay: constructors.BigPlay,
  Sack: constructors.Sack,
  $is: constructors.$is,
  $match: constructors.$match,
  /** The tags a game's plays decide once it has any; its snapshots decide them only before. */
  fromPlays: new Set<GameEvent["_tag"]>([
    "ScoreChanged",
    "Turnover",
    "PossessionChanged",
    "TimeoutTaken",
    "PeriodEnded",
    "FourthDown",
    "Played",
    "BigPlay",
    "Sack"
  ])
}
