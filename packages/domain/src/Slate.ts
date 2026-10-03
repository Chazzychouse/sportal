import { DateTime, Order } from "effect"
import { type GameSnapshot, isLive } from "./Game.ts"

/** Live games first, then upcoming by kickoff, then everything that is over. */
export function inWatchOrder(slate: ReadonlyArray<GameSnapshot>): ReadonlyArray<GameSnapshot> {
  return [...slate].sort(Order.combine(byPhase, byKickoff))
}

const byPhase = Order.mapInput(Order.Number, (game: GameSnapshot) =>
  isLive(game) ? 0 : game.status === "scheduled" || game.status === "delayed" ? 1 : 2
)

const byKickoff = Order.mapInput(DateTime.Order, (game: GameSnapshot) => game.kickoff)
