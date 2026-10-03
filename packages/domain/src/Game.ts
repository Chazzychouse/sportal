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

/** The fact that a network is airing a game, on television or streaming only. */
export const Broadcast = Schema.Struct({ network: Network, medium: Schema.Literals(["tv", "streaming"]) })
export type Broadcast = typeof Broadcast.Type

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
  broadcasts: Schema.Array(Broadcast),
  situation: Schema.optional(Situation)
}) {
  /** Live games first, then upcoming by kickoff, then everything that is over. */
  static readonly watchOrder: Order.Order<GameSnapshot> = Order.combine(
    Order.mapInput(Order.Number, (game: GameSnapshot) => progressRank[game.progress()]),
    Order.mapInput(DateTime.Order, (game: GameSnapshot) => game.kickoff)
  )

  isLive(): boolean {
    return this.status === "live" || this.status === "halftime"
  }

  /** Where the game is in its day: not started (or delayed), being played, or done with (final, postponed, canceled). */
  progress(): "upcoming" | "live" | "over" {
    switch (this.status) {
      case "scheduled":
      case "delayed":
        return "upcoming"
      case "live":
      case "halftime":
        return "live"
      case "final":
      case "postponed":
      case "canceled":
        return "over"
    }
  }
}

const progressRank = { live: 0, upcoming: 1, over: 2 } as const
