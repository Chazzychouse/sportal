import { Data } from "effect"
import type { TeamId } from "./Team.ts"

/**
 * Something that happened in a game between two snapshots of it (the game is the snapshot's), derived by `GameSnapshot#eventsSince` and never
 * stored as truth. `team` is the team that scored, has the ball, gained it, or called the timeout.
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
}>
export const GameEvent = Data.taggedEnum<GameEvent>()
