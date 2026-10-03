import { DateTime, Order, Schema } from "effect"
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

/** A network's name as the provider reports it ("CBS", "ESPN"). */
export const Network = Schema.String.pipe(Schema.brand("Network"))
export type Network = typeof Network.Type

const Side = Schema.Struct({ team: Team, score: Schema.Int, ranking: Schema.optional(Schema.Int) })

export class GameSnapshot extends Schema.Class<GameSnapshot>("sportal/GameSnapshot")({
  id: GameId,
  league: LeagueId,
  kickoff: Schema.DateTimeUtcFromString,
  status: GameStatus,
  period: Schema.Int,
  clock: Schema.String,
  home: Side,
  away: Side,
  broadcasts: Schema.Array(Network),
  situation: Schema.optional(Situation)
}) {
  /** Live games first, then upcoming by kickoff, then everything that is over. */
  static readonly watchOrder: Order.Order<GameSnapshot> = Order.combine(
    Order.mapInput(Order.Number, (game: GameSnapshot) =>
      game.isLive() ? 0 : game.status === "scheduled" || game.status === "delayed" ? 1 : 2
    ),
    Order.mapInput(DateTime.Order, (game: GameSnapshot) => game.kickoff)
  )

  isLive(): boolean {
    return this.status === "live" || this.status === "halftime"
  }
}
