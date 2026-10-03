import { Schema } from "effect"
import { LeagueId } from "./League.ts"
import { Situation } from "./Situation.ts"
import { Team } from "./Team.ts"

export const GameId = Schema.String.pipe(Schema.brand("GameId"))
export type GameId = typeof GameId.Type

export const GameStatus = Schema.Literals([
  "scheduled",
  "live",
  "halftime",
  "delayed",
  "final",
  "postponed",
  "canceled"
])
export type GameStatus = typeof GameStatus.Type

export class GameSnapshot extends Schema.Class<GameSnapshot>("sportal/GameSnapshot")({
  id: GameId,
  league: LeagueId,
  kickoff: Schema.DateTimeUtcFromString,
  status: GameStatus,
  period: Schema.Int,
  clock: Schema.String,
  home: Schema.Struct({ team: Team, score: Schema.Int, ranking: Schema.optional(Schema.Int) }),
  away: Schema.Struct({ team: Team, score: Schema.Int, ranking: Schema.optional(Schema.Int) }),
  broadcasts: Schema.Array(Schema.String),
  situation: Schema.optional(Situation)
}) {}

export function isLive(game: GameSnapshot): boolean {
  return game.status === "live" || game.status === "halftime"
}
