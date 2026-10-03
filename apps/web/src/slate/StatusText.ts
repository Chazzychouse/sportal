import type { GameSnapshot } from "@sportal/domain/Game"
import { localTime } from "../LocalTime.ts"

/** A game's status as a slate row or a tile shows it: the quarter and clock, the kickoff, or the status. */
export function statusText(game: GameSnapshot): string {
  switch (game.status) {
    case "live":
      return `Q${game.period} ${game.clock}`
    case "scheduled":
      return localTime(game.kickoff)
    default:
      return game.status
  }
}
