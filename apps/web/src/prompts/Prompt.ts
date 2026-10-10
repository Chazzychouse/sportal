import type { GameId } from "@sportal/domain/Game"
import { Data, type DateTime, Option } from "effect"
import { label, type Rank } from "../autopilot/Ranking.ts"
import type { ScreenCommand } from "../screen/Screen.ts"

/**
 * A suggestion to bring `game`, on no tile, into the main tile: in `rank` (a red zone or crunch time) since `since`,
 * by way of the `target` slot, which `replaces` holds, or none when it is empty.
 */
export class Prompt extends Data.Class<{
  readonly game: GameId
  readonly rank: Rank
  readonly since: DateTime.Utc
  readonly target: number
  readonly replaces: Option.Option<{ readonly game: GameId; readonly rank: Rank }>
}> {
  /** What accepting it sends: the game into the target slot, then promoted into the main tile with the sound. */
  commands(): ReadonlyArray<ScreenCommand> {
    return [
      { _tag: "Assign", tile: this.target, game: this.game },
      { _tag: "Promote", tile: this.target }
    ]
  }

  /** It in words, each game named by `nameOf`: `PHI @ DAL — red zone, replaces CHI @ GB (on a break)`. */
  words(nameOf: (game: GameId) => string): string {
    const into = Option.match(this.replaces, {
      onNone: () => "into an empty tile",
      onSome: ({ game, rank }) => `replaces ${nameOf(game)} (${label(rank)})`
    })
    return `${nameOf(this.game)} — ${label(this.rank)}, ${into}`
  }
}
