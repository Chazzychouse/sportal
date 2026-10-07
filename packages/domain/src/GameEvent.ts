import { Data, type DateTime } from "effect"
import type { GameId } from "./Game.ts"
import type { Play } from "./Play.ts"
import type { TeamId } from "./Team.ts"

/**
 * What happened in a game: from its plays when it has them (`Play.eventsSince`), from comparing two snapshots otherwise
 * (`GameSnapshot#eventsSince`). Derived, never stored as truth. `team` is the team that scored, has the ball, gained it,
 * or called the timeout.
 */
export type GameEventKind = Data.TaggedEnum<{
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
export const GameEventKind = Data.taggedEnum<GameEventKind>()

/** Something that happened in a game, stamped with the game and the instant it was told. Compared structurally. */
export class GameEvent extends Data.Class<{
  readonly game: GameId
  readonly at: DateTime.Utc
  readonly what: GameEventKind
}> {}
